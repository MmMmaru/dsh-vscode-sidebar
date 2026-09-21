/**
 * Bridge client for the webview side. Wraps acquireVsCodeApi: rpc pairs requests
 * with `rpc-result` by id, the four Remote channels fan out, and waitInit
 * resolves with the init payload answering the `ready` handshake.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the old `onEvent` callback
 * received `(channel: 'mux' | 'host', frame)`, mirroring the two apiproxy
 * sockets. Those sockets are gone; events now arrive on four distinct channels
 * with unrelated payload shapes, so `onEvent` delivers a discriminated message
 * instead of a loosely-typed frame. Answerable requests are keyed by `eventId`.
 */

import type { RpcError } from '../extension/protocol/rpc'
import type { AskUserQuestionAnswerItem } from '../extension/protocol/events'
import type { SessionAddress } from '../extension/protocol/follow'
import type {
  ExtensionMessage,
  HostStatus,
  IdeContentKind,
  IdeContentPayload,
  InitPayload,
  RemoteChannelMessage,
  WebviewMessage,
} from '../shared/bridge'

export type { RemoteChannelMessage }

/** A logically dead stream, reported per scope. */
export interface StreamFailure {
  scope: string
  error: RpcError
}

/** Minimal shape of the VSCode webview API object. */
interface VsCodeApi {
  postMessage(message: WebviewMessage): void
}

declare function acquireVsCodeApi(): VsCodeApi

/**
 * Guarded acquisition: outside VSCode (mock/dev mode) the global is absent and
 * the mock bridge is used instead, so this module must evaluate safely.
 */
function tryAcquireVsCodeApi(): VsCodeApi | null {
  try {
    return typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null
  } catch {
    return null
  }
}

const vscode = tryAcquireVsCodeApi()

/**
 * The bridge client surface consumed by the store slices (ARCHITECTURE.md
 * section 5.1 plus the respond pair answering answerable frames). Both this
 * module and mock/bridge.ts implement it; bridge.ts picks one at startup.
 */
export interface BridgeClient {
  rpc: <T = unknown>(method: string, params?: unknown) => Promise<T>
  onEvent: (cb: (message: RemoteChannelMessage) => void) => () => void
  onHostStatus: (cb: (status: HostStatus) => void) => () => void
  onCommand: (cb: (command: 'newChat' | 'openSettings') => void) => () => void
  waitInit: () => Promise<InitPayload>
  /**
   * Subscribe to one session journal. The host no longer broadcasts every
   * session's events, so this must be called when the viewed session changes;
   * opening a new address replaces the previous subscription.
   */
  followSession: (address: SessionAddress) => void
  /** Drop the current session-journal subscription. */
  unfollowSession: () => void
  /** Subscribe to logically-dead stream reports (the connection stays up). */
  onStreamError: (cb: (failure: StreamFailure) => void) => () => void
  /** Answer a pending approval request; `eventId` comes from the request itself. */
  respondApproval: (eventId: string, decision: 'allow-once' | 'refuse') => Promise<void>
  /** Answer a pending ask-user question batch; `eventId` comes from the request. */
  respondQuestion: (eventId: string, answers: AskUserQuestionAnswerItem[]) => Promise<void>
  /** Subscribe to `ide-content` deliveries from the extension host. */
  onIdeContent: (cb: (content: IdeContentPayload) => void) => () => void
  /** Ask the extension host to read IDE content (selection / active file). */
  requestIdeContent: (kind: IdeContentKind) => void
  /** Correlated request/response: resolve with the payload (or an error
   * payload) once the extension host answers. */
  fetchIdeContent: (kind: IdeContentKind) => Promise<IdeContentPayload>
  /** Ask the extension host to open a `path:line` reference (code jump).
   * Resolves once the host confirms the open; rejects with the host's reason
   * (or a timeout) so the chip can show the failure in-place. */
  openFileInIde: (target: { path: string; line?: number; endLine?: number; col?: number; cwd?: string }) => Promise<void>
  /** Update the configured DSH base port. */
  setPort: (port: number) => Promise<void>
  /** Request host restart. */
  restartHost: () => Promise<void>
  /** Subscribe to port updates. */
  onPortChanged: (cb: (port: number) => void) => () => void
  /** Update the custom host environment injected into the next spawned host
   * (`dsh.env`); resolves once the extension persisted it. */
  setEnv: (env: Record<string, string>) => Promise<void>
  /** Subscribe to host-environment updates; the payload is the persisted
   * (cleaned) map echoed by the extension. */
  onEnvChanged: (cb: (env: Record<string, string>) => void) => () => void
  /** Ask the extension host to open the Settings full editor tab. */
  openSettingsTab: () => void
}

