/**
 * E2E harness: runs the REAL extension host code (Bridge / DshClient /
 * HostManager / OverlayRetention, with the `vscode` module aliased to
 * ./vscode-stub) inside the Playwright worker, and serves the real webview
 * build (media/main.js) to a Chromium page whose `acquireVsCodeApi` stub is
 * wired to this process over WebSocket. A real dsh host is spawned per run
 * with an isolated `$DSH_HOME` (temp dir + copied user settings/credentials,
 * so real model calls work without touching user data); it is always the
 * harness's own process, spawned from port 3200 upward — port 3080 is never
 * probed, connected to, or killed (AGENTS.md).
 *
 * Bundled by `esbuild.config.mjs --e2e` (alias vscode -> ./vscode-stub) to
 * .temp/e2e-dist/harness.mjs, which the spec imports.
 */

import { createServer, type Server } from 'node:http'
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { Bridge } from '../../src/extension/bridge'
import { DshClient } from '../../src/extension/dsh-client'
import { HostManager } from '../../src/extension/host-manager'
import type { HostFrame, MuxFrame } from '../../src/extension/protocol/events'
import type { RpcId } from '../../src/extension/protocol/rpc'
import type { SessionId } from '../../src/extension/protocol/brand'
import type { ExtensionMessage, IdeContentPayload, WebviewMessage } from '../../src/shared/bridge'
import {
  setActiveEditor,
  setConfiguration,
  configuration,
  workspace as stubWorkspace,
  errorNotifications,
  lastReveal,
  openedFiles,
  type StubTextEditor,
} from './vscode-stub'

/** First candidate port for the test host (never 3080). */
const HOST_BASE_PORT = 3200

/** Optional boot-time seed for one harness run. */
export interface HarnessOptions {
  /**
   * Values written into the stubbed VS Code configuration BEFORE the host is
   * spawned (`dsh.env`, ...). Mirrors the real extension reading configuration
   * in activate(): anything seeded here is what the startup path sees.
   */
  config?: Record<string, unknown>
}

/** Control surface the spec drives. */
export interface Harness {
  /** URL of the served webview page (index.html + media bundle). */
  pageUrl: string
  /** Same page rendered in the settings view mode (the settings editor tab). */
  settingsPageUrl: string
  /** Real workspace root the stub reports (realpath of the plugin dir). */
  workspacePath: string
  /** A real temp directory used as the "foreign workspace" in isolation tests. */
  foreignPath: string
  /** Warm the real host + client through the real `ready` path (once). */
  ensureWarm(): Promise<void>
  /** Create a real session via host RPC, optionally renamed. */
  createSession(cwd: string, title?: string): Promise<SessionId>
  /** Passthrough host RPC (e.g. goal.create before the page loads). */
  rpc: <T = unknown>(method: string, params?: unknown) => Promise<T>
  /** Inject one mux frame through the client's real dispatch path. */
  emitMux(frame: MuxFrame, rpcId?: string): void
  /** Inject one host frame through the client's real dispatch path. */
  emitHost(frame: HostFrame): void
  /** Point the stubbed active editor (IDE insertion) — null clears it. */
  setActiveEditor(editor: StubTextEditor | null): void
  /** Push an `ide-content` delivery to the attached page, mirroring the
   * `dsh.insert*` command path (extension reads the editor, posts content). */
  emitIdeContent(payload: IdeContentPayload): void
  /** Error notifications the extension host raised via the vscode stub. */
  errorNotifications(): string[]
  /** Files the code-jump opener opened via the stub (absolute paths). */
  openedFiles(): string[]
  /** Last revealRange call of the code-jump opener, for jump assertions. */
  lastReveal(): { range: { start: { line: number }; end: { line: number } }; type: number } | null
  /** Current stubbed VS Code configuration, keyed in dotted form (`dsh.env`). */
  configuration(): Record<string, unknown>
  /** Tear down: close servers, kill our own host, delete temp dirs. */
  stop(): Promise<void>
}

/** One page connection: the stub Webview the bridge attaches to. */
interface StubWebview {
  postMessage(message: ExtensionMessage): Promise<boolean>
  onDidReceiveMessage(cb: (message: WebviewMessage) => void): { dispose(): void }
  asWebviewUri(uri: unknown): unknown
  options: unknown
  html: string
  receive(message: WebviewMessage): void
}

function createStubWebview(send: (message: ExtensionMessage) => void): StubWebview {
  const listeners = new Set<(message: WebviewMessage) => void>()
  return {
    postMessage: (message) => {
      send(message)
      return Promise.resolve(true)
    },
    onDidReceiveMessage: (cb) => {
      listeners.add(cb)
      return { dispose: () => listeners.delete(cb) }
    },
    asWebviewUri: (uri) => uri,
    options: {},
    html: '',
    receive: (message) => {
      for (const cb of listeners) void cb(message)
    },
  }
}

