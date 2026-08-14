/**
 * HostManager: dsh web host lifecycle (discovery, spawn, version check).
 * Contract: ARCHITECTURE.md section 4.2. Loopback only (127.0.0.1); the
 * vscode import is type-only so this module stays unit-testable under plain
 * Node (node:test), never loading the `vscode` runtime module.
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as vscode from 'vscode'
import type { ClientRequest, ServerResponse } from './protocol/rpc'
import { RpcId } from './protocol/rpc'
import type { HostDescription } from './protocol/host'

const execFileAsync = promisify(execFile)

/** Connection facts about a reachable (or freshly spawned) dsh host. */
export interface HostInfo {
  port: number
  pid?: number
  spawnedByUs: boolean
}

/** dsh package used when no `dsh` binary is on PATH. */
const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.6'
/**
 * Compatible host version prefixes (mirrors package.json `dsh.compatibleVersionPrefixes`).
 * Note: the published 0.1.0-rc.6 npm package reports app version "0.0.1" from
 * host.describe, while a dev/PATH dsh reports its real "0.1.0-rc.*" version.
 */
const COMPATIBLE_VERSION_PREFIXES = ['0.1.0-rc.', '0.0.1']
/** Health-check RPC (the only probe endpoint; never invent others). */
const PROBE_METHOD = 'host.describe'
/** Ports scanned in order starting from basePort. */
const PORT_SCAN_LIMIT = 10
/** Per-probe HTTP deadline; a hung listener must not stall startup. */
const PROBE_TIMEOUT_MS = 1500
/** Spawn readiness deadline (first `npx` run downloads the package; measured ~4.5min cold). */
const SPAWN_READY_TIMEOUT_MS = 600_000
/** Poll interval while waiting for a spawned host to answer. */
const SPAWN_POLL_MS = 500

/** Minimal logger shape so tests can substitute a plain object. */
type Logger = Pick<vscode.OutputChannel, 'appendLine'>

/**
 * Owns the dsh host process lifecycle: probe candidate ports for an existing
 * host, spawn one when absent, verify version compatibility, kill on dispose.
 */
export class HostManager {
  /** First port to probe (set from the `dsh.port` configuration; tests override). */
  basePort = 3080
  private child: ChildProcess | null = null

  constructor(private readonly log: Logger) {}

  /**
   * Ensure a host is available: probe basePort..basePort+9 in order and use the
   * first live one; when none answers, spawn on the first port that is free.
   * @returns connection info of the selected host.
   */
  async ensureHost(): Promise<HostInfo> {
    for (let port = this.basePort; port < this.basePort + PORT_SCAN_LIMIT; port++) {
      if (await this.probe(port)) {
        this.log.appendLine(`[host-manager] found existing dsh host on 127.0.0.1:${port}`)
        return { port, spawnedByUs: false }
      }
    }
    const port = await this.firstFreePort()
    this.log.appendLine(`[host-manager] no live host; spawning on 127.0.0.1:${port}`)
    return this.spawn(port)
  }

  /**
   * Probe one port for a dsh host: POST /api/host.describe and accept only a
   * well-formed ok ServerResponse (a random listener on the port is not dsh).
   * @param port - loopback port to probe.
   * @returns true when a dsh host answered the health check.
   */
  async probe(port: number): Promise<boolean> {
    try {
      const request: ClientRequest = {
        type: 'client-request',
        rpcId: RpcId(crypto.randomUUID()),
        method: PROBE_METHOD,
        payload: {},
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/${PROBE_METHOD}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) return false
      const body = (await response.json()) as ServerResponse
      return body.type === 'server-response' && body.rpcId === request.rpcId && body.result.ok
    } catch {
      return false
    }
  }

  /**
   * Spawn `dsh web --host 127.0.0.1 --port <port>` (PATH binary preferred,
   * `npx -y <package>` fallback) and poll the probe until it answers.
   * @param port - port the host must listen on.
   * @returns connection info including the child pid.
   */
  async spawn(port: number): Promise<HostInfo> {
    const command = await this.resolveCommand()
    const args = [...command.args, 'web', '--host', '127.0.0.1', '--port', String(port)]
    this.log.appendLine(`[host-manager] spawn: ${command.bin} ${args.join(' ')}`)
    const child = spawnChild(command.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.log.appendLine(`[dsh] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) => this.log.appendLine(`[dsh:err] ${chunk.toString().trimEnd()}`))
    child.on('exit', (code) => {
      this.log.appendLine(`[host-manager] dsh host exited with code ${String(code)}`)
      if (this.child === child) this.child = null
    })

    const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`dsh host exited during startup (code ${String(child.exitCode)})`)
      if (await this.probe(port)) return { port, pid: child.pid, spawnedByUs: true }
      await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS))
    }
    child.kill()
    throw new Error(`dsh host did not become ready on port ${port} within ${SPAWN_READY_TIMEOUT_MS}ms`)
  }

  /**
   * Read the host version via host.describe and compare it with the plugin's
   * declared compatible prefixes (COMPATIBLE_VERSION_PREFIXES).
   * @param info - the host to interrogate.
   * @returns a warning message when the version matches no prefix, else null.
   */
  async checkVersion(info: HostInfo): Promise<string | null> {
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId(crypto.randomUUID()),
      method: PROBE_METHOD,
      payload: {},
    }
    const response = await fetch(`http://127.0.0.1:${info.port}/api/${PROBE_METHOD}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return `无法读取 dsh 版本（HTTP ${response.status}），请确认 dsh 已升级到 0.1.0-rc 系`
    const body = (await response.json()) as ServerResponse
    if (!body.result.ok) return `host.describe 失败：${body.result.error.message}`
    const description = body.result.value as HostDescription
    if (!COMPATIBLE_VERSION_PREFIXES.some((prefix) => description.version.startsWith(prefix))) {
      return `dsh 版本 ${description.version} 与插件兼容范围 ${COMPATIBLE_VERSION_PREFIXES.join(' / ')}* 不匹配，请升级 dsh`
    }
    return null
  }

  /** Kill the child process when (and only when) this manager spawned it. */
  async dispose(): Promise<void> {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) {
      this.log.appendLine('[host-manager] killing spawned dsh host')
      child.kill()
    }
  }

  /** First port in the scan range with nothing listening (probe already failed there). */
  private async firstFreePort(): Promise<number> {
    const net = await import('node:net')
    for (let port = this.basePort; port < this.basePort + PORT_SCAN_LIMIT; port++) {
      const free = await new Promise<boolean>((resolve) => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => server.close(() => resolve(true)))
        server.listen(port, '127.0.0.1')
      })
      if (free) return port
    }
    throw new Error(`no free port in ${this.basePort}..${this.basePort + PORT_SCAN_LIMIT - 1}`)
  }

  /** Resolve the spawn command: `dsh` on PATH wins, else the pinned npx package. */
  private async resolveCommand(): Promise<{ bin: string; args: string[] }> {
    try {
      await execFileAsync('which', ['dsh'])
      return { bin: 'dsh', args: [] }
    } catch {
      return { bin: 'npx', args: ['-y', DSH_PACKAGE] }
    }
  }
}