interface PendingRpc {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const pendingRpcs = new Map<string, PendingRpc>()
const pendingIde = new Map<string, (content: IdeContentPayload) => void>()
const pendingOpenFiles = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
const eventListeners = new Set<(message: RemoteChannelMessage) => void>()
const streamErrorListeners = new Set<(failure: StreamFailure) => void>()
const statusListeners = new Set<(status: HostStatus) => void>()
const commandListeners = new Set<(command: 'newChat' | 'openSettings') => void>()
const ideContentListeners = new Set<(content: IdeContentPayload) => void>()
const portListeners = new Set<(port: number) => void>()
const envListeners = new Set<(env: Record<string, string>) => void>()
const initWaiters: Array<(payload: InitPayload) => void> = []
let initPayload: InitPayload | null = null
let readySent = false

/** Deadline for a correlated ide-request; the extension host always answers,
 * this only guards against a wedged message channel. */
const IDE_REQUEST_TIMEOUT_MS = 2000

/** Deadline for a correlated ide-open-file; opening a large file can take a
 * moment, so this is looser than the ide-request deadline. */
const OPEN_FILE_TIMEOUT_MS = 5000

// Guarded for non-DOM hosts (mock verification under node).
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
    const message = event.data
    switch (message.type) {
      case 'init': {
        initPayload = {
          cwd: message.cwd,
          port: message.port,
          env: message.env,
          sessions: message.sessions,
          workspaces: message.workspaces,
          archivedSessionIds: message.archivedSessionIds,
          pendingOverlays: message.pendingOverlays,
        }
        for (const waiter of initWaiters.splice(0)) waiter(initPayload)
        break
      }
      case 'rpc-result': {
        const pending = pendingRpcs.get(message.id)
        if (!pending) return
        pendingRpcs.delete(message.id)
        if (message.error !== undefined) pending.reject(new Error(message.error))
        else pending.resolve(message.result)
        break
      }
      case 'event': {
        const forwarded: RemoteChannelMessage = message.channel === 'remote'
          ? { channel: 'remote', event: message.event, args: message.args }
          : message.channel === 'control'
            ? { channel: 'control', frame: message.frame }
            : message.channel === 'workspace'
              ? { channel: 'workspace', frame: message.frame }
              : { channel: 'session', frame: message.frame }
        for (const cb of eventListeners) cb(forwarded)
        break
      }
      case 'stream-error':
        for (const cb of streamErrorListeners) cb({ scope: message.scope, error: message.error })
        break
      case 'host-status':
        for (const cb of statusListeners) cb(message.status)
        break
      case 'command':
        for (const cb of commandListeners) cb(message.command)
        break
      case 'ide-content': {
        const payload: IdeContentPayload = {
          kind: message.kind,
          text: message.text,
          path: message.path,
          error: message.error,
          fromSelection: message.fromSelection,
        }
        // Correlated answer (send-time auto-injection) wins over subscribers.
        if (message.id !== undefined) {
          const resolve = pendingIde.get(message.id)
          if (resolve !== undefined) {
            pendingIde.delete(message.id)
            resolve(payload)
            break
          }
        }
        for (const cb of ideContentListeners) cb(payload)
        break
      }
      case 'ide-open-file-result': {
        const pending = pendingOpenFiles.get(message.id)
        if (pending === undefined) break
        pendingOpenFiles.delete(message.id)
        if (message.error !== undefined) pending.reject(new Error(message.error))
        else pending.resolve()
        break
      }
      case 'port-changed': {
        for (const cb of portListeners) cb(message.port)
        break
      }
      case 'env-changed': {
        for (const cb of envListeners) cb(message.env)
        break
      }
    }
  })
}

