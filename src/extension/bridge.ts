/**
 * Bridge: message bridge between webviews and the dsh connection layer.
 * Contract: ARCHITECTURE.md section 4.4 and the bridge protocol of section 3
 * (message shapes in src/shared/bridge.ts). One Bridge serves any number of
 * attached webviews (sidebar + full panel); events are broadcast per-webview.
 */

import * as vscode from 'vscode'
import type { DshClient } from './dsh-client'
import { normalizeEnv, type HostManager, type HostInfo } from './host-manager'
import type {
  ExtensionMessage,
  IdeContentKind,
  IdeContentPayload,
  InitPayload,
  SessionMeta,
  WebviewMessage,
} from '../shared/bridge'
import type { SessionSummary } from './protocol/sessions'
import { openFileAt } from './open-file'
import { OverlayRetention } from './overlay-retention'

/**
 * Wires one DshClient/HostManager pair to attached webviews: answers `ready`
 * with `init`, passes `rpc` through to the host, forwards mux/host frames as
 * `event`, and pushes `host-status` on lifecycle changes.
 */
export class Bridge {
  private hostInfo: HostInfo | null = null
  private starting: Promise<void> | null = null
  /**
   * Answerable frames per session, retained across webview dispose/re-resolve:
   * a hidden sidebar webview is destroyed by VSCode and recreated on show, so
   * its takeover state would be lost without this replay buffer. Fed by a
   * client-level subscription that outlives every webview attach.
   */
  private readonly overlays = new OverlayRetention()

  constructor(
    private readonly client: DshClient,
    private readonly host: HostManager,
    private readonly onAction?: (action: 'open-settings-tab') => void,
  ) {
    // Retain answerable frames for the whole bridge lifetime, independent of
    // any attached webview: a hidden sidebar webview is disposed (and its
    // attach subscriptions with it), so overlay recording must not ride them.
    this.client.onMuxEvent((frame) => this.overlays.record(frame))
  }

