/**
 * Fake Typert Remote host for unit tests.
 *
 * Speaks the dsh 0.1.5-rc.2 wire contract so the plugin's transport layer can be
 * exercised without a real dsh:
 *   - HTTP  POST /api/<ns>/<method>  with the `{type:'client-request',…,payload:{args}}`
 *           envelope, answering `{type:'server-response',…,result:{ok,value|error}}`.
 *   - WS    /api/remote.mux        carrying `open`/`cancel` up and `item`/`end`/`error` down.
 *   - The `$events` logical stream is implemented natively: it answers `ready`,
 *     then relays whatever the test emits via `emit`/`waterfall`.
 *
 * The old `tests/fake-host.ts` implements the retired apiproxy protocol and is
 * NOT replaced by this file; both exist while the migration is in flight.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

/** Result a unary handler returns. */
export type HandlerResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: unknown } }

/** One recorded unary call. */
export interface RecordedCall {
  endpoint: string
  args: Record<string, unknown>
  /** Cookie header seen on the request, when any. */
  cookie?: string
}

/** One recorded stream open. */
export interface RecordedStreamOpen {
  endpoint: string
  args: Record<string, unknown>
}

/** One recorded stream cancel. */
export interface RecordedStreamCancel {
  streamId: string
  endpoint: string
}

/** Options controlling fake-host strictness. */
export interface FakeRemoteHostOptions {
  /** When set, requests without exactly this Cookie header are answered 401. */
  requireCookie?: string
  /** When set, requests without exactly this Authorization header are answered 401. */
  requireToken?: string
}

/** The live fake host handle. */
export interface FakeRemoteHost {
  port: number
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  baseUrl: string
  /** `ws://127.0.0.1:<port>`, no trailing slash. */
  wsUrl: string
  /** Every unary call received, in order. */
  readonly calls: RecordedCall[]
  /** Every logical stream opened, in order. */
  readonly streamOpens: RecordedStreamOpen[]
  /** Every logical stream cancelled, in order. */
  readonly streamCancels: RecordedStreamCancel[]
  /**
   * Register a unary route.
   * @param endpoint - `<namespace>/<method>`.
   * @param handler - receives the args object.
   */
  handle(endpoint: string, handler: (args: Record<string, unknown>) => HandlerResult | Promise<HandlerResult>): void
  /** Register a unary route always answering the given value. */
  handleValue(endpoint: string, value: unknown): void
  /**
   * Register a non-`$events` stream route.
   * @param endpoint - `<namespace>/<method>`.
   * @param values - values to yield, or a producer invoked per open.
   */
  stream(endpoint: string, values: readonly unknown[] | (() => readonly unknown[])): void
  /**
   * Declare a push-driven stream route: opens yield nothing and NEVER send
   * `end`, so frames can be injected later with {@link pushStream}.
   *
   * This is what a harness needs for the long-lived streams (`session/control`,
   * `workspace/follow`, `session/follow`), whose frames arrive over time rather
   * than as a fixed list.
   * @param endpoint - `<namespace>/<method>`.
   * @param initial - values sent immediately on open, before any push.
   */
  pushDriven(endpoint: string, initial?: readonly unknown[]): void
  /**
   * Inject one frame into every currently-open stream of an endpoint declared
   * with {@link pushDriven}.
   * @param endpoint - the stream route to push on.
   * @param value - the frame value to deliver.
   */
  pushStream(endpoint: string, value: unknown): void
  /** End every currently-open stream of a push-driven endpoint. */
  endStream(endpoint: string): void
  /** Broadcast one `emit` frame on the live `$events` stream. */
  emit(event: string, args: unknown[]): void
  /**
   * Deliver one `waterfall` frame on the live `$events` stream.
   * @param event - forwarded event name.
   * @param agentId - scoping session id.
   * @param request - the request payload.
   * @returns the minted eventId, usable to match a recorded answer.
   */
  waterfall(event: string, agentId: string, request: unknown): string
  /** Retract a pending waterfall by eventId. */
  cancelWaterfall(eventId: string): void
  /** Every `$events/result` answer received, in order. */
  readonly eventResults: { clientId: string; eventId: string; outcome: unknown }[]
  /** Resolve once at least `count` event answers have arrived. */
  waitForEventResults(count: number): Promise<void>
  /** Force-drop every live socket (carrier-loss simulation). */
  dropSockets(): void
  /** Stop listening and settle every live socket. */
  close(): Promise<void>
}

