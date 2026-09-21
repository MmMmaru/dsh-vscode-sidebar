/**
 * WebSocket mux carrier for Typert Remote streams.
 * Vendored wire contract (dsh 0.1.5-rc.2, `dsh-api-gateway/lib/types/stream-protocol.js`):
 *
 *   socket:  ws://127.0.0.1:<port>/api/remote.mux   (text frames only)
 *   open:    {"type":"open","streamId":ID,"endpoint":"<ns>/<method>","payload":{"args":{...}}}
 *   cancel:  {"type":"cancel","streamId":ID}
 *   item:    {"type":"item","streamId":ID,"value":V}
 *   end:     {"type":"end","streamId":ID}
 *   error:   {"type":"error","streamId":ID,"error":{"code","message","details"}}
 *
 * One socket carries every logical stream. The host heartbeats with Ping and
 * terminates a socket that misses two Pongs; the Node WebSocket answers Pong
 * automatically, so no application-level keepalive is needed.
 *
 * Pure Node (global WebSocket, Node >= 22); no vscode runtime import, so this
 * module stays unit-testable under node:test.
 */

import * as crypto from 'node:crypto'
import type { RemoteStreamClientMessage, RemoteStreamPayload, StreamId } from '../protocol/stream'
import {
  REMOTE_STREAM_MUX_PATH,
  StreamId as mintStreamId,
  encodeRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
} from '../protocol/stream'
import type { RpcError } from '../protocol/rpc'

/** Reconnect backoff floor and ceiling for the mux socket. */
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 30_000

/** A promise together with its settle functions. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

/**
 * Build a deferred promise.
 * Hand-rolled rather than `Promise.withResolvers` because this project's lib is
 * ES2023 (see tsconfig.json), where that helper does not exist.
 * @returns the promise and its resolvers.
 */
function deferred<T>(): Deferred<T> {
  const built: Partial<Deferred<T>> = {}
  built.promise = new Promise<T>((resolve, reject) => {
    built.resolve = resolve
    built.reject = reject
  })
  return built as Deferred<T>
}

/** Failure delivered to a stream consumer when its logical stream dies. */
export class RemoteStreamError extends Error {
  constructor(
    message: string,
    /** Host-side failure code when the host ended the stream with `error`. */
    readonly code?: string,
    /** Host-side structured details, when present. */
    readonly details?: unknown,
    /** True when the carrier (not the logical stream) is what failed. */
    readonly carrier = false,
  ) {
    super(message)
    this.name = 'RemoteStreamError'
  }
}

/** One open logical stream: an async sequence of host-produced values. */
export interface RemoteStream<T = unknown> {
  readonly id: StreamId
  /** Values produced by the host, in order, until `end` or a failure. */
  [Symbol.asyncIterator](): AsyncIterator<T>
  /** Ask the host to abort this stream; the iteration then settles. */
  cancel(): void
  /** Resolves when the stream has terminated for any reason. */
  readonly settled: Promise<void>
}

/** A pull-driven queue bridging socket callbacks to an async iterator. */
class StreamQueue<T> {
  private readonly buffer: T[] = []
  private waiter: (() => void) | null = null
  private ended = false
  private failure: unknown = undefined
  private readonly settled = deferred<void>()

  /** Current settlement promise for this queue. */
  get done(): Promise<void> {
    return this.settled.promise
  }

  /** True once the queue can produce nothing further. */
  get isSettled(): boolean {
    return this.ended
  }

  push(value: T): void {
    if (this.ended) return
    this.buffer.push(value)
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
    this.settled.resolve()
  }

  fail(error: unknown): void {
    if (this.ended) return
    this.failure = error
    this.end()
  }

