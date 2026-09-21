/**
 * DshClient — the extension's single connection to one dsh host.
 *
 * MIGRATION NOTE: this file previously spoke the `apiproxy` protocol
 * (`POST /api/<dot.method>`, `POST /api/respond`, `WS /api/events.mux` +
 * `/api/events.host`). That protocol no longer exists: from
 * `dsh-web-app@0.1.2-rc.1` the bundle mounts only
 * `@deepseek-ai/dsh-api-gateway` (Typert Remote), and `dsh-host-apiproxy`'s last
 * publish was `0.1.1-rc.2`. Every old route answers 404 on 0.1.5-rc.2.
 *
 * The new shape uses two channels:
 *   - unary:   `POST /api/<namespace>/<method>` with an `{args}` envelope
 *   - streams: one multiplexed WebSocket `/api/remote.mux`
 *   - events:  a `$events` logical stream, answered by unary `$events/result`
 *
 * Three behaviours were replaced outright rather than renamed:
 *   - `POST /api/respond` is gone. Approvals and ask-user questions arrive as
 *     `$events` waterfall frames and are answered on `$events/result`, keyed by
 *     the frame's `eventId` (never an `approvalId` or an rpcId).
 *   - `WS /api/events.mux` is gone. Session state now arrives as three streams:
 *     `session/control` (Host-wide queues/jobs/projections), `session/follow`
 *     (one session's journal), and `workspace/follow` (workspace set and order).
 *     There is no longer a per-frame session fan-out to demultiplex, and no
 *     separate host socket.
 *   - `host.describe` is gone with no replacement, so this client no longer
 *     reports a host version at all (see HostManager for the capability probe).
 *
 * Streams are GENERATION-SCOPED: every (re)open begins with a baseline frame
 * (`snapshot` / `baseline` / `ready`). A carrier loss therefore needs no replay
 * or diffing — consumers discard prior state and re-apply the new baseline.
 *
 * Pure Node (global fetch/WebSocket, Node >= 22); no vscode runtime import, so
 * the module stays unit-testable under node:test.
 */

import * as crypto from 'node:crypto'
import type { HostInfo } from './host-manager'
import type { RequestPayload, ResponseValue, RpcMethod } from './protocol/rpc-map'
import type { SessionAddress, SessionControlFrame, SessionFollowFrame } from './protocol/follow'
import type { WorkspaceFollowFrame } from './protocol/workspace'
import type { ApprovalOutcome, AskUserQuestionAnswerItem, AskUserQuestionItem } from './protocol/events'
import type { RemoteChannelMessage } from '../shared/bridge'
import type { SessionSummary } from './protocol/sessions'
import type { RpcError } from './protocol/rpc'
import { RpcBusinessError, callRemoteUnary, type UnaryTarget } from './transport/unary'
import { RemoteMuxClient, RemoteStreamError, type RemoteStream } from './transport/mux'
import { RemoteEventsClient, type PendingWaterfall } from './transport/events'

export { RpcBusinessError }

/** Viewport size requested when opening a session journal. */
const SESSION_FOLLOW_MAX_MESSAGES = 60
/** Poll interval while waiting for the carrier to come back. */
const CARRIER_RETRY_MS = 100
/** How long a single `connect()` waits for the mux handshake. */
const CONNECT_TIMEOUT_MS = 10_000

/** One answerable approval request as it arrives on `$events`. */
export interface ApprovalWaterfall {
  /** Reply correlation id; the ONLY key `$events/result` accepts. */
  eventId: string
  /** Agent (session or subagent) the approval is scoped to. */
  agentId: string
  toolName: string
  callId?: string
  reason?: string
}

/** One answerable ask-user-questions request as it arrives on `$events`. */
export interface QuestionWaterfall {
  /** Reply correlation id; the ONLY key `$events/result` accepts. */
  eventId: string
  /** Agent (session or subagent) the questions are scoped to. */
  agentId: string
  questions: AskUserQuestionItem[]
}

/** Handle for one open session journal. */
export interface SessionFollowHandle {
  /** Stop following; the host aborts the underlying stream. */
  cancel(): void
}