  /**
   * Bind one webview: subscribe its message port and forward client events.
   * @param webview - the webview to wire (sidebar view or full panel).
   * @returns a Disposable removing every subscription this attach created.
   */
  attach(webview: vscode.Webview): vscode.Disposable {
    const disposables: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(webview, message)),
      new vscode.Disposable(this.client.onMuxEvent((frame) => this.post(webview, { type: 'event', channel: 'mux', frame }))),
      new vscode.Disposable(this.client.onHostEvent((frame) => this.post(webview, { type: 'event', channel: 'host', frame }))),
      new vscode.Disposable(
        this.client.onStatus((connected) => {
          this.post(webview, { type: 'host-status', status: connected ? 'ready' : 'down' })
        }),
      ),
    ]
    return vscode.Disposable.from(...disposables)
  }

  /**
   * Forward a toolbar command to every webview the bridge has served.
   * @param command - the command identifier (message type 'command').
   * @param targets - webviews to notify (tracked by the caller, e.g. the provider).
   */
  postCommand(command: 'newChat' | 'openSettings', targets: Iterable<vscode.Webview>): void {
    for (const webview of targets) this.post(webview, { type: 'command', command })
  }

  /**
   * Read IDE content (active editor selection / whole document) and push it to
   * the given webviews, mirroring the webview-initiated `ide-request` path.
   * @param kind - what to read ('selection' falls back to the whole document
   * when the selection is empty).
   * @param targets - webviews to deliver the content to.
   */
  postIdeContent(kind: IdeContentKind, targets: Iterable<vscode.Webview>): void {
    for (const webview of targets) this.handleIdeRequest(webview, kind)
  }

  /** Dispatch one inbound webview message. */
  private async handleMessage(webview: vscode.Webview, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.handleReady(webview)
        break
      case 'open-settings-tab':
        this.onAction?.('open-settings-tab')
        break
      case 'set-port':
        await this.handleSetPort(webview, message.port)
        break
      case 'restart-host':
        await this.handleRestartHost(webview)
        break
      case 'set-env':
        await this.handleSetEnv(webview, message.env)
        break
      case 'rpc':
        await this.handleRpc(webview, message.id, message.method, message.params)
        break
      case 'respond':
        await this.handleRespond(message)
        break
      case 'ide-request':
        this.handleIdeRequest(webview, message.kind, message.id)
        break
      case 'ide-open-file':
        void this.handleOpenFile(webview, message)
        break
    }
  }

  /**
   * Open a `path:line` reference from the webview (code jump): resolve the
   * path against the session cwd / workspace root and reveal the target range
   * in the editor. Failures surface as an error notification AND, when the
   * message carried an `id`, ride the `ide-open-file-result` receipt so the
   * chip can show the failure in-place (sidebar users miss the main-window
   * notification).
   */
  private async handleOpenFile(
    webview: vscode.Webview,
    message: Extract<WebviewMessage, { type: 'ide-open-file' }>,
  ): Promise<void> {
    try {
      const workspaceRoot = this.workspaceCwd()
      const file = await openFileAt(
        { path: message.path, line: message.line, endLine: message.endLine, col: message.col, cwd: message.cwd },
        workspaceRoot,
      )
      if (message.id !== undefined) this.post(webview, { type: 'ide-open-file-result', id: message.id, path: file })
    } catch (error) {
      const reason = errorMessage(error)
      if (message.id !== undefined) {
        this.post(webview, { type: 'ide-open-file-result', id: message.id, error: reason })
      }
      void vscode.window.showErrorMessage(`DSH 代码跳转失败：${reason}`)
    }
  }

  /**
   * Dispatch one `respond` message: correlate by approvalId/sessionId (the
   * webview never sees frame rpcIds) and POST /api/respond through the client.
   * Failures surface as an error notification; the webview panel re-arms.
   */
  private async handleRespond(message: Extract<WebviewMessage, { type: 'respond' }>): Promise<void> {
    try {
      if (message.kind === 'approval') {
        await this.client.resolveApprovalByApprovalId(message.approvalId, message.decision)
      } else {
        await this.client.answerQuestionBySessionId(message.sessionId, message.answers)
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`DSH 应答失败：${errorMessage(error)}`)
    }
  }

  /** Answer `ready`: ensure host+client are up, then send `init`. */
  private async handleReady(webview: vscode.Webview): Promise<void> {
    try {
      await this.ensureStarted(webview)
      const description = await this.client.rpc('host.describe', {})
      // Resolve the canonical workspace path (host-side realpath canon) so the
      // cwd filter agrees with the host's own workspace grouping; older hosts
      // without the workspace domain fall back to the raw workspace root.
      let cwd = this.workspaceCwd()
      try {
        const { workspace } = await this.client.rpc<{ workspace: { path: string } }>('workspace.create', { path: cwd })
        cwd = workspace.path
      } catch {
        // Pre-workspace host: keep the raw root for cwd filtering.
      }
      const list = await this.client.rpc('session.list', {})
      const payload: InitPayload = {
        cwd,
        hostVersion: description.version,
        port: this.hostInfo?.port ?? this.host.basePort,
        env: readConfiguredEnv(),
        sessions: list.items.filter((s) => s.cwd === undefined || s.cwd === cwd).map(toSessionMeta),
        pendingOverlays: this.overlays.replay(),
      }
      this.post(webview, { type: 'init', ...payload })
    } catch (error) {
      this.post(webview, { type: 'host-status', status: 'down' })
      void vscode.window.showErrorMessage(`DSH 初始化失败：${errorMessage(error)}`)
    }
  }

  /** Update the configured DSH port in VS Code global configuration. */
  private async handleSetPort(webview: vscode.Webview, port: number): Promise<void> {
    try {
      await vscode.workspace.getConfiguration('dsh').update('port', port, vscode.ConfigurationTarget.Global)
      this.host.basePort = port
      this.post(webview, { type: 'port-changed', port })
      void vscode.window.showInformationMessage(`DSH 服务端口已设置为 ${port}`)
    } catch (error) {
      void vscode.window.showErrorMessage(`设置端口失败：${errorMessage(error)}`)
    }
  }

  /** Restart the dsh host: dispose current client & host child, then re-initialize. */
  private async handleRestartHost(webview: vscode.Webview): Promise<void> {
    try {
      this.post(webview, { type: 'host-status', status: 'starting' })
      await this.client.dispose()
      await this.host.dispose()
      this.hostInfo = null
      this.starting = null
      await this.ensureStarted(webview)
      this.post(webview, { type: 'host-status', status: 'ready' })
      void vscode.window.showInformationMessage('DSH 进程已成功重启')
    } catch (error) {
      this.post(webview, { type: 'host-status', status: 'down' })
      void vscode.window.showErrorMessage(`重启 DSH 失败：${errorMessage(error)}`)
    }
  }

  /**
   * Persist the custom host environment (`dsh.env`) and hand it to the
   * HostManager for the next spawn. Invalid names / non-string values are
   * dropped by normalizeEnv and reported, so a typo cannot fail silently.
   */
  private async handleSetEnv(webview: vscode.Webview, env: Record<string, unknown>): Promise<void> {
    try {
      const { env: cleaned, dropped } = normalizeEnv(env)
      await vscode.workspace.getConfiguration('dsh').update('env', cleaned, vscode.ConfigurationTarget.Global)
      this.host.customEnv = cleaned
      this.post(webview, { type: 'env-changed', env: cleaned })
      if (dropped > 0) {
        void vscode.window.showWarningMessage(`DSH 环境变量：已忽略 ${dropped} 项无效配置（变量名需形如 FOO_BAR，且值不能为空）`)
      } else {
        const count = Object.keys(cleaned).length
        void vscode.window.showInformationMessage(
          count === 0 ? 'DSH 环境变量已清空' : `DSH 环境变量已保存 ${count} 项，重启 host 后生效`,
        )
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`设置环境变量失败：${errorMessage(error)}`)
    }
  }

  /** Pass one rpc through to the host and answer with `rpc-result`. */
  private async handleRpc(webview: vscode.Webview, id: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.client.rpc(method, params)
      this.post(webview, { type: 'rpc-result', id, result })
    } catch (error) {
      this.post(webview, { type: 'rpc-result', id, error: errorMessage(error) })
    }
  }

  /** Start the host (probe/spawn), check version, and connect the client — once. */
  private async ensureStarted(webview: vscode.Webview): Promise<void> {
    if (this.hostInfo !== null) return
    if (this.starting === null) {
      this.starting = (async () => {
        try {
          this.post(webview, { type: 'host-status', status: 'starting' })
          const info = await this.host.ensureHost()
          const warning = await this.host.checkVersion(info)
          if (warning !== null) void vscode.window.showWarningMessage(warning)
          await this.client.connect(info)
          this.hostInfo = info
        } catch (error) {
          this.starting = null
          throw error
        }
      })()
    }
    await this.starting
  }

  /** Current workspace root: the session ownership anchor for this plugin. */
  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  }

  /**
   * Read the active editor (selection, or the whole document) and post it to
   * one webview as `ide-content`; failures ride the payload's `error` slot so
   * the composer can toast them in-place. An `id` (from a request/response
   * `ide-request`) is echoed so the webview can correlate the answer.
   */
  private handleIdeRequest(webview: vscode.Webview, kind: IdeContentKind, id?: string): void {
    const editor = vscode.window.activeTextEditor
    const reply = (payload: Omit<IdeContentPayload, 'kind' | 'id'>): void => {
      this.post(webview, { type: 'ide-content', kind, ...payload, ...(id === undefined ? {} : { id }) })
    }
    if (editor === undefined) {
      reply({ text: '', error: '没有活动的编辑器' })
      return
    }
    const document = editor.document
    const fromSelection = kind === 'selection' && !editor.selection.isEmpty
    const selection = fromSelection ? editor.selection : undefined
    const text = selection === undefined ? document.getText() : document.getText(selection)
    if (text.trim() === '') {
      reply({
        text: '',
        error: kind === 'selection' ? '选中的内容为空' : '文件内容为空',
        fromSelection,
      })
      return
    }
    reply({ text, path: document.uri.fsPath, fromSelection })
  }

  /** Best-effort post; a disposed webview rejects and is ignored. */
  private post(webview: vscode.Webview, message: ExtensionMessage): void {
    void webview.postMessage(message).then(undefined, () => undefined)
  }
}

/** Map one SessionSummary row to the UI-facing SessionMeta (title from the projection baseline). */
function toSessionMeta(summary: SessionSummary): SessionMeta {
  const title = summary.projections?.values.title
  return {
    sessionId: summary.sessionId,
    title: typeof title === 'string' ? title : null,
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    parentSessionId: summary.parentSessionId,
    origin: summary.origin,
    cwd: summary.cwd,
  }
}

/** Normalize an unknown thrown value to a display string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The custom host environment as configured today (`dsh.env`), cleaned the same
 * way the spawn path cleans it so the settings editor shows what would be
 * injected rather than raw configuration content.
 * @returns the cleaned KEY -> value map (empty when nothing is configured).
 */
function readConfiguredEnv(): Record<string, string> {
  return normalizeEnv(vscode.workspace.getConfiguration('dsh').get<Record<string, unknown>>('env')).env
}