/**
 * Boot one e2e harness: real extension-host code, a real isolated dsh host, and
 * the static page server.
 * @param options - optional boot-time configuration seed (see HarnessOptions).
 * @returns the harness control surface; call stop() in the fixture teardown.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspacePath = await realpath(process.cwd())
  const foreignPath = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-e2e-foreign-')), 'other-workspace')
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'dsh-e2e-home-'))
  // Isolated harness home: settings + credentials copies give the spawned
  // host the user's real provider config without touching ~/.dsh.
  process.env.DSH_HOME = tmpRoot
  const userDsh = path.join(homedir(), '.dsh')
  for (const file of ['settings.yaml', '.credentials.yaml']) {
    const src = path.join(userDsh, file)
    if (existsSync(src)) await cp(src, path.join(tmpRoot, file))
  }
  // The host writes workspace-registry storage under DSH_HOME/storages and
  // assumes the dir exists (a real install creates it); mirror that.
  await mkdir(path.join(tmpRoot, 'storages'), { recursive: true })
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: workspacePath } }]

  // Seed configuration before anything reads it (the real activate() path does
  // the same at extension start); the host spawn below therefore inherits it.
  for (const [key, value] of Object.entries(options.config ?? {})) setConfiguration(key, value)

  const log = { appendLine: (): void => undefined }
  const hostManager = new HostManager(log)
  hostManager.basePort = HOST_BASE_PORT
  hostManager.customEnv = (options.config?.['dsh.env'] ?? {}) as Record<string, string>
  const client = new DshClient()
  const bridge = new Bridge(client, hostManager)

  // --- static file server + webview WebSocket bridge (one port) ---
  const mediaDir = path.resolve(process.cwd(), 'media')
  // The extension injects window.__DSH_VIEW_MODE__ per webview (renderHtml): the
  // settings editor tab renders SettingsPage instead of the sidebar shell. The
  // served page mirrors that with ?view=settings so a spec can drive the real
  // settings surface without a VS Code editor tab.
  const pageHtml = (port: number, viewMode: string): string => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="/style.css">
  <title>DSH E2E</title>
</head>
<body data-ws-port="${port}" data-view-mode="${viewMode}">
  <div id="root"></div>
  <script src="/adapter.js"></script>
  <script type="module" src="/main.js"></script>
</body>
</html>`

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      const viewMode = new URL(url, 'http://127.0.0.1').searchParams.get('view') ?? 'sidebar'
      res.end(pageHtml(serverPort(), viewMode))
      return
    }
    // The adapter is a real file in tests/e2e: keeping it out of an inline
    // <script> means no template-literal escaping can corrupt it.
    const served =
      url === '/adapter.js'
        ? { file: path.join(process.cwd(), 'tests', 'e2e', 'page-adapter.js'), media: false }
        : url === '/main.js'
          ? { file: path.join(mediaDir, 'main.js'), media: true }
          : url === '/style.css'
            ? { file: path.join(mediaDir, 'style.css'), media: false }
            : null
    if (served === null) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    void import('node:fs/promises').then(async ({ readFile }) => {
      try {
        const body = await readFile(served.file)
        res.writeHead(200, {
          'content-type': served.file.endsWith('.js') ? 'application/javascript' : 'text/css',
        })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end(served.media ? 'missing media build — run `npm run build:webview` first' : 'not found')
      }
    })
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  /** The most recently attached page webview (for test-driven pushes). */
  let latestWebview: StubWebview | null = null
  wss.on('connection', (socket: WebSocket) => {
    const webview = createStubWebview((message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'host', message }))
    })
    latestWebview = webview
    const attached = bridge.attach(webview as unknown as Parameters<Bridge['attach']>[0])
    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw)) as { type?: string; message?: WebviewMessage }
        if (data.type === 'webview' && data.message !== undefined) webview.receive(data.message)
      } catch {
        // Malformed frames from the adapter are dropped (mirrors the client).
      }
    })
    socket.on('close', () => {
      if (latestWebview === webview) latestWebview = null
      attached.dispose()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const serverPort = (): number => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server not listening')
    return address.port
  }

  // --- warm the real host + client through the real `ready` path once ---
  let warmed: Promise<void> | null = null
  const ensureWarm = (): Promise<void> => {
    warmed ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('harness warmup timeout')), 60_000)
      const webview = createStubWebview((message) => {
        if (message.type === 'init') {
          clearTimeout(timer)
          attached.dispose()
          resolve()
        }
      })
      const attached = bridge.attach(webview as unknown as Parameters<Bridge['attach']>[0])
      webview.receive({ type: 'ready' })
    })
    return warmed
  }

  return {
    pageUrl: `http://127.0.0.1:${serverPort()}/`,
    settingsPageUrl: `http://127.0.0.1:${serverPort()}/?view=settings`,
    workspacePath,
    foreignPath,
    ensureWarm,
    createSession: async (cwd, title) => {
      await ensureWarm()
      const { sessionId } = await client.rpc<{ sessionId: SessionId }>('session.create', { cwd })
      if (title !== undefined) await client.rpc('session.rename', { sessionId, title })
      return sessionId
    },
    rpc: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
      await ensureWarm()
      return client.rpc<T>(method, params)
    },
    emitMux: (frame, rpcId) => client.emitMuxFrame(frame, rpcId as RpcId | undefined),
    emitHost: (frame) => client.emitHostFrame(frame),
    setActiveEditor,
    emitIdeContent: (payload) => {
      latestWebview?.postMessage({ type: 'ide-content', ...payload })
    },
    errorNotifications: () => errorNotifications(),
    openedFiles: () => openedFiles(),
    lastReveal: () => lastReveal(),
    configuration: () => configuration(),
    stop: async () => {
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await client.dispose()
      await hostManager.dispose()
      await rm(tmpRoot, { recursive: true, force: true })
      await rm(path.dirname(foreignPath), { recursive: true, force: true })
    },
  }
}