/** A terminal per-stream failure, tagged with the scope that produced it. */
export interface StreamFailure {
  /** Endpoint that failed, e.g. `session/control`. */
  scope: string
  error: RpcError
}

/**
 * One host connection.
 *
 * Lifecycle: `connect()` resolves once the mux carrier is up and the Host-wide
 * streams (`$events`, `session/control`, `workspace/follow`) have been opened.
 * Those streams then self-heal across reconnects; the only thing a consumer must
 * handle is that a new baseline frame starts a new generation.
 */
export class DshClient {
  /** Optional diagnostic sink (the extension wires it to the OutputChannel). */
  onLog: ((line: string) => void) | null = null

  private target: UnaryTarget | null = null
  private mux: RemoteMuxClient | null = null
  private events: RemoteEventsClient | null = null
  private disposed = false
  private connected = false

  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private readonly controlListeners = new Set<(frame: SessionControlFrame) => void>()
  private readonly workspaceListeners = new Set<(frame: WorkspaceFollowFrame) => void>()
  private readonly remoteEventListeners = new Set<(event: string, args: unknown[]) => void>()
  private readonly approvalListeners = new Set<(request: ApprovalWaterfall) => void>()
  private readonly approvalClearListeners = new Set<(eventId: string) => void>()
  private readonly questionListeners = new Set<(request: QuestionWaterfall) => void>()
  private readonly streamErrorListeners = new Set<(failure: StreamFailure) => void>()

  /** Live Host-wide stream handles, so a reopen or dispose can close them. */
  private controlStream: RemoteStream<unknown> | null = null
  private workspaceStream: RemoteStream<unknown> | null = null
  /** Per-subscription journal callbacks, so the test seam can reach them. */
  private readonly activeFollows = new Set<(frame: SessionFollowFrame) => void>()

  /**
   * Establish the carrier and open the Host-wide streams.
   * @param info - discovered host facts, including the signed cookie when the host requires browser auth.
   * @throws when the mux handshake fails or is refused (401/403).
   */
  async connect(info: HostInfo): Promise<void> {
    this.disposed = false
    const authority = `127.0.0.1:${info.port}`
    this.target = {
      baseUrl: `http://${authority}`,
      ...(info.cookie !== undefined && info.cookie !== '' ? { cookie: info.cookie } : {}),
      ...(info.token !== undefined && info.token !== '' ? { token: info.token } : {}),
    }
    const mux = new RemoteMuxClient(`ws://${authority}`, info.cookie, info.token)
    mux.log = (line) => this.log(line)
    mux.onStatus((connected) => this.setConnected(connected))
    mux.onCarrierLost(() => {
      // A lost carrier ends EVERY generation, including the Remote Events one:
      // the host mints a new clientId, so the old subscription is dead and the
      // new one must be opened or approvals and questions stop arriving for the
      // rest of the session while the UI still looks connected. The host-wide
      // streams reopen too, so their baselines are re-delivered; per-session
      // journals reopen themselves because `followSession` owns that loop.
      // Both calls are safe while the socket is down: `openStream` queues its
      // frame until the reconnect completes.
      if (this.disposed) return
      this.log('carrier lost; reopening streams')
      this.openHostWideStreams()
      void this.events?.subscribe()
    })
    this.mux = mux
    this.events = new RemoteEventsClient(mux, () => this.requireTarget(), {
      onEmit: (event, args) => {
        for (const listener of this.remoteEventListeners) listener(event, args)
      },
      onWaterfall: (request) => this.dispatchWaterfall(request),
      onCancel: (eventId) => {
        for (const listener of this.approvalClearListeners) listener(eventId)
      },
    })
    mux.connect()
    await this.withTimeout(mux.whenReady(), CONNECT_TIMEOUT_MS)
    this.openHostWideStreams()
    void this.events.subscribe()
  }

  // ---- request / response ----

  /**
   * Call one unary Remote method.
   * @param method - wire endpoint, `<namespace>/<method>`.
   * @param params - the EXACT `args` object its descriptor declares.
   * @returns the method's success value (undefined for `void` results).
   * @throws {RpcBusinessError} on a host business failure.
   */
  async rpc<K extends RpcMethod>(method: K, params: RequestPayload<K>): Promise<ResponseValue<K>>
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T>
  async rpc<T>(method: string, params?: unknown): Promise<T> {
    return callRemoteUnary<T>(this.requireTarget(), method, (params ?? {}) as Record<string, unknown>)
  }