/**
 * Send the `ready` handshake once and return the init payload (cached after
 * the first arrival).
 * @returns the init payload (cwd, hostVersion, sessions).
 */
export function waitInit(): Promise<InitPayload> {
  if (initPayload !== null) return Promise.resolve(initPayload)
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  if (!readySent) {
    readySent = true
    vscode.postMessage({ type: 'ready' })
  }
  return new Promise((resolve) => initWaiters.push(resolve))
}

/**
 * Issue a passthrough RPC through the bridge; rejects with the host's error
 * message when the rpc-result carries `error`.
 * @param method - dsh RPC method name, e.g. 'session.list'.
 * @param params - the method's business payload.
 * @returns the result value.
 */
export function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  const id = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    pendingRpcs.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
    })
    vscode.postMessage({ type: 'rpc', id, method, params })
  })
}

/**
 * Subscribe to the dsh Remote channels.
 * @param cb - receives one discriminated message per forwarded channel frame.
 * @returns unsubscribe function.
 */
export function onEvent(cb: (message: RemoteChannelMessage) => void): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

/**
 * Subscribe to logically-dead stream reports. The carrier stays up, so a dead
 * `session/follow` would otherwise be invisible.
 * @param cb - receives the failing scope and the host error.
 * @returns unsubscribe function.
 */
export function onStreamError(cb: (failure: StreamFailure) => void): () => void {
  streamErrorListeners.add(cb)
  return () => streamErrorListeners.delete(cb)
}

/**
 * Subscribe to one session journal, replacing any previous subscription.
 * @param address - session or direct-subagent address to follow.
 */
export function followSession(address: SessionAddress): void {
  vscode?.postMessage({ type: 'follow-session', address })
}

/** Drop the current session-journal subscription. */
export function unfollowSession(): void {
  vscode?.postMessage({ type: 'unfollow-session' })
}

/**
 * Subscribe to host lifecycle notifications.
 * @param cb - receives the new status on every flip.
 * @returns unsubscribe function.
 */
export function onHostStatus(cb: (status: HostStatus) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

/**
 * Subscribe to toolbar commands forwarded by the extension.
 * @param cb - receives the command identifier.
 * @returns unsubscribe function.
 */
export function onCommand(cb: (command: 'newChat' | 'openSettings') => void): () => void {
  commandListeners.add(cb)
  return () => commandListeners.delete(cb)
}

/**
 * Answer a pending approval request via the `respond` bridge message. `eventId`
 * is the request's own correlation id — the key `$events/result` accepts.
 * @param eventId - id carried by the pending approval.
 * @param decision - 'allow-once' or 'refuse'.
 */
export function respondApproval(eventId: string, decision: 'allow-once' | 'refuse'): Promise<void> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  vscode.postMessage({ type: 'respond', kind: 'approval', eventId, decision })
  return Promise.resolve()
}

/**
 * Answer a pending ask-user question batch via the `respond` bridge message.
 * @param eventId - id carried by the pending question batch.
 * @param answers - per-question answers keyed by question id.
 */
export function respondQuestion(eventId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  vscode.postMessage({ type: 'respond', kind: 'question', eventId, answers })
  return Promise.resolve()
}

/**
 * Subscribe to `ide-content` deliveries (the extension host's answer to an
 * `ide-request` or to the `dsh.insert*` toolbar commands).
 * @param cb - receives the content payload (error slot set on failure).
 * @returns unsubscribe function.
 */
