/**
 * HostManager readiness tests.
 *
 * REGRESSION (measured on a live host, 4 of 12 recorded startups): `probe()`
 * accepted a host as soon as `settings/describe` answered, but that route is owned
 * by `dsh-api-settings-controller`, which mounts BEFORE `dsh-api-session-controller`
 * / `dsh-api-workspace-controller`. `ensureHost()` therefore reported "ready" while
 * `session/control` and `workspace/follow` still answered
 * `gateway/service-unavailable`, and the sidebar stayed empty until a manual window
 * reload. Readiness has to ask for the CAPABILITY (`session/list`), not for
 * "something answered".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostManager } from '../src/extension/host-manager'

let portCursor = 44_000

/** A loopback port nothing is listening on. */
async function nextFreePort(): Promise<number> {
  const net = await import('node:net')
  for (; portCursor < 45_000; portCursor++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(portCursor, '127.0.0.1')
    })
    if (free) return portCursor++
  }
  throw new Error('no free port in the host-readiness test window')
}

/** What one simulated host answers per route. */
interface RouteBehaviour {
  /** Reply for `settings/describe`: the route the loose probe uses. */
  settings: 'ok' | 'absent'
  /** How the capability route behaves on its first `delayCalls` calls. */
  capability: 'ok' | 'absent' | 'unavailable'
  /** Number of leading capability calls that fail before it succeeds. */
  delayCalls?: number
  /**
   * Answer the retired apiproxy `host.describe`.
   *
   * This is what makes a 404 FATAL rather than "not mounted yet": both an aged host
   * and a still-booting one 404 the capability route, and only the aged host answers
   * the legacy endpoint.
   */
  legacyHostDescribe?: boolean
}

/**
 * A host that separates the two routes deliberately.
 * @param behaviour - per-route replies.
 * @returns the port and a close function.
 */
async function startSplitHost(behaviour: RouteBehaviour): Promise<{ port: number; close: () => Promise<void> }> {
  let capabilityCalls = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as { rpcId: string; method: string }
      const ok = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value },
        }))
      }
      if (req.url === '/api/host.describe' && behaviour.legacyHostDescribe === true) {
        ok({ version: '0.1.1-rc.2' })
        return
      }
      if (req.url === '/api/settings/describe' && behaviour.settings === 'ok') {
        ok({ writable: true })
        return
      }
      if (req.url === '/api/session/list' && behaviour.capability === 'ok' && req.method === 'POST') {
        capabilityCalls += 1
        if (capabilityCalls > (behaviour.delayCalls ?? 0)) {
          ok({ items: [] })
          return
        }
      }
      if (
        req.url === '/api/session/list'
        && (behaviour.capability === 'unavailable'
          || (behaviour.capability === 'ok' && capabilityCalls <= (behaviour.delayCalls ?? 0)))
      ) {
        // Exactly what the gateway answers while the controller service is booting.
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: false,
            error: {
              code: 'gateway/service-unavailable',
              message: 'typert gateway: session/list: active Service "sessionController" is unavailable',
              details: {},
            },
          },
        }))
        return
      }
      res.writeHead(404).end('not found')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Collector logger: HostManager logs its decisions here. */
function collectingLog(): { lines: string[]; log: { appendLine(line: string): void } } {
  const lines: string[] = []
  return { lines, log: { appendLine: (line: string) => lines.push(line) } }
}

test('probe is satisfied by settings/describe while the capability route still refuses', async () => {
  // This asymmetry IS the root cause: it is why "the port answered" did not mean
  // "the streams will work".
  const host = await startSplitHost({ settings: 'ok', capability: 'unavailable' })
  const manager = new HostManager({ appendLine: (): void => undefined })
  try {
    assert.equal(await manager.probe(host.port), true, 'the loose probe is satisfied')
    const warning = await manager.checkVersion({ port: host.port, spawnedByUs: false })
    assert.ok(warning !== null, 'the capability check is NOT')
    // The wording carries the gateway's message, not its code: the code is what the
    // mux retries on, and the UI gets the human-readable half.
    assert.match(warning, /unavailable/)
    assert.match(warning, /sessionController/, 'the message names the missing service')
  } finally {
    await host.close()
  }
})

