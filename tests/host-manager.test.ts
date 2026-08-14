/**
 * Unit tests for HostManager: probe semantics, port rollover (顺延), and the
 * version compatibility check. All traffic hits an in-process fake host.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { HostManager } from '../src/extension/host-manager'
import { consecutivePorts, startFakeHost } from './fake-host'

/** Silent logger satisfying the OutputChannel subset HostManager consumes. */
const silentLog = { appendLine: (_line: string): void => undefined }

test('probe returns false on a closed port and true on a dsh host', async () => {
  const fake = await startFakeHost()
  const manager = new HostManager(silentLog)
  try {
    assert.equal(await manager.probe(fake.port), true)
    assert.equal(await manager.probe(1), false)
  } finally {
    await fake.close()
  }
})

test('probe rejects a non-dsh listener on the port', async () => {
  const dummy: Server = createServer((_req, res) => res.writeHead(404).end())
  await new Promise<void>((resolve) => dummy.listen(0, '127.0.0.1', resolve))
  const address = dummy.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const manager = new HostManager(silentLog)
  try {
    assert.equal(await manager.probe(port), false)
  } finally {
    await new Promise<void>((resolve) => dummy.close(() => resolve()))
  }
})

test('ensureHost skips an occupied non-dsh port and uses the next live host (端口顺延)', async () => {
  const [base] = await consecutivePorts()
  // Occupy base with a dummy listener that never answers like dsh.
  const dummy: Server = createServer((_req, res) => res.writeHead(404).end())
  await new Promise<void>((resolve) => dummy.listen(base, '127.0.0.1', resolve))
  // A real dsh-shaped host sits on base+1.
  const fakeOnNext = await startFakeHostOn(base + 1)
  const manager = new HostManager(silentLog)
  manager.basePort = base
  try {
    const info = await manager.ensureHost()
    assert.equal(info.port, base + 1)
    assert.equal(info.spawnedByUs, false)
  } finally {
    await fakeOnNext.close()
    await new Promise<void>((resolve) => dummy.close(() => resolve()))
  }
})

/** startFakeHost bound to an explicit port (rollover fixture). */
async function startFakeHostOn(port: number) {
  const { createServer: create } = await import('node:http')
  const server = create((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/host.describe') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as { rpcId: string }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/tmp', attachedSessions: 0, canOpenPath: false } },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('checkVersion accepts 0.1.0-rc.* / 0.0.1 and warns on other versions', async () => {
  const manager = new HostManager(silentLog)
  for (const version of ['0.1.0-rc.6', '0.0.1']) {
    const good = await startFakeHost({ version })
    try {
      assert.equal(await manager.checkVersion({ port: good.port, spawnedByUs: false }), null)
    } finally {
      await good.close()
    }
  }
  const bad = await startFakeHost({ version: '9.9.9' })
  try {
    const warning = await manager.checkVersion({ port: bad.port, spawnedByUs: false })
    assert.ok(warning !== null && warning.includes('9.9.9'))
  } finally {
    await bad.close()
  }
})
