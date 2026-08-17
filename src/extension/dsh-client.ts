/**
 * DshClient: RPC + event-stream client for the dsh web host.
 * Contract: ARCHITECTURE.md section 4.3. Wire format follows the harness
 * apiproxy fetch/WS carriers (vendored under ./protocol):
 *   - unary RPC:   POST /api/<method>   body=ClientRequest  -> ServerResponse
 *   - answerable:  POST /api/respond    body=ClientResponse -> RpcReceipt
 *   - mux stream:  WS /api/events.mux   frames are ServerRequest{payload:MuxFrame}
 *   - host stream: WS /api/events.host  frames are ServerRequest{payload:HostFrame}
 * Both sockets reconnect with exponential backoff after an unexpected close.
 * Pure Node (global fetch/WebSocket, Node >= 22); no vscode runtime import, so
 * the module is unit-testable under node:test.
 */

import type { HostInfo } from './host-manager'
import type { ApprovalRequestId, SessionId } from './protocol/brand'
import type { AskUserQuestionAnswerItem } from './protocol/events'
import type { MuxFrame, HostFrame } from './protocol/events'
import type { ClientRequest, ClientResponse, RpcReceipt, ServerRequest, ServerResponse } from './protocol/rpc'
import { RpcId } from './protocol/rpc'
import type { RequestPayload, ResponseValue, RpcMethod } from './protocol/rpc-map'
import type { ApprovalResponsePayload, QuestionResponsePayload } from './protocol/approvals'

/** Business error raised by rpc() when the host answers `ok: false`. */
export class RpcBusinessError extends Error {
  constructor(
    /** Stable machine-routing code from the RpcError union. */
    readonly code: string,
    message: string,
    /** Structured details carried by the error code's details row. */
    readonly details: unknown,
  ) {
    super(message)
    this.name = 'RpcBusinessError'
  }
}

/** Facts needed to answer one pending approval frame (keyed by the frame's rpcId). */
interface PendingApproval {
  sessionId: SessionId
  approvalId: ApprovalRequestId
}

/** Facts needed to answer one pending question frame (keyed by the frame's rpcId). */
interface PendingQuestion {
  sessionId: SessionId
}

const MUX_EVENTS_PATH = '/api/events.mux'
const HOST_EVENTS_PATH = '/api/events.host'
const RPC_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 30_000

/**
 * One host connection: two downlink-only WebSockets plus unary HTTP RPC.
 * Approval/question answers are client-responses that echo the requested
 * frame's rpcId; the client keeps the pending-frame facts needed to build them.
 */
export class DshClient {
  /** Optional diagnostic sink (extension wires it to the OutputChannel). */
  onLog: ((line: string) => void) | null = null

  private baseUrl: string | null = null
  private muxSocket: WebSocket | null = null
  private hostSocket: WebSocket | null = null
  private readonly muxListeners = new Set<(frame: MuxFrame) => void>()
  private readonly hostListeners = new Set<(frame: HostFrame) => void>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private disposed = false
  private connected = false
  private reconnecting = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Establish both WS connections (mux + host). Resolves once both are open;
   * rejects when either fails before opening. Later drops auto-reconnect.
   * @param info - host connection info from HostManager.
   */
  async connect(info: HostInfo): Promise<void> {
    this.disposed = false
    this.baseUrl = `http://127.0.0.1:${info.port}`
    await this.openSockets()
  }

