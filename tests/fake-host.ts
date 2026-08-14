/**
 * Test helper: an in-process fake dsh web host.
 * Implements just enough of the wire protocol for unit tests:
 *   - POST /api/host.describe -> ok ServerResponse with a configurable version
 *   - POST /api/<method>      -> canned or echo responses
 *   - POST /api/respond       -> records the ClientResponse, answers a receipt
 *   - WS upgrade on /api/events.mux and /api/events.host with frame push support
 * Hardcoded fixtures per project convention.
 */

import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** One recorded unary call the fake host received. */
export interface RecordedCall {
  method: string
  rpcId: string
  payload: unknown
}

/** Options for the fake host's canned behavior. */
export interface FakeHostOptions {
  /** Version reported by host.describe. */
  version?: string
  /** Answer unary RPCs with a business error instead of an ok value. */
  failRpcs?: boolean
  /** Echo a wrong rpcId in unary responses (protocol violation for testing). */
  corruptRpcId?: boolean
}

/** The fake host handle: server, sockets, and captured traffic. */
export interface FakeHost {
  server: Server
  port: number
  /** Every unary call received, in order. */
  calls: RecordedCall[]
  /** Every client-response received on /api/respond, in order. */
  responds: Array<{ rpcId: string; result: unknown }>
  /** Currently upgraded WS sockets per path. */
  sockets: Map<string, Duplex[]>
  /** Push one server-request frame to every socket on a path. */
  pushFrame(path: string, frame: { rpcId: string; payload: unknown }): void
  /** Hard-close every socket on a path (simulates a host crash). */
  dropSockets(path: string): void
  /** Resolves once a NEW socket upgrades on the path (for reconnect assertions). */
  waitForUpgrade(path: string): Promise<void>
  close(): Promise<void>
}

/**
 * Start a fake dsh host on an ephemeral loopback port.
 * @param options - canned behaviors.
 * @returns the fake host handle.
 */
export async function startFakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const calls: RecordedCall[] = []
  const responds: Array<{ rpcId: string; result: unknown }> = []
  const sockets = new Map<string, Duplex[]>()
  const upgradeWaiters = new Map<string, Array<() => void>>()

  const server = createServer((req, res) => {
    const url = req.url
    if (req.method !== 'POST' || url === undefined || !url.startsWith('/api/')) {
      res.writeHead(404).end('not found')
      return
    }
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as { type: string; rpcId: string; method?: string; payload?: unknown; result?: unknown }
      if (url === '/api/respond') {
        responds.push({ rpcId: body.rpcId, result: body.result })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true }))
        return
      }
      const method = url.slice('/api/'.length)
      calls.push({ method, rpcId: body.rpcId, payload: body.payload })
      const rpcId = options.corruptRpcId === true ? 'corrupted-id' : body.rpcId
      const result = options.failRpcs === true
        ? { ok: false, error: { code: 'internal', message: `fake failure for ${method}`, details: {} } }
        : {
          ok: true,
          value: method === 'host.describe'
            ? { version: options.version ?? '0.1.0-rc.6', cwd: '/tmp', attachedSessions: 0, canOpenPath: false }
            : { items: [] },
        }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response',
        rpcId,
        result,
      }))
    })
  })

  server.on('upgrade', (req, socket: Duplex, head) => {
    const path = req.url ?? ''
    if (path !== '/api/events.mux' && path !== '/api/events.host') {
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key'] as string
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (head.length > 0) socket.unshift(head)
    const list = sockets.get(path) ?? []
    list.push(socket)
    sockets.set(path, list)
    for (const wake of upgradeWaiters.get(path) ?? []) wake()
    upgradeWaiters.delete(path)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    server,
    port,
    calls,
    responds,
    sockets,
    pushFrame(path: string, frame: { rpcId: string; payload: unknown }): void {
      const data = Buffer.from(JSON.stringify({ type: 'server-request', ...frame }))
      // Unmasked server->client text frame (payloads stay below 126 bytes in these tests? No —
      // encode length properly up to 16 bits).
      const header = data.length < 126
        ? Buffer.from([0x81, data.length])
        : Buffer.from([0x81, 126, (data.length >> 8) & 0xff, data.length & 0xff])
      for (const socket of sockets.get(path) ?? []) socket.write(Buffer.concat([header, data]))
    },
    dropSockets(path: string): void {
      for (const socket of sockets.get(path) ?? []) socket.destroy()
      sockets.set(path, [])
    },
    waitForUpgrade(path: string): Promise<void> {
      return new Promise((resolve) => {
        const list = upgradeWaiters.get(path) ?? []
        list.push(resolve)
        upgradeWaiters.set(path, list)
      })
    },
    async close(): Promise<void> {
      for (const list of sockets.values()) for (const socket of list) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

/**
 * Reserve two consecutive free loopback ports (for port-rollover tests).
 * @returns [base, base+1] with both ports currently free.
 */
export async function consecutivePorts(): Promise<[number, number]> {
  const net = await import('node:net')
  for (let base = 41000; base < 60000; base++) {
    const ok = await Promise.all([base, base + 1].map((port) => new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })))
    if (ok.every(Boolean)) return [base, base + 1]
  }
  throw new Error('no consecutive free ports found')
}