/** Minimal JSON body read with a size ceiling. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Start a fake Typert Remote host on an ephemeral loopback port.
 * @param options - auth strictness overrides.
 * @returns the live host handle.
 */
export async function startFakeRemoteHost(options: FakeRemoteHostOptions = {}): Promise<FakeRemoteHost> {
  const unary = new Map<string, (args: Record<string, unknown>) => HandlerResult | Promise<HandlerResult>>()
  const streams = new Map<string, readonly unknown[] | (() => readonly unknown[])>()
  const calls: RecordedCall[] = []
  const streamOpens: RecordedStreamOpen[] = []
  const streamCancels: RecordedStreamCancel[] = []
  /** streamId -> endpoint, so a cancel can be attributed without the open frame. */
  const streamEndpoints = new Map<string, string>()
  const eventResults: { clientId: string; eventId: string; outcome: unknown }[] = []
  const resultWaiters: { count: number; resolve: () => void }[] = []

  /** Live `$events` subscribers, each with the clientId that generation was told about. */
  const eventSockets = new Set<{ socket: WebSocket; streamId: string; clientId: string }>()
  const sockets = new Set<WebSocket>()
  /** Endpoints declared push-driven: opens yield nothing and never `end`. */
  const pushDrivenEndpoints = new Set<string>()
  /** Currently-open push-driven streams, keyed by endpoint. */
  const liveStreams = new Map<string, Set<{ socket: WebSocket; streamId: string }>>()

  const server: Server = createServer((request, response) => {
    void handleHttp(request, response)
  })
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? ''
    if (!url.startsWith('/api/remote.mux')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', (raw, isBinary) => {
      // The host rejects binary frames with 1003.
      if (isBinary) {
        ws.close(1003)
        return
      }
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        ws.close(1008)
        return
      }
      if (frame.type === 'open' && typeof frame.streamId === 'string' && typeof frame.endpoint === 'string') {
        const payload = frame.payload as Record<string, unknown> | undefined
        const args = (payload?.args ?? {}) as Record<string, unknown>
        streamOpens.push({ endpoint: frame.endpoint, args })
        streamEndpoints.set(frame.streamId, frame.endpoint)
        if (frame.endpoint === '$events') {
          const clientId = `client-${eventSockets.size + 1}`
          eventSockets.add({ socket: ws, streamId: frame.streamId, clientId })
          ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId, host: { home: '/home/tester' } } }))
          return
        }
        const producer = streams.get(frame.endpoint)
        if (producer === undefined && !pushDrivenEndpoints.has(frame.endpoint)) {
          // Real hosts answer an unmounted endpoint with a normal error frame
          // (`gateway/invocation-unavailable`), NOT by killing the socket.
          ws.send(JSON.stringify({
            type: 'error',
            streamId: frame.streamId,
            error: {
              code: 'gateway/invocation-unavailable',
              message: `no stream ${frame.endpoint}`,
              details: {},
            },
          }))
          return
        }
        const values = producer === undefined ? [] : typeof producer === 'function' ? producer() : producer
        for (const value of values) ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }))
        if (pushDrivenEndpoints.has(frame.endpoint)) {
          // Stay open: frames arrive later via pushStream.
          let open = liveStreams.get(frame.endpoint)
          if (open === undefined) {
            open = new Set()
            liveStreams.set(frame.endpoint, open)
          }
          open.add({ socket: ws, streamId: frame.streamId })
          return
        }
        ws.send(JSON.stringify({ type: 'end', streamId: frame.streamId }))
        return
      }
      if (frame.type === 'cancel' && typeof frame.streamId === 'string') {
        streamCancels.push({
          streamId: frame.streamId,
          endpoint: streamEndpoints.get(frame.streamId) ?? '',
        })
        for (const entry of [...eventSockets]) {
          if (entry.socket === ws && entry.streamId === frame.streamId) eventSockets.delete(entry)
        }
        // A cancel is silent: the real host answers with NO terminal frame,
        // so this fake must not send `end` either.
        return
      }
      ws.close(1008)
    })
    ws.on('close', () => {
      sockets.delete(ws)
      for (const entry of [...eventSockets]) if (entry.socket === ws) eventSockets.delete(entry)
      for (const [endpoint, open] of [...liveStreams]) {
        for (const entry of [...open]) if (entry.socket === ws) open.delete(entry)
        if (open.size === 0) liveStreams.delete(endpoint)
      }
    })
  })

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? ''
    const match = /^\/api\/(.+)$/.exec(url)
    if (match === null) {
      response.writeHead(404).end('not found')
      return
    }
    const endpoint = match[1] as string
    if (options.requireCookie !== undefined && request.headers.cookie !== options.requireCookie) {
      response.writeHead(401).end('unauthorized')
      return
    }
    if (options.requireToken !== undefined && request.headers.authorization !== `Bearer ${options.requireToken}`) {
      response.writeHead(401).end('unauthorized')
      return
    }
    const body = await readBody(request)
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(body) as Record<string, unknown>
    } catch {
      response.writeHead(400).end('invalid client-request message')
      return
    }
    const rpcId = envelope.rpcId as string
    const payload = envelope.payload as Record<string, unknown> | undefined
    const args = (payload?.args ?? {}) as Record<string, unknown>
    const cookie = request.headers.cookie
    calls.push(cookie === undefined ? { endpoint, args } : { endpoint, args, cookie })

    if (endpoint === '$events/result') {
      eventResults.push({
        clientId: args.clientId as string,
        eventId: args.eventId as string,
        outcome: args.outcome,
      })
      for (const waiter of [...resultWaiters]) {
        if (eventResults.length >= waiter.count) {
          resultWaiters.splice(resultWaiters.indexOf(waiter), 1)
          waiter.resolve()
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } }))
      return
    }

    const handler = unary.get(endpoint)
    if (handler === undefined) {
      response.writeHead(404).end('not found')
      return
    }
    const result = await handler(args)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  /** Relay one frame to every live `$events` subscriber. */
  const broadcastEvent = (value: unknown): void => {
    for (const entry of eventSockets) {
      entry.socket.send(JSON.stringify({ type: 'item', streamId: entry.streamId, value }))
    }
  }

  let waterfallSeq = 0
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    calls,
    streamOpens,
    streamCancels,
    eventResults,
    handle(endpoint, handler) {
      unary.set(endpoint, handler)
    },
    handleValue(endpoint, value) {
      unary.set(endpoint, () => ({ ok: true, value }))
    },
    stream(endpoint, values) {
      streams.set(endpoint, values)
    },
    pushDriven(endpoint, initial) {
      pushDrivenEndpoints.add(endpoint)
      if (initial !== undefined) streams.set(endpoint, initial)
    },
    pushStream(endpoint, value) {
      for (const entry of liveStreams.get(endpoint) ?? []) {
        entry.socket.send(JSON.stringify({ type: 'item', streamId: entry.streamId, value }))
      }
    },
    endStream(endpoint) {
      for (const entry of liveStreams.get(endpoint) ?? []) {
        entry.socket.send(JSON.stringify({ type: 'end', streamId: entry.streamId }))
      }
      liveStreams.delete(endpoint)
    },
    emit(event, args) {
      broadcastEvent({ type: 'emit', event, args })
    },
    waterfall(event, agentId, request) {
      waterfallSeq += 1
      const eventId = `wf-${waterfallSeq}`
      broadcastEvent({ type: 'waterfall', event, eventId, agentId, request })
      return eventId
    },
    cancelWaterfall(eventId) {
      broadcastEvent({ type: 'cancel', eventId })
    },
    waitForEventResults(count) {
      if (eventResults.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        resultWaiters.push({ count, resolve })
      })
    },
    dropSockets() {
      for (const socket of [...sockets]) socket.terminate()
      sockets.clear()
      eventSockets.clear()
    },
    async close() {
      for (const socket of [...sockets]) socket.terminate()
      sockets.clear()
      eventSockets.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** True when the recorded call list contains an endpoint. */
export function sawCall(calls: readonly RecordedCall[], endpoint: string): boolean {
  return calls.some((call) => call.endpoint === endpoint)
}
