/**
 * Bridge: message bridge between webviews and the dsh connection layer.
 * Contract: ARCHITECTURE.md section 4.4 and the bridge protocol of section 3
 * (message shapes in src/shared/bridge.ts). One Bridge serves any number of
 * attached webviews (sidebar + full panel); events are broadcast per-webview.
 */

import * as vscode from 'vscode'
import type { DshClient } from './dsh-client'
import type { HostManager, HostInfo } from './host-manager'
import type { ExtensionMessage, InitPayload, SessionMeta, WebviewMessage } from '../shared/bridge'
import type { SessionSummary } from './protocol/sessions'

/**
 * Wires one DshClient/HostManager pair to attached webviews: answers `ready`
 * with `init`, passes `rpc` through to the host, forwards mux/host frames as
 * `event`, and pushes `host-status` on lifecycle changes.
 */
export class Bridge {
  private hostInfo: HostInfo | null = null
  private starting: Promise<void> | null = null

  constructor(
    private readonly client: DshClient,
    private readonly host: HostManager,
  ) {}

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

  /** Dispatch one inbound webview message. */
  private async handleMessage(webview: vscode.Webview, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.handleReady(webview)
        break
      case 'rpc':
        await this.handleRpc(webview, message.id, message.method, message.params)
        break
      case 'respond':
        await this.handleRespond(message)
        break
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
      const list = await this.client.rpc('session.list', {})
      const payload: InitPayload = {
        cwd: this.workspaceCwd(),
        hostVersion: description.version,
        sessions: list.items.map(toSessionMeta),
      }
      this.post(webview, { type: 'init', ...payload })
    } catch (error) {
      this.post(webview, { type: 'host-status', status: 'down' })
      void vscode.window.showErrorMessage(`DSH 初始化失败：${errorMessage(error)}`)
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
    this.starting ??= (async () => {
      this.post(webview, { type: 'host-status', status: 'starting' })
      const info = await this.host.ensureHost()
      const warning = await this.host.checkVersion(info)
      if (warning !== null) void vscode.window.showWarningMessage(warning)
      await this.client.connect(info)
      this.hostInfo = info
    })()
    await this.starting
  }

  /** Current workspace root: the session ownership anchor for this plugin. */
  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
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