  /**
   * Typed unary RPC: POST /api/<method> with a ClientRequest envelope, verify
   * the echoed rpcId, unwrap the result slot. Business errors reject with
   * RpcBusinessError; transport failures reject with a plain Error.
   * @param method - registered method name, e.g. 'session.list'.
   * @param params - business payload of the method.
   * @returns the ok value of the server response.
   */
  async rpc<K extends RpcMethod>(method: K, params: RequestPayload<K>): Promise<ResponseValue<K>>
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T>
  async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (this.baseUrl === null) throw new Error('dsh client is not connected')
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId(crypto.randomUUID()),
      method,
      payload: params ?? {},
    }
    const response = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`transport failure for ${method}: HTTP ${response.status}`)
    const body = (await response.json()) as ServerResponse
    if (body.type !== 'server-response') throw new Error(`malformed response for ${method}: unexpected type`)
    if (body.rpcId !== request.rpcId) {
      throw new Error(`rpcId mismatch for ${method}: sent ${request.rpcId}, got ${body.rpcId}`)
    }
    if (!body.result.ok) {
      const error = body.result.error
      throw new RpcBusinessError(error.code, error.message, error.details)
    }
    return body.result.value as T
  }

  /**
   * Subscribe to mux stream frames. Answerable frames are tracked internally
   * so resolveApproval/answerQuestion can echo their rpcId.
   * @param cb - frame consumer.
   * @returns unsubscribe function.
   */
  onMuxEvent(cb: (frame: MuxFrame) => void): () => void {
    this.muxListeners.add(cb)
    return () => this.muxListeners.delete(cb)
  }

  /**
   * Subscribe to host stream frames.
   * @param cb - frame consumer.
   * @returns unsubscribe function.
   */
  onHostEvent(cb: (frame: HostFrame) => void): () => void {
    this.hostListeners.add(cb)
    return () => this.hostListeners.delete(cb)
  }

  /**
   * Subscribe to connectivity flips (both sockets open -> true; an unexpected
   * close -> false). Additive to the frozen contract; the bridge maps it to
   * host-status messages.
   * @param cb - status consumer.
   * @returns unsubscribe function.
   */
  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  /**
   * Answer a pending approval request (client-response echoing the frame's rpcId).
   * @param requestId - rpcId of the `approval/requested` frame.
   * @param decision - 'allow-once' maps to outcome 'allowed-once', 'refuse' to 'rejected'.
   */
  async resolveApproval(requestId: string, decision: 'allow-once' | 'refuse'): Promise<void> {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) throw new Error(`unknown or already-resolved approval request: ${requestId}`)
    const value: ApprovalResponsePayload = {
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      outcome: decision === 'allow-once' ? 'allowed-once' : 'rejected',
    }
    await this.respond(RpcId(requestId), value)
  }

  /**
   * Answer a pending ask-user question batch (one ask, one batch answer).
   * @param requestId - rpcId of the `question/requested` frame.
   * @param answers - per-question answers keyed by question id.
   */
  async answerQuestion(requestId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) throw new Error(`unknown or already-resolved question request: ${requestId}`)
    const value: QuestionResponsePayload = { sessionId: pending.sessionId, answer: { answers } }
    await this.respond(RpcId(requestId), value)
  }

  /**
   * Answer a pending approval correlated by approvalId instead of rpcId. The
   * webview never sees rpcIds (the MuxFrame union does not carry them), so the
   * bridge's `respond` message correlates by approvalId and this lookup
   * recovers the frame rpcId (ARCHITECTURE.md section 3 revision 2).
   * @param approvalId - approvalId from the `approval/requested` frame.
   * @param decision - 'allow-once' or 'refuse'.
   */
  async resolveApprovalByApprovalId(approvalId: ApprovalRequestId, decision: 'allow-once' | 'refuse'): Promise<void> {
    for (const [rpcId, pending] of this.pendingApprovals) {
      if (pending.approvalId === approvalId) return await this.resolveApproval(rpcId, decision)
    }
    throw new Error(`unknown or already-resolved approval: ${approvalId}`)
  }

  /**
   * Answer a pending question batch correlated by sessionId instead of rpcId
   * (same correlation gap as resolveApprovalByApprovalId). At most one ask()
   * batch is pending per session, so the sessionId identifies the frame.
   * @param sessionId - sessionId of the `question/requested` frame.
   * @param answers - per-question answers keyed by question id.
   */
  async answerQuestionBySessionId(sessionId: SessionId, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    for (const [rpcId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) return await this.answerQuestion(rpcId, answers)
    }
    throw new Error(`unknown or already-resolved question for session: ${sessionId}`)
  }

  /**
   * Test hook (E2E): emit one mux frame through the exact same dispatch path
   * as a WebSocket frame — pending-request tracking (`trackPending`, so the
   * respond correlation works) plus the listener fan-out — with the frame
   * sourced from test code instead of the wire. Interface-aligned by design:
   * consumers (Bridge/OverlayRetention/webview) cannot tell the source apart.
   * @param frame - the mux frame to dispatch.
   * @param rpcId - optional rpcId for answerable frames; a synthetic id is
   * minted when omitted (answering then hits the real host, which rejects the
   * unknown rpcId — expected for injected frames).
   */
  emitMuxFrame(frame: MuxFrame, rpcId?: RpcId): void {
    const id = rpcId ?? RpcId(crypto.randomUUID())
    this.trackPending(id, frame)
    for (const cb of this.muxListeners) cb(frame)
  }

  /**
   * Test hook (E2E): emit one host frame through the same listener fan-out as
   * a WebSocket host frame, sourced from test code instead of the wire.
   * @param frame - the host frame to dispatch.
   */
  emitHostFrame(frame: HostFrame): void {
    for (const cb of this.hostListeners) cb(frame)
  }

  /** Close both sockets, stop reconnecting, and drop pending state. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.muxSocket?.close()
    this.hostSocket?.close()
    this.muxSocket = null
    this.hostSocket = null
    this.pendingApprovals.clear()
    this.pendingQuestions.clear()
    this.setConnected(false)
  }

  /** POST /api/respond with a client-response; reject when the host refuses the receipt. */
  private async respond(rpcId: RpcId, value: unknown): Promise<void> {
    if (this.baseUrl === null) throw new Error('dsh client is not connected')
    const message: ClientResponse = { type: 'client-response', rpcId, result: { ok: true, value } }
    const response = await fetch(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`transport failure for respond: HTTP ${response.status}`)
    const receipt = (await response.json()) as RpcReceipt
    if (!receipt.accepted) throw new Error(`respond rejected: ${receipt.reason}`)
  }

  /** Open both sockets; resolve when both are open, reject on the first pre-open failure. */
  private openSockets(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dsh WebSocket connect timeout')), CONNECT_TIMEOUT_MS)
      let opened = 0
      const onOneOpen = (): void => {
        opened += 1
        if (opened === 2) {
          clearTimeout(timer)
          this.onBothSocketsMaybeUp()
          resolve()
        }
      }
      const onPreOpenError = (error: unknown): void => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      this.muxSocket = this.openSocket(MUX_EVENTS_PATH, onOneOpen, onPreOpenError)
      this.hostSocket = this.openSocket(HOST_EVENTS_PATH, onOneOpen, onPreOpenError)
    })
  }

  /**
   * Open one downlink WebSocket and wire frame dispatch + reconnect triggers.
   * @param path - WS pathname (/api/events.mux or /api/events.host).
   * @param onOpen - called once the socket opens.
   * @param onPreOpenError - reject hook valid only before the socket first opens.
   */
  private openSocket(path: string, onOpen: () => void, onPreOpenError: (error: unknown) => void): WebSocket {
    const url = `ws://127.0.0.1:${new URL(this.baseUrl as string).port}${path}`
    const socket = new WebSocket(url)
    let everOpened = false
    socket.addEventListener('open', () => {
      const firstOpen = !everOpened
      everOpened = true
      this.log(`ws open: ${path}`)
      if (firstOpen) onOpen()
      else this.onBothSocketsMaybeUp()
    })
    socket.addEventListener('message', (event) => this.handleMessage(path, event))
    socket.addEventListener('error', (event) => {
      if (!everOpened) onPreOpenError(new Error(`dsh WebSocket failed to open: ${path}`))
      else this.log(`ws error on ${path}: ${String(event)}`)
    })
    socket.addEventListener('close', () => {
      this.log(`ws closed: ${path}`)
      if (this.disposed || this.reconnecting) return
      this.setConnected(false)
      this.scheduleReconnect()
    })
    return socket
  }

  /** Parse and dispatch one WS text frame; malformed frames are logged and dropped. */
  private handleMessage(path: string, event: MessageEvent): void {
    let full: ServerRequest
    try {
      if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
      full = JSON.parse(event.data) as ServerRequest
      if (full.type !== 'server-request' || typeof full.payload !== 'object' || full.payload === null) {
        throw new Error('not a server-request envelope')
      }
    } catch (error) {
      this.log(`dropping malformed WebSocket frame on ${path}: ${String(error)}`)
      return
    }
    if (path === MUX_EVENTS_PATH) {
      const frame = full.payload as MuxFrame
      this.trackPending(full.rpcId, frame)
      for (const cb of this.muxListeners) cb(frame)
    } else {
      const frame = full.payload as HostFrame
      for (const cb of this.hostListeners) cb(frame)
    }
  }

  /** Track answerable frames (requested) and clear them on resolved, keyed by rpcId. */
  private trackPending(rpcId: RpcId, frame: MuxFrame): void {
    switch (frame.type) {
      case 'approval/requested':
        this.pendingApprovals.set(rpcId, { sessionId: frame.sessionId, approvalId: frame.approvalId })
        break
      case 'approval/resolved':
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.approvalId === frame.approvalId) this.pendingApprovals.delete(id)
        }
        break
      case 'question/requested':
        this.pendingQuestions.set(rpcId, { sessionId: frame.sessionId })
        break
      case 'question/resolved':
        this.pendingQuestions.delete(frame.questionRpcId)
        break
    }
  }

  /** Reopen both sockets after a drop, with exponential backoff (500ms * 2^n, capped at 30s). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.reconnecting) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_CAP_MS)
    this.reconnectAttempts += 1
    this.log(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => void this.reconnect(), delay)
  }

  /** One reconnect pass: close stale sockets, reopen both, reschedule on failure. */
  private async reconnect(): Promise<void> {
    this.reconnectTimer = null
    if (this.disposed) return
    // Closing stale sockets must not re-enter scheduleReconnect from their close events.
    this.reconnecting = true
    this.muxSocket?.close()
    this.hostSocket?.close()
    try {
      await this.openSockets()
      this.onBothSocketsMaybeUp()
    } catch (error) {
      this.log(`reconnect failed: ${String(error)}`)
    } finally {
      this.reconnecting = false
    }
    if (!this.connected && !this.disposed) this.scheduleReconnect()
  }

  /** After a reconnect, flip status back up once both sockets are open again. */
  private onBothSocketsMaybeUp(): void {
    if (
      this.muxSocket?.readyState === WebSocket.OPEN
      && this.hostSocket?.readyState === WebSocket.OPEN
    ) {
      this.reconnectAttempts = 0
      this.setConnected(true)
    }
  }

  /** Notify status listeners on an actual flip only. */
  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const cb of this.statusListeners) cb(connected)
  }

  /** Emit one diagnostic line through the optional sink. */
  private log(line: string): void {
    this.onLog?.(`[dsh-client] ${line}`)
  }
}
