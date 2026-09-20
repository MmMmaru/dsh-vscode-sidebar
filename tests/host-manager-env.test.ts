/**
 * Unit tests for the custom host environment (`dsh.env`): normalizeEnv's
 * filtering contract and the end-to-end spawn path. The spawn test puts a stub
 * `dsh` on PATH which writes its OWN environment to a file, so the assertions
 * read what the real child process received (not what we intended to pass).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostManager, normalizeEnv } from '../src/extension/host-manager'

/** SPAWN_READY_TIMEOUT_MS is 10min in production; a stuck stub must not hang the suite. */
const TEST_DEADLINE_MS = 3000

/**
 * Port window reserved for this file, deliberately outside the 41000+ range that
 * tests/fake-host.ts consecutivePorts() hands out: node:test runs the files in
 * parallel, so a shared range would race (two files binding the same port).
 */
const PORT_WINDOW_START = 52000
let portCursor = PORT_WINDOW_START

/** Next free loopback port in this file's own window. */
async function nextFreePort(): Promise<number> {
  const net = await import('node:net')
  for (; portCursor < PORT_WINDOW_START + 500; portCursor++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(portCursor, '127.0.0.1')
    })
    if (free) return portCursor++
  }
  throw new Error('no free port in the host-manager-env test window')
}

/**
 * A stub `dsh` binary: serves host.describe on --port (so the readiness probe
 * passes) and dumps its environment to the file named by --env-dump. The dump
 * goes to a file rather than stdout because the environment is far larger than
 * one pipe buffer.
 * @param dumpPath - absolute path the stub writes its environment to.
 */
function stubSource(dumpPath: string): string {
  return [
    '#!/usr/bin/env node',
    "const http = require('node:http')",
    "const fs = require('node:fs')",
    "const argOf = (name) => process.argv[process.argv.indexOf(name) + 1]",
    `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env))`,
    'const port = Number(argOf("--port"))',
    'http.createServer((req, res) => {',
    "  let raw = ''",
    "  req.on('data', (chunk) => { raw += chunk })",
    "  req.on('end', () => {",
    '    const body = JSON.parse(raw)',
    "    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({",
    "      type: 'server-response',",
    '      rpcId: body.rpcId,',
    "      result: { ok: true, value: { version: '0.1.0-rc.6', cwd: '/tmp', attachedSessions: 0, canOpenPath: false } },",
    '    }))',
    '  })',
    "}).listen(port, '127.0.0.1')",
    '',
  ].join('\n')
}

/** Collector logger: HostManager logs the spawn summary here. */
function collectingLog(): { lines: string[]; log: { appendLine(line: string): void } } {
  const lines: string[] = []
  return { lines, log: { appendLine: (line: string) => lines.push(line) } }
}

/** Install the stub as `dsh` on PATH; returns the temp bin dir. */
async function installStub(dumpPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-bin-'))
  await writeFile(join(dir, 'dsh'), stubSource(dumpPath))
  await chmod(join(dir, 'dsh'), 0o755)
  return dir
}

/** The environment the stub child process actually received. */
async function readEnvDump(dumpPath: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(dumpPath, 'utf8')) as Record<string, string>
}

test('normalizeEnv keeps valid entries and drops invalid names, empty and non-string values', () => {
  const { env, dropped } = normalizeEnv({
    DSH_HOME: '/tmp/dsh-home',
    PATH: '/custom/bin',
    // Values pass through verbatim: a secret may hold spaces or '='.
    ODD_VALUE: 'a b=c',
    '': 'no-name',
    '1BAD': 'starts-with-digit',
    'HAS-DASH': 'dash',
    'WITH SPACE': 'space',
    EMPTY: '',
    NUMERIC: 42,
    NULLISH: null,
  })
  assert.deepEqual(env, { DSH_HOME: '/tmp/dsh-home', PATH: '/custom/bin', ODD_VALUE: 'a b=c' })
  assert.equal(dropped, 7)
})

