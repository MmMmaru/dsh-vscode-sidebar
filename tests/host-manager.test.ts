/**
 * Unit tests for HostManager: probe semantics, port rollover (端口顺延), and the
 * capability check that replaced version comparison.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2): these tests used to drive an apiproxy fake
 * host that answered `POST /api/host.describe` with a `{version}`. That endpoint
 * no longer exists, so `probe()` could not see the fixture at all — and because
 * `ensureHost()` falls through to SPAWNING when no port answers, the rollover test
 * silently tried to cold-start a real dsh and hung for minutes. Everything here
 * now speaks Typert Remote, and no test can reach a real `dsh` process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { HostManager } from '../src/extension/host-manager'
import { consecutivePorts } from './fake-host'
import { startFakeRemoteHost } from './fake-remote-host'

/** Silent logger satisfying the OutputChannel subset HostManager consumes. */
const silentLog = { appendLine: (_line: string): void => undefined }

/** Start a listener that answers nothing useful (a port that is not a gateway). */
async function startDummyListener(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => res.writeHead(404).end())
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * Start a minimal Typert Remote responder on an explicit port.
 *
 * Needed because the shared fake host always binds an ephemeral port, and the
 * rollover test must place a live host on the exact port after an occupied one.
 */
async function startGatewayOn(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as { rpcId: string; method: string }
      if (req.method !== 'POST' || req.url !== `/api/${body.method}`) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: [] },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('probe returns false on a closed port and true on a Typert Remote host', async () => {
  const fake = await startFakeRemoteHost()
  const manager = new HostManager(silentLog)
  try {
    fake.handleValue('session/list', [])
    assert.equal(await manager.probe(fake.port), true)
    // Port 1 is privileged and never bound in this environment.
    assert.equal(await manager.probe(1), false)
  } finally {
    await fake.close()
  }
})

test('probe requires a well-formed ok envelope, not just an HTTP 200', async () => {
  // A listener that answers 200 with an unrelated JSON body must NOT look like a
  // host: the old check accepted any 200 without reading the body, which is how a
  // wrong-version host reported itself as compatible.
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hello: 'world' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const manager = new HostManager(silentLog)
  try {
    assert.equal(await manager.probe(port), false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('probe rejects a non-dsh listener on the port', async () => {
  const dummy = await startDummyListener()
  const manager = new HostManager(silentLog)
  try {
    assert.equal(await manager.probe(dummy.port), false)
  } finally {
    await dummy.close()
  }
})

test('ensureHost skips an occupied non-dsh port and uses the next live host (端口顺延)', async () => {
  const [base] = await consecutivePorts()
  const dummy = await startDummyListener(base)
  const gateway = await startGatewayOn(base + 1)
  const manager = new HostManager(silentLog)
  manager.basePort = base
  try {
    const info = await manager.ensureHost()
    assert.equal(info.port, base + 1)
    assert.equal(info.spawnedByUs, false)
  } finally {
    await gateway.close()
    await dummy.close()
  }
})

test('checkVersion passes on a live capability endpoint and explains each refusal', async () => {
  const manager = new HostManager(silentLog)

  // A reachable gateway is compatible. There is no version to compare any more:
  // no Remote method reports one, so capability IS the contract.
  const good = await startFakeRemoteHost()
  try {
    good.handleValue('session/list', [])
    assert.equal(await manager.checkVersion({ port: good.port, spawnedByUs: false }), null)
  } finally {
    await good.close()
  }

  // A 404 means the listener predates the gateway (apiproxy was removed in
  // 0.1.2-rc.1); the message must say so rather than blame the connection.
  const stale = await startDummyListener()
  try {
    const warning = await manager.checkVersion({ port: stale.port, spawnedByUs: false })
    assert.ok(warning !== null && warning.includes('404'), String(warning))
    assert.ok(warning.includes('Typert Remote'), String(warning))
  } finally {
    await stale.close()
  }

  // A 401 means the listener is a gateway but the credential was rejected.
  const guarded = await startFakeRemoteHost({ requireToken: 'right-token' })
  try {
    guarded.handleValue('session/list', [])
    const warning = await manager.checkVersion({ port: guarded.port, spawnedByUs: false })
    assert.ok(warning !== null && warning.includes('401'), String(warning))
    assert.ok(warning.includes('credentials'), String(warning))
    // The same host passes once the token is supplied.
    assert.equal(await manager.checkVersion({ port: guarded.port, spawnedByUs: false, token: 'right-token' }), null)
  } finally {
    await guarded.close()
  }

  // A closed port is a connection failure, which is a different message again.
  const closed = await manager.checkVersion({ port: 1, spawnedByUs: false })
  assert.ok(closed !== null && closed.includes('无法连接'), String(closed))
})

test('probe and checkVersion honour token authentication', async () => {
  const token = 'test-secret-token'
  const fake = await startFakeRemoteHost({ requireToken: token })
  const manager = new HostManager(silentLog)
  try {
    fake.handleValue('session/list', [])
    // Without the token the gateway refuses, so the port must not look like a host.
    assert.equal(await manager.probe(fake.port), false)
    assert.equal(await manager.probe(fake.port, token), true)
    assert.equal(await manager.checkVersion({ port: fake.port, spawnedByUs: false, token }), null)
  } finally {
    await fake.close()
  }
})