test('checkVersion classifies a booting service as retryable and an absent route as fatal', async () => {
  const manager = new HostManager({ appendLine: (): void => undefined })

  const booting = await startSplitHost({ settings: 'ok', capability: 'unavailable' })
  try {
    const warning = await manager.checkVersion({ port: booting.port, spawnedByUs: false })
    assert.ok(warning !== null)
    // Retryable: the wording must NOT tell the user to upgrade dsh.
    assert.doesNotMatch(warning, /版本过旧/)
  } finally {
    await booting.close()
  }

  const aged = await startSplitHost({ settings: 'ok', capability: 'absent', legacyHostDescribe: true })
  try {
    const warning = await manager.checkVersion({ port: aged.port, spawnedByUs: false })
    assert.ok(warning !== null)
    assert.match(warning, /404/)
    assert.match(warning, /版本过旧/, 'a 404 route is permanent, so it says so')
  } finally {
    await aged.close()
  }

  const ready = await startSplitHost({ settings: 'ok', capability: 'ok' })
  try {
    assert.equal(await manager.checkVersion({ port: ready.port, spawnedByUs: false }), null)
  } finally {
    await ready.close()
  }
})

test('a 404 during startup is treated as "not mounted yet", not as an aged host', async () => {
  // Measured on a real spawn: attempt 1 refused the connection and attempt 2 (500ms
  // later) answered 404, because the HTTP server binds before the connection plugin
  // mounts its routes. Calling that "该 dsh 版本过旧" aborted a perfectly good startup.
  const host = await startSplitHost({ settings: 'absent', capability: 'absent' })
  const manager = new HostManager({ appendLine: (): void => undefined })
  try {
    const warning = await manager.checkVersion({ port: host.port, spawnedByUs: false })
    assert.ok(warning !== null)
    assert.doesNotMatch(warning, /版本过旧/, 'a bare 404 is ambiguous, so it must not claim an old build')
    assert.match(warning, /404/)
    assert.match(warning, /启动/, 'it says the host may still be starting')
  } finally {
    await host.close()
  }
})

test('ensureHost waits for the capability on a host it just found, then adopts that port', async () => {
  // The host is mid-boot: it answers the probe but not the capability yet. Adopting
  // it immediately produced the permanently-empty sidebar; skipping it would spawn a
  // duplicate backend next to a host that was about to be fine. So it waits.
  const host = await startSplitHost({ settings: 'ok', capability: 'ok', delayCalls: 1 })
  const { lines, log } = collectingLog()
  const manager = new HostManager(log)
  manager.basePort = host.port
  try {
    const info = await manager.ensureHost()
    assert.equal(info.port, host.port)
    assert.equal(info.spawnedByUs, false, 'adopted, not spawned')
    assert.ok(
      lines.some((line) => line.includes(`found existing dsh host on 127.0.0.1:${host.port}`)),
      `expected an adoption log line, got: ${lines.join(' | ')}`,
    )
  } finally {
    await manager.dispose()
    await host.close()
  }
})

/**
 * A stub `dsh` binary whose `/api/session/list` reply is scripted.
 * @param mode - `booting` refuses the capability twice, `aged` 404s it.
 * @returns the temp bin dir plus a reader for the number of capability calls served.
 */