export function onIdeContent(cb: (content: IdeContentPayload) => void): () => void {
  ideContentListeners.add(cb)
  return () => ideContentListeners.delete(cb)
}

/**
 * Ask the extension host to read the active editor (selection / whole
 * document) and post it back as `ide-content`.
 * @param kind - what to read; `selection` falls back to the whole document
 * when the selection is empty.
 */
export function requestIdeContent(kind: IdeContentKind): void {
  if (vscode === null) throw new Error('vscode webview API unavailable (use the mock bridge)')
  vscode.postMessage({ type: 'ide-request', kind })
}

/**
 * Correlated variant of `requestIdeContent`: resolves with the payload once
 * the extension host answers (the answer echoes the correlation id), or with
 * an error payload on timeout. Used by the send-time auto-injection so the
 * prompt can be enriched before `session.prompt` goes out.
 * @param kind - what to read.
 * @returns the content payload (error slot set on failure or timeout).
 */
export function fetchIdeContent(kind: IdeContentKind): Promise<IdeContentPayload> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  const id = crypto.randomUUID()
  return new Promise((resolve) => {
    pendingIde.set(id, resolve)
    vscode.postMessage({ type: 'ide-request', kind, id })
    setTimeout(() => {
      const resolvePending = pendingIde.get(id)
      if (resolvePending !== undefined) {
        pendingIde.delete(id)
        resolvePending({ kind, text: '', error: 'ide-request 超时' })
      }
    }, IDE_REQUEST_TIMEOUT_MS)
  })
}

/**
 * Ask the extension host to open a `path:line` reference in the IDE. The
 * extension resolves the path (session cwd first, workspace root second) and
 * reveals/highlights the target range, then answers with an
 * `ide-open-file-result` receipt echoing the correlation id.
 * @param target - the parsed reference plus the session cwd for resolution.
 * @returns resolves on success; rejects with the extension's reason (or a
 * timeout guard against a wedged channel) on failure.
 */
export function openFileInIde(target: {
  path: string
  line?: number
  endLine?: number
  col?: number
  cwd?: string
}): Promise<void> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    pendingOpenFiles.set(id, { resolve, reject })
    vscode.postMessage({ type: 'ide-open-file', id, ...target })
    setTimeout(() => {
      const pending = pendingOpenFiles.get(id)
      if (pending !== undefined) {
        pendingOpenFiles.delete(id)
        pending.reject(new Error('代码跳转超时'))
      }
    }, OPEN_FILE_TIMEOUT_MS)
  })
}

/** Update the DSH base port setting in VS Code configuration. */
export function setPort(port: number): Promise<void> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  vscode.postMessage({ type: 'set-port', port })
  return Promise.resolve()
}

/** Request restarting the DSH host process. */
export function restartHost(): Promise<void> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  vscode.postMessage({ type: 'restart-host' })
  return Promise.resolve()
}

/** Ask the extension host to open the Settings tab. */
export function openSettingsTab(): void {
  if (vscode === null) return
  vscode.postMessage({ type: 'open-settings-tab' })
}

/** Subscribe to port updates. */
export function onPortChanged(cb: (port: number) => void): () => void {
  portListeners.add(cb)
  return () => portListeners.delete(cb)
}

/** Update the custom host environment (`dsh.env`) in VS Code configuration. */
export function setEnv(env: Record<string, string>): Promise<void> {
  if (vscode === null) return Promise.reject(new Error('vscode webview API unavailable (use the mock bridge)'))
  vscode.postMessage({ type: 'set-env', env })
  return Promise.resolve()
}

/** Subscribe to host-environment updates; the payload is the cleaned map. */
export function onEnvChanged(cb: (env: Record<string, string>) => void): () => void {
  envListeners.add(cb)
  return () => envListeners.delete(cb)
}