  /**
   * List sessions. Convenience wrapper over the `_request` envelope.
   * @returns the list rows; note that a row carries NO title, because titles
   *   arrive separately as the `title` projection on the control stream.
   */
  async sessionList(): Promise<SessionSummary[]> {
    const value = await this.rpc('session/list', { _request: {} })
    return (value as { items: SessionSummary[] }).items
  }

  /**
   * Send one prompt, minting the `requestId` the host now requires.
   * @param sessionId - target session.
   * @param content - already-assembled prompt parts.
   * @param mode - `queue` for a normal send, `steer` to interrupt the live turn.
   */
  async promptSession(
    sessionId: string,
    content: RequestPayload<'session/prompt'>['request']['content'],
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<void> {
    await this.rpc('session/prompt', {
      request: { requestId: crypto.randomUUID(), sessionId: sessionId as never, mode, content },
    })
  }

  // ---- subscriptions ----

  /**
   * Observe connection flips.
   * @param cb - receives the new state.
   * @returns unsubscribe function.
   */
  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  /**
   * Observe the Host-wide session control stream (queues, jobs, projections).
   * @param cb - receives every frame, including each generation's baseline.
   * @returns unsubscribe function.
   */
  onSessionControl(cb: (frame: SessionControlFrame) => void): () => void {
    this.controlListeners.add(cb)
    return () => this.controlListeners.delete(cb)
  }

  /**
   * Observe the workspace stream (set, manual order, archived set).
   * @param cb - receives every frame, including each generation's baseline.
   * @returns unsubscribe function.
   */
  onWorkspace(cb: (frame: WorkspaceFollowFrame) => void): () => void {
    this.workspaceListeners.add(cb)
    return () => this.workspaceListeners.delete(cb)
  }

  /**
   * Observe broadcast forwarded events (`api-session/added`, `commands/change`, …).
   * Emits are sparse and are NOT a state feed; session state comes from the streams.
   * @param cb - receives the event name and its positional arguments.
   * @returns unsubscribe function.
   */
  onRemoteEvent(cb: (event: string, args: unknown[]) => void): () => void {
    this.remoteEventListeners.add(cb)
    return () => this.remoteEventListeners.delete(cb)
  }

  /**
   * Observe approval requests. Answer them with {@link resolveApproval} using the
   * SAME `eventId`.
   * @param cb - receives each pending approval.
   * @returns unsubscribe function.
   */
  onApprovalRequest(cb: (request: ApprovalWaterfall) => void): () => void {
    this.approvalListeners.add(cb)
    return () => this.approvalListeners.delete(cb)
  }

  /**
   * Observe retracted approvals, so a stale prompt can be dropped.
   * @param cb - receives the retracted `eventId`.
   * @returns unsubscribe function.
   */
  onApprovalCleared(cb: (eventId: string) => void): () => void {
    this.approvalClearListeners.add(cb)
    return () => this.approvalClearListeners.delete(cb)
  }

  /**
   * Observe ask-user-questions requests.
   * @param cb - receives each pending batch and its reply key.
   * @returns unsubscribe function.
   */
  onQuestionRequest(cb: (request: QuestionWaterfall) => void): () => void {
    this.questionListeners.add(cb)
    return () => this.questionListeners.delete(cb)
  }

  /**
   * Observe terminal per-stream failures.
   *
   * A bad endpoint or a business failure kills only its own logical stream, not
   * the socket, so without this hook a dead stream would fail silently — which is
   * exactly how the old client lost host-channel `stream/error` frames.
   * @param cb - receives the failing scope and the host error.
   * @returns unsubscribe function.
   */
  onStreamError(cb: (failure: StreamFailure) => void): () => void {
    this.streamErrorListeners.add(cb)
    return () => this.streamErrorListeners.delete(cb)
  }

  // ---- session journals ----

  /**
   * Follow one session (or addressed subagent) journal.
   *
   * The callback sees each generation's `snapshot` first and then live events. A
   * subscriber MUST treat a new `snapshot` as a full replacement of its history
   * buffer, because the stream restarts from a baseline after every carrier loss.
   * @param address - ordinary-session or direct-subagent address.
   * @param onFrame - receives every frame of the current generation.
   * @returns a handle whose `cancel()` stops following.
   */
  followSession(address: SessionAddress, onFrame: (frame: SessionFollowFrame) => void): SessionFollowHandle {
    let stopped = false
    let current: RemoteStream<unknown> | null = null
    this.activeFollows.add(onFrame)

    const pump = async (): Promise<void> => {
      while (!stopped && !this.disposed) {
        const mux = this.mux
        if (mux === null) return
        await this.waitForCarrier()
        if (stopped || this.disposed) return
        const stream = mux.openStream('session/follow', {
          request: { address, maxMessages: SESSION_FOLLOW_MAX_MESSAGES },
        })
        current = stream
        try {
          for await (const frame of stream) onFrame(frame as SessionFollowFrame)
        } catch (error) {
          // A carrier loss is expected and retried below; anything else is
          // terminal for this journal and must reach the UI.
          if (stopped || this.disposed) return
          if (!(error instanceof RemoteStreamError && error.carrier)) {
            this.reportStreamError('session/follow', error)
            return
          }
        }
      }
    }
    void pump()

    return {
      cancel: () => {
        stopped = true
        this.activeFollows.delete(onFrame)
        current?.cancel()
      },
    }
  }

  // ---- answering ----

  /**
   * Answer a pending approval.
   * @param eventId - the `eventId` delivered to {@link onApprovalRequest}.
   * @param decision - `allow-once` permits this one call; `refuse` rejects it.
   */
  async resolveApproval(eventId: string, decision: 'allow-once' | 'refuse'): Promise<void> {
    const outcome: ApprovalOutcome = decision === 'allow-once' ? 'allowed-once' : 'rejected'
    await this.requireEvents().respondApproval(eventId, outcome)
  }

  /**
   * Answer a pending ask-user-questions batch.
   * @param eventId - the `eventId` delivered to {@link onQuestionRequest}.
   * @param answers - one answer per asked question.
   */
  async answerQuestion(eventId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    await this.requireEvents().respondQuestions(eventId, answers)
  }

  /**
   * TEST SEAM: deliver one channel message exactly as a host stream would.
   *
   * The e2e harness uses this to drive host-initiated frames (session status,
   * answerable requests, journal events) without needing a controllable host,
   * so UI reaction can be asserted deterministically. The stream mechanics
   * themselves are covered separately against a faithful fake host in
   * `tests/transport.test.ts`. Production code never calls this.
   * @param message - the channel message to deliver.
   */
  emitChannel(message: RemoteChannelMessage): void {
    switch (message.channel) {
      case 'control':
        for (const listener of this.controlListeners) listener(message.frame)
        return
      case 'workspace':
        for (const listener of this.workspaceListeners) listener(message.frame)
        return
      case 'session':
        for (const listener of this.activeFollows) listener(message.frame)
        return
      case 'remote':
        for (const listener of this.remoteEventListeners) listener(message.event, message.args)
    }
  }

  /** Close the carrier, release the subscription, and settle every stream. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.controlStream?.cancel()
    this.workspaceStream?.cancel()
    this.controlStream = null
    this.workspaceStream = null
    this.events?.close()
    this.events = null
    this.mux?.dispose()
    this.mux = null
    this.target = null
    this.setConnected(false)
    // Release every subscription. This instance is reused across a host restart
    // (`Bridge.handleRestartHost` disposes then reconnects the same client), so
    // leaving the listener sets intact would make the bridge's re-wire register a
    // SECOND copy of each subscription and deliver every frame twice — which
    // shows up as a duplicated transcript, not as a visible error.
    this.clearListeners()
  }

  // ---- internals ----

  /** Drop every subscription (see the note in `dispose`). */
  private clearListeners(): void {
    this.statusListeners.clear()
    this.controlListeners.clear()
    this.workspaceListeners.clear()
    this.remoteEventListeners.clear()
    this.approvalListeners.clear()
    this.approvalClearListeners.clear()
    this.questionListeners.clear()
    this.streamErrorListeners.clear()
    this.activeFollows.clear()
  }

  /** Open (or reopen) the Host-wide streams; each one starts at a baseline. */
  private openHostWideStreams(): void {
    const mux = this.mux
    if (mux === null || this.disposed) return
    this.controlStream?.cancel()
    this.workspaceStream?.cancel()

    const control = mux.openStream('session/control', {})
    this.controlStream = control
    void this.drain(control, 'session/control', (frame) => {
      for (const listener of this.controlListeners) listener(frame as SessionControlFrame)
    })

    const workspace = mux.openStream('workspace/follow', {})
    this.workspaceStream = workspace
    void this.drain(workspace, 'workspace/follow', (frame) => {
      for (const listener of this.workspaceListeners) listener(frame as WorkspaceFollowFrame)
    })
  }

  /**
   * Forward a stream's frames until it dies.
   * Carrier losses need no handling here: the carrier-lost hook reopens the
   * stream and the new baseline supersedes the old state.
   */
  private async drain(stream: RemoteStream<unknown>, scope: string, onFrame: (frame: unknown) => void): Promise<void> {
    try {
      for await (const frame of stream) onFrame(frame)
    } catch (error) {
      if (this.disposed) return
      if (!(error instanceof RemoteStreamError && error.carrier)) this.reportStreamError(scope, error)
    }
  }

  /** Surface one terminal stream failure to listeners. */
  private reportStreamError(scope: string, error: unknown): void {
    const rpcError = (error instanceof RemoteStreamError
      ? { code: error.code ?? 'transport', message: error.message, details: error.details ?? {} }
      : { code: 'transport', message: error instanceof Error ? error.message : String(error), details: {} }) as RpcError
    this.log(`stream error [${scope}]: ${rpcError.code} ${rpcError.message}`)
    for (const listener of this.streamErrorListeners) listener({ scope, error: rpcError })
  }

  /** Route one waterfall frame to the matching listener family. */
  private dispatchWaterfall(request: PendingWaterfall): void {
    if (request.event === 'approval/request') {
      const wire = request.request as { toolName?: string; callId?: string; reason?: string }
      const approval: ApprovalWaterfall = {
        eventId: request.eventId,
        agentId: request.agentId,
        toolName: typeof wire.toolName === 'string' ? wire.toolName : '',
        ...(typeof wire.callId === 'string' ? { callId: wire.callId } : {}),
        ...(typeof wire.reason === 'string' ? { reason: wire.reason } : {}),
      }
      for (const listener of this.approvalListeners) listener(approval)
      return
    }
    if (request.event === 'user-questions/request') {
      const wire = request.request as { questions?: AskUserQuestionItem[] }
      const batch: QuestionWaterfall = {
        eventId: request.eventId,
        agentId: request.agentId,
        questions: Array.isArray(wire.questions) ? wire.questions : [],
      }
      for (const listener of this.questionListeners) listener(batch)
    }
  }

  /** Wait until the carrier reports itself connected (resolves immediately when it is). */
  private async waitForCarrier(): Promise<void> {
    const mux = this.mux
    if (mux === null || mux.isConnected) return
    await new Promise<void>((resolve) => {
      const unsubscribe = mux.onStatus((connected) => {
        if (!connected) return
        unsubscribe()
        resolve()
      })
      if (this.disposed || mux.isConnected) {
        unsubscribe()
        resolve()
      }
    })
  }

  /** The unary target, or a hard failure when used before `connect`. */
  private requireTarget(): UnaryTarget {
    if (this.target === null) throw new Error('dsh client is not connected')
    return this.target
  }

  /** The events client, or a hard failure when used before `connect`. */
  private requireEvents(): RemoteEventsClient {
    if (this.events === null) throw new Error('dsh client is not connected')
    return this.events
  }

  /** Reject a promise that does not settle in time. */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('dsh WebSocket connect timeout')), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** Notify status listeners on an actual flip only. */
  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const listener of this.statusListeners) listener(connected)
  }

  /** Emit one diagnostic line through the optional sink. */
  private log(line: string): void {
    this.onLog?.(`[dsh-client] ${line}`)
  }
}