async function installScriptedStub(mode: 'booting' | 'booting404' | 'aged'): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scripted-bin-'))
  const counter = join(dir, 'calls.txt')
  const source = [
    '#!/usr/bin/env node',
    "const http = require('node:http')",
    "const fs = require('node:fs')",
    "const argOf = (name) => process.argv[process.argv.indexOf(name) + 1]",
    `const counter = ${JSON.stringify(counter)}`,
    'const port = Number(argOf("--port"))',
    `const mode = ${JSON.stringify(mode)}`,
    'http.createServer((req, res) => {',
    "  let raw = ''",
    "  req.on('data', (chunk) => { raw += chunk })",
    "  req.on('end', () => {",
    '    const body = JSON.parse(raw)',
    "    const served = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0",
    "    if (req.url === '/api/session/list') {",
    '      const byNow = served + 1',
    "      fs.writeFileSync(counter, String(byNow))",
    "      if (mode === 'aged') { res.writeHead(404).end('not found'); return }",
    "      if (mode === 'booting404' && byNow <= 2) { res.writeHead(404).end('not found'); return }",
    "      if (mode === 'booting' && byNow <= 2) {",
    "        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({",
    "          type: 'server-response', rpcId: body.rpcId,",
    "          result: { ok: false, error: { code: 'gateway/service-unavailable', message: 'active Service \"sessionController\" is unavailable', details: {} } },",
    '        }))',
    '        return',
    '      }',
    "      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({",
    "        type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } },",
    '      }))',
    '      return',
    '    }',
    "    if (mode === 'aged' && req.url === '/api/host.describe') {",
    "      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({",
    "        type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { version: '0.1.1-rc.2' } },",
    '      }))',
    '      return',
    '    }',
    "    // A booting host has the listener up but NO routes mounted: everything 404s,",
    "    // including the retired host.describe (which is what makes the 404 ambiguous).",
    "    res.writeHead(404).end('not found')",
    '  })',
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n')
  await writeFile(join(dir, 'dsh'), source)
  await chmod(join(dir, 'dsh'), 0o755)
  return { dir }
}

test('spawn waits for the capability endpoint instead of racing the controllers', async () => {
  const base = await nextFreePort()
  const originalPath = process.env.PATH
  const { dir } = await installScriptedStub('booting')
  const { lines, log } = collectingLog()
  let manager: HostManager | null = null
  try {
    process.env.PATH = `${dir}:${originalPath ?? ''}`
    manager = new HostManager(log)
    const info = await manager.spawn(base)
    assert.equal(info.spawnedByUs, true)
    assert.equal(info.port, base)
    // The first two capability attempts were refused, so the wait must be visible.
    assert.ok(
      lines.some((line) => line.includes('waiting for session/list')),
      `expected a waiting log line, got: ${lines.join(' | ')}`,
    )
  } finally {
    await manager?.dispose()
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('spawn waits through a 404 route and succeeds once the host finishes mounting', async () => {
  // The exact shape of the measured startup: refused, then 404, then serving.
  const base = await nextFreePort()
  const originalPath = process.env.PATH
  const { dir } = await installScriptedStub('booting404')
  let manager: HostManager | null = null
  try {
    process.env.PATH = `${dir}:${originalPath ?? ''}`
    manager = new HostManager({ appendLine: (): void => undefined })
    const info = await manager.spawn(base)
    assert.equal(info.spawnedByUs, true)
    assert.equal(info.port, base)
  } finally {
    await manager?.dispose()
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('spawn fails fast with the actionable message when the host serves no Remote surface', async () => {
  const base = await nextFreePort()
  const originalPath = process.env.PATH
  const { dir } = await installScriptedStub('aged')
  let manager: HostManager | null = null
  const startedAt = Date.now()
  try {
    process.env.PATH = `${dir}:${originalPath ?? ''}`
    manager = new HostManager({ appendLine: (): void => undefined })
    await assert.rejects(() => manager!.spawn(base), /版本过旧/)
    // A 404 route can never heal, so it must not burn the 10-minute readiness budget.
    assert.ok(Date.now() - startedAt < 20_000, 'failed fast rather than waiting out the budget')
  } finally {
    await manager?.dispose()
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})