  /** Take the next buffered value, waiting for one or for termination. */
  async next(): Promise<IteratorResult<T>> {
    while (true) {
      if (this.buffer.length > 0) return { done: false, value: this.buffer.shift() as T }
      if (this.ended) {
        if (this.failure !== undefined) throw this.failure
        return { done: true, value: undefined as never }
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/** Mutable bookkeeping for one logical stream owned by the mux. */
interface ActiveStream {
  queue: StreamQueue<unknown>
  /** True once the host is known to have stopped producing for this id. */
  finished: boolean
}

/** Diagnostics sink shape (the extension wires this to its OutputChannel). */
export type MuxLogger = (line: string) => void

/**
 * Node's WebSocket (undici) accepts a non-standard init object carrying the
 * handshake headers, which the WHATWG DOM type in this project's `lib` does not
 * model. This typed alias exposes that extension honestly at the single
 * construction site instead of casting the arguments to `never`.
 */
const WebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket

/**
 * Owns one mux WebSocket and every logical stream carried by it.
 *
 * Reconnection policy: the socket reconnects with exponential backoff, but
 * logical streams are NOT replayed. Streams carry generation-scoped state
 * (snapshots and baselines), so a consumer must reopen and re-apply instead of
 * assuming continuity; {@link onCarrierLost} is the hook for that.
 */
export class RemoteMuxClient {
  private socket: WebSocket | null = null
  /**
   * `open` frames issued while the socket was down, flushed on the next `open`.
   *
   * A logical stream outlives its carrier in the consumer's view: the carrier-lost
   * hook reopens streams, and that hook necessarily runs while the socket is
   * already null (the close handler clears it first). Dropping those frames meant
   * a reconnect delivered no baselines at all — the client reported itself
   * connected while receiving nothing, which is worse than staying disconnected.
   * Only `open` frames are queued; a `cancel` for a dead generation is meaningless.
   */
  private readonly deferredOpens: RemoteStreamClientMessage[] = []
  private readonly streams = new Map<string, ActiveStream>()
  private readonly carrierLostListeners = new Set<() => void>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private disposed = false
  private connected = false
  private readonly opened = deferred<void>()
  private loggedEverOpened = false

  /** Optional diagnostics sink. */
  log: MuxLogger | null = null

  constructor(
    /** `ws://127.0.0.1:<port>` base with no path and no trailing slash. */
    private readonly baseUrl: string,
    /** Optional signed browser-session cookie. */
    private cookie?: string,
    /** Optional Bearer token. */
    private token?: string,
  ) {
    // A caller that never awaits whenReady() must not produce an unhandled
    // rejection when the first handshake fails; this marks it handled while
    // still delivering the rejection to anyone who does await it.
    this.opened.promise.catch(() => undefined)
  }

  /** True while the socket is open. */
  get isConnected(): boolean {
    return this.connected
  }

  /** Resolves the first time the socket opens; rejects if it closes before. */
  whenReady(): Promise<void> {
    return this.opened.promise
  }

  /**
   * Register a callback invoked whenever the carrier drops while not disposed.
   * Consumers reopen their generations here.
   * @param listener - callback to invoke.
   * @returns unsubscribe function.
   */
  onCarrierLost(listener: () => void): () => void {
    this.carrierLostListeners.add(listener)
    return () => this.carrierLostListeners.delete(listener)
  }

  /**
   * Observe connection flips.
   * @param listener - callback receiving the new state.
   * @returns unsubscribe function.
   */
  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Open the socket. Safe to call repeatedly; a live socket is left alone. */
  connect(): void {
    if (this.disposed) return
    if (this.socket !== null && this.socket.readyState <= WebSocket.OPEN) return
    const headers: Record<string, string> = {}
    if (this.cookie !== undefined && this.cookie !== '') headers['Cookie'] = this.cookie
    if (this.token !== undefined && this.token !== '') headers['Authorization'] = `Bearer ${this.token}`
    const socket = new WebSocketWithHeaders(`${this.baseUrl}${REMOTE_STREAM_MUX_PATH}`, { headers })
    this.socket = socket
    socket.addEventListener('open', () => {
      this.loggedEverOpened = true
      this.reconnectAttempts = 0
      this.setConnected(true)
      this.opened.resolve()
      this.log?.('mux open')
      // Streams opened while this socket was still connecting start now.
      this.flushDeferredOpens()
    })
    socket.addEventListener('message', (event) => this.handleFrame(event))
    socket.addEventListener('error', () => {
      this.log?.('mux socket error')
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setConnected(false)
      const wasEver = this.loggedEverOpened
      // Every live logical stream dies with its carrier; consumers reopen.
      this.failAllStreams(new RemoteStreamError('mux socket closed', undefined, undefined, true))
      if (this.disposed) return
      if (!wasEver) this.opened.reject(new RemoteStreamError('mux socket failed to open'))
      for (const listener of this.carrierLostListeners) listener()
      this.scheduleReconnect()
    })
  }

  /**
   * Open one logical stream on the carrier.
   * The caller must have called {@link connect} first (or concurrently); frames
   * are queued by the host for the lifetime of the request.
   * @param endpoint - Remote endpoint, `<namespace>/<method>`.
   * @param args - method arguments, placed under `payload.args`.
   * @returns the stream handle.
   */
  openStream<T = unknown>(endpoint: string, args: Record<string, unknown> = {}): RemoteStream<T> {
    const id = mintStreamId(crypto.randomUUID())
    const queue = new StreamQueue<T>()
    const active: ActiveStream = { queue: queue as StreamQueue<unknown>, finished: false }
    this.streams.set(id, active)
    const payload: RemoteStreamPayload = { args }
    this.send({ type: 'open', streamId: id, endpoint, payload })
    const handle: RemoteStream<T> = {
      id,
      [Symbol.asyncIterator]: () => ({ next: () => queue.next() }),
      cancel: () => {
        if (active.finished) return
        active.finished = true
        this.send({ type: 'cancel', streamId: id })
        this.streams.delete(id)
        queue.end()
      },
      settled: queue.done,
    }
    return handle
  }

  /** Close the carrier and settle every live stream. */
  dispose(): void {
    this.disposed = true
    this.deferredOpens.length = 0
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.failAllStreams(new RemoteStreamError('mux client disposed', undefined, undefined, true))
    const socket = this.socket
    this.socket = null
    this.setConnected(false)
    socket?.close()
  }

  /**
   * Send one frame when the socket is open.
   *
   * `open` frames are queued for the next `open` event rather than dropped, so a
   * stream opened during a reconnect gap still starts. Anything else — a `cancel`
   * for a generation that is gone — is dropped: the host has already forgotten it.
   */
  private send(message: RemoteStreamClientMessage): void {
    const socket = this.socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      if (message.type === 'open') this.deferredOpens.push(message)
      return
    }
    socket.send(encodeRemoteStreamClientMessage(message))
  }

  /** Deliver every stream opened during the reconnect gap. */
  private flushDeferredOpens(): void {
    while (this.deferredOpens.length > 0) {
      const message = this.deferredOpens.shift()
      if (message === undefined) return
      this.send(message)
    }
  }

  /** Route one inbound frame to its stream, or ignore frames for unknown ids. */
  private handleFrame(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      this.log?.('mux: dropping binary frame')
      return
    }
    let frame
    try {
      frame = parseRemoteStreamServerMessage(event.data)
    } catch (error) {
      this.log?.(`mux: dropping malformed frame: ${String(error)}`)
      return
    }
    const active = this.streams.get(frame.streamId)
    if (active === undefined) return
    if (frame.type === 'item') {
      active.queue.push(frame.value)
      return
    }
    active.finished = true
    this.streams.delete(frame.streamId)
    if (frame.type === 'end') {
      active.queue.end()
      return
    }
    const failure: RpcError = frame.error
    active.queue.fail(new RemoteStreamError(failure.message, failure.code, failure.details))
  }

  /** Settle every live stream with one failure (carrier loss or disposal). */
  private failAllStreams(error: Error): void {
    const live = [...this.streams.values()]
    this.streams.clear()
    for (const active of live) {
      active.finished = true
      active.queue.fail(error)
    }
  }

  /** Arm one reconnect attempt with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_CAP_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Notify status listeners on an actual flip only. */
  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const listener of this.statusListeners) listener(connected)
  }
}