test('normalizeEnv trims surrounding key whitespace and tolerates an absent setting', () => {
  assert.deepEqual(normalizeEnv({ '  PADDED  ': 'x' }).env, { PADDED: 'x' })
  assert.deepEqual(normalizeEnv(undefined), { env: {}, dropped: 0 })
  assert.deepEqual(normalizeEnv({}), { env: {}, dropped: 0 })
})

test('spawn injects customEnv into the child process on top of the inherited environment', async () => {
  const base = await nextFreePort()
  const dump = join(tmpdir(), `dsh-env-dump-${String(Date.now())}-${String(process.pid)}.json`)
  const originalPath = process.env.PATH
  const dir = await installStub(dump)
  const { lines, log } = collectingLog()
  let manager: HostManager | null = null
  try {
    process.env.PATH = `${dir}:${originalPath ?? ''}`
    manager = new HostManager(log)
    manager.basePort = base
    manager.customEnv = { DSH_HOME: '/tmp/from-setting', CUSTOM_FLAG: 'on' }
    const info = await manager.spawn(base)
    assert.equal(info.spawnedByUs, true)
    assert.ok(lines.some((line) => line.includes('custom env: DSH_HOME, CUSTOM_FLAG')), 'env keys are logged by name')

    const childEnv = await readEnvDump(dump)
    assert.equal(childEnv.DSH_HOME, '/tmp/from-setting')
    assert.equal(childEnv.CUSTOM_FLAG, 'on')
    // The merge is explicit: posix-spawn would otherwise drop the parent env.
    assert.equal(childEnv.PATH, `${dir}:${originalPath ?? ''}`)
    assert.equal(childEnv.HOME, process.env.HOME)
  } finally {
    await manager?.dispose()
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
    await rm(dump, { force: true })
  }
})

test('spawn without customEnv leaves the inherited environment untouched', async () => {
  const next = await nextFreePort()
  const dump = join(tmpdir(), `dsh-env-dump-none-${String(Date.now())}-${String(process.pid)}.json`)
  const originalPath = process.env.PATH
  const dir = await installStub(dump)
  const { lines, log } = collectingLog()
  let manager: HostManager | null = null
  try {
    process.env.PATH = `${dir}:${originalPath ?? ''}`
    manager = new HostManager(log)
    manager.basePort = next
    const info = await manager.spawn(next)
    assert.equal(info.spawnedByUs, true)
    assert.equal(lines.some((line) => line.includes('custom env:')), false, 'nothing is injected when nothing is configured')

    const childEnv = await readEnvDump(dump)
    assert.equal(childEnv.PATH, `${dir}:${originalPath ?? ''}`)
    // CUSTOM_FLAG is the absence witness: DSH_HOME is ambient (the test runner
    // exports one), so it cannot prove that nothing was injected.
    assert.equal(childEnv.CUSTOM_FLAG, undefined)
  } finally {
    await manager?.dispose()
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
    await rm(dump, { force: true })
  }
})

test('spawn fails fast when the stubbed host exits before answering the probe', async () => {
  // Guard against a regression where the readiness loop swallows a dead child:
  // an exiting stub must reject rather than wait out the 10-minute deadline.
  const base = await nextFreePort()
  const originalPath = process.env.PATH
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-bin-dead-'))
  const { log } = collectingLog()
  try {
    await writeFile(join(dir, 'dsh'), '#!/usr/bin/env node\nprocess.exit(3)\n')
    await chmod(join(dir, 'dsh'), 0o755)
    process.env.PATH = `${dir}:${originalPath ?? ''}`
    const manager = new HostManager(log)
    manager.basePort = base
    const started = Date.now()
    await assert.rejects(manager.spawn(base), /exited during startup/)
    assert.ok(Date.now() - started < TEST_DEADLINE_MS, 'a dead child must not ride the ready deadline')
  } finally {
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})
