/**
 * Bridge client for the webview side (ARCHITECTURE.md section 5.1). Wraps
 * acquireVsCodeApi: rpc pairs requests with `rpc-result` by id, event/host
 * status subscriptions fan out, and waitInit resolves with the init payload
 * answering the `ready` handshake.
 */

import type { ExtensionMessage, HostStatus, InitPayload, WebviewMessage } from '../shared/bridge'

/** Minimal shape of the VSCode webview API object. */
interface VsCodeApi {
  postMessage(message: WebviewMessage): void
}

declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

interface PendingRpc {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const pendingRpcs = new Map<string, PendingRpc>()
const eventListeners = new Set<(channel: 'mux' | 'host', frame: unknown) => void>()
const statusListeners = new Set<(status: HostStatus) => void>()
const commandListeners = new Set<(command: 'newChat' | 'openSettings') => void>()
const initWaiters: Array<(payload: InitPayload) => void> = []
let initPayload: InitPayload | null = null
let readySent = false

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data
  switch (message.type) {
    case 'init': {
      initPayload = { cwd: message.cwd, hostVersion: message.hostVersion, sessions: message.sessions }
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
    case 'event':
      for (const cb of eventListeners) cb(message.channel, message.frame)
      break
    case 'host-status':
      for (const cb of statusListeners) cb(message.status)
      break
    case 'command':
      for (const cb of commandListeners) cb(message.command)
      break
  }
})

/**
 * Send the `ready` handshake once and return the init payload (cached after
 * the first arrival).
 * @returns the init payload (cwd, hostVersion, sessions).
 */
export function waitInit(): Promise<InitPayload> {
  if (initPayload !== null) return Promise.resolve(initPayload)
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
 * Subscribe to the dsh event streams.
 * @param cb - receives (channel, frame) for every forwarded frame.
 * @returns unsubscribe function.
 */
export function onEvent(cb: (channel: 'mux' | 'host', frame: unknown) => void): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
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
