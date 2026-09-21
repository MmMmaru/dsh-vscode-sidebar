/**
 * Bridge: message bridge between webviews and the dsh connection layer.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the old bridge appended a
 * client subscription per attached webview and forwarded two apiproxy sockets as
 * `channel: 'mux' | 'host'` frames. Neither socket exists now. Instead the bridge
 * holds ONE set of client subscriptions for its whole lifetime, broadcasts to
 * every attached webview, and forwards four channels (control / workspace /
 * session / remote) — see src/shared/bridge.ts.
 *
 * It also has to do two jobs the host used to do for it:
 *   - `session/list` no longer carries a title, so titles are cached from the
 *     control stream's `title` projection and joined onto the list rows here.
 *   - session events are no longer broadcast to every client, so one
 *     `session/follow` stream is opened for the session the webview is viewing,
 *     driven by the explicit `follow-session` message.
 *
 * One Bridge serves any number of attached webviews (sidebar + full panel).
 */

import * as vscode from 'vscode'
import type { DshClient } from './dsh-client'
import { normalizeEnv, type HostManager, type HostInfo } from './host-manager'
import type {
  ExtensionMessage,
  IdeContentKind,
  IdeContentPayload,
  InitPayload,
  PendingOverlayReplay,
  SessionMeta,
  WebviewMessage,
} from '../shared/bridge'
import type { SessionAddress, SessionControlFrame, SessionFollowFrame } from './protocol/follow'
import type { WorkspaceFollowFrame } from './protocol/workspace'
import type { WorkspaceView } from './protocol/views'
import type { SessionSummary } from './protocol/sessions'
import { openFileAt } from './open-file'
import { OverlayRetention } from './overlay-retention'

/** Join the session-list rows with cached projections into UI-facing rows. */
function toSessionMeta(summary: SessionSummary, titles: ReadonlyMap<string, string | null>): SessionMeta {
  const title = titles.get(summary.sessionId)
  return {
    sessionId: summary.sessionId,
    title: title === undefined || title === null ? null : title,
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    parentSessionId: summary.parentSessionId,
    origin: summary.origin,
    cwd: summary.cwd,
  }
}

/**
 * Wires one DshClient/HostManager pair to attached webviews: answers `ready` with
 * `init`, passes `rpc` through to the host, forwards the four Remote channels,
 * and pushes `host-status` on lifecycle changes.
 */
export class Bridge {
  private hostInfo: HostInfo | null = null
  private starting: Promise<void> | null = null
  /** Webviews currently attached; every outbound message fans out to these. */
  private readonly attached = new Set<vscode.Webview>()
  /** Client subscriptions are created once, however many webviews attach. */
  private wired = false
  /**
   * Pending answerable requests, retained across webview dispose/re-resolve: a
   * hidden sidebar webview is destroyed by VSCode and recreated on show, so its
   * takeover state would be lost without this replay buffer.
   */
  private readonly overlays = new OverlayRetention()
  /** Latest `title` projection value per session, joined onto `session/list` rows. */
  private readonly titles = new Map<string, string | null>()
  /** Latest workspace baseline, kept so `init` can hand over state immediately. */
  private workspaces: WorkspaceView[] = []
  private archivedSessionIds: string[] = []
  /** The single live session-journal subscription. */
  private follow: { cancel(): void } | null = null
  private followedAddress: SessionAddress | null = null
  /**
   * The opening frame of the current stream generation, per channel.
   *
   * Streams are opened once per connection, so a webview that attaches later
   * (the full panel opened after the sidebar, or a sidebar webview that VS Code
   * destroyed and re-resolved) would otherwise never see the baseline, because
   * nothing re-emits it: the frames already went out. `handleReady` replays
   * these to the newcomer. Cleared whenever a generation ends, since a stale
   * baseline is worse than none.
   */
  private controlBaseline: SessionControlFrame | null = null
  private workspaceBaseline: WorkspaceFollowFrame | null = null
  /**
   * Opening snapshot of the followed session's current generation, replayed to a
   * late webview. Without it a newly opened panel shows an empty transcript AND
   * never recovers: its `follow-session` for the address already being followed
   * short-circuits in `handleFollowSession`, so the host is never re-asked.
   */
  private sessionSnapshot: SessionFollowFrame | null = null

  constructor(
    private readonly client: DshClient,
    private readonly host: HostManager,
    private readonly onAction?: (action: 'open-settings-tab') => void,
  ) {}

  /**
   * Bind one webview: subscribe its inbound port and register it for broadcasts.
   * @param webview - the webview to wire (sidebar view or full panel).
   * @returns a Disposable removing the registration and inbound subscription.
   */
  attach(webview: vscode.Webview): vscode.Disposable {
    this.attached.add(webview)
    const inbound = webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(webview, message))
    return new vscode.Disposable(() => {
      this.attached.delete(webview)
      inbound.dispose()
    })
  }

  /**
   * Forward a toolbar command to every attached webview.
   * @param command - the command identifier (message type 'command').
   */
  postCommand(command: 'newChat' | 'openSettings'): void {
    this.broadcast({ type: 'command', command })
  }

  /**
   * Read IDE content (active editor selection / whole document) and push it to
   * every attached webview, mirroring the webview-initiated `ide-request` path.
   * @param kind - what to read ('selection' falls back to the whole document
   * when the selection is empty).
   */
  postIdeContent(kind: IdeContentKind): void {
    for (const webview of this.attached) this.handleIdeRequest(webview, kind)
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
      case 'follow-session':
        this.handleFollowSession(message.address)
        break
      case 'unfollow-session':
        this.handleUnfollowSession()
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
   * Answer one pending request. Both kinds are keyed by `eventId`, which is what
   * `$events/result` accepts; the overlay is dropped optimistically so a stale
   * prompt cannot be answered twice.
   */
  private async handleRespond(message: Extract<WebviewMessage, { type: 'respond' }>): Promise<void> {
    try {
      if (message.kind === 'approval') {
        await this.client.resolveApproval(message.eventId, message.decision)
      } else {
        await this.client.answerQuestion(message.eventId, message.answers)
      }
      this.overlays.recordCleared(message.eventId)
    } catch (error) {
      void vscode.window.showErrorMessage(`DSH 应答失败：${errorMessage(error)}`)
    }
  }

  /** Answer `ready`: ensure host+client are up, then send `init`. */
  private async handleReady(webview: vscode.Webview): Promise<void> {
    try {
      await this.ensureStarted(webview)
      const list = await this.client.sessionList()
      // Prefer the host's canonical workspace path when one matches our root, so
      // the cwd filter agrees with the host's own workspace grouping. This used
      // to be done by calling `workspace.create` (a write!); the workspace stream
      // now supplies the same canonical paths without mutating host state.
      const cwd = this.canonicalCwd()
      const payload: InitPayload = {
        cwd,
        port: this.hostInfo?.port ?? this.host.basePort,
        env: readConfiguredEnv(),
        sessions: list
          .filter((s) => s.cwd === undefined || s.cwd === cwd || s.cwd === this.workspaceCwd())
          .map((s) => toSessionMeta(s, this.titles)),
        workspaces: this.workspaces,
        archivedSessionIds: this.archivedSessionIds as never,
        pendingOverlays: this.overlays.replay(),
      }
      this.post(webview, { type: 'init', ...payload })
      // Then hand over the current generation's opening frames, so a webview that
      // attached after the streams started still arrives at full state. Ordered
      // before any later increment because these are synchronous posts.
      if (this.controlBaseline !== null) {
        this.post(webview, { type: 'event', channel: 'control', frame: this.controlBaseline })
      }
      if (this.workspaceBaseline !== null) {
        this.post(webview, { type: 'event', channel: 'workspace', frame: this.workspaceBaseline })
      }
      if (this.sessionSnapshot !== null) {
        this.post(webview, { type: 'event', channel: 'session', frame: this.sessionSnapshot })
      }
    } catch (error) {
      this.post(webview, { type: 'host-status', status: 'down' })
      void vscode.window.showErrorMessage(`DSH 初始化失败：${errorMessage(error)}`)
    }
  }

  /** Subscribe to the addressed session journal, replacing any previous one. */
  private handleFollowSession(address: SessionAddress): void {
    if (this.followedAddress !== null && sameAddress(this.followedAddress, address)) return
    this.handleUnfollowSession()
    this.followedAddress = address
    this.follow = this.client.followSession(address, (frame: SessionFollowFrame) => {
      // The snapshot opens a generation and is cumulative; later frames are deltas.
      if (frame.type === 'snapshot') this.sessionSnapshot = frame
      this.broadcast({ type: 'event', channel: 'session', frame })
    })
  }

  /** Drop the current session-journal subscription, if any. */
  private handleUnfollowSession(): void {
    this.follow?.cancel()
    this.follow = null
    this.followedAddress = null
    this.sessionSnapshot = null
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
      this.handleUnfollowSession()
      await this.client.dispose()
      await this.host.dispose()
      this.hostInfo = null
      this.starting = null
      this.wired = false
      this.titles.clear()
      this.workspaces = []
      this.archivedSessionIds = []
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

  /** Pass one Remote call through to the host and answer with `rpc-result`. */
  private async handleRpc(webview: vscode.Webview, id: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.client.rpc(method, params)
      this.post(webview, { type: 'rpc-result', id, result })
    } catch (error) {
      this.post(webview, { type: 'rpc-result', id, error: errorMessage(error) })
    }
  }

  /** Start the host (probe/spawn), check capability, and connect the client — once. */
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
          this.wireClient()
        } catch (error) {
          this.starting = null
          throw error
        }
      })()
    }
    await this.starting
  }

  /**
   * Install the client subscriptions exactly once for this connection.
   *
   * These live on the Bridge (not on an attach) because the answerable-request
   * buffer and the projection/title cache must outlive any single webview: a
   * hidden sidebar webview is disposed and re-resolved later.
   */
  private wireClient(): void {
    if (this.wired) return
    this.wired = true

    this.client.onApprovalRequest((request) => {
      const overlay: PendingOverlayReplay = {
        kind: 'approval',
        eventId: request.eventId,
        agentId: request.agentId,
        toolName: request.toolName,
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
      }
      this.overlays.recordPending(overlay)
      this.broadcast({ type: 'event', channel: 'remote', event: 'approval/request', args: [overlay] })
    })

    this.client.onQuestionRequest((request) => {
      const overlay: PendingOverlayReplay = {
        kind: 'question',
        eventId: request.eventId,
        agentId: request.agentId,
        questions: request.questions,
      }
      this.overlays.recordPending(overlay)
      this.broadcast({ type: 'event', channel: 'remote', event: 'user-questions/request', args: [overlay] })
    })

    // A retracted request must stop being answerable, or the user answers into
    // a void and gets an opaque failure.
    this.client.onApprovalCleared((eventId) => {
      this.overlays.recordCleared(eventId)
      this.broadcast({ type: 'event', channel: 'remote', event: 'request/cancelled', args: [eventId] })
    })

    this.client.onSessionControl((frame) => {
      this.absorbTitles(frame)
      // Only a baseline restarts a generation; later frames are increments.
      if (frame.type === 'baseline') this.controlBaseline = frame
      this.broadcast({ type: 'event', channel: 'control', frame })
    })

    this.client.onWorkspace((frame) => {
      this.absorbWorkspace(frame)
      if (frame.type === 'baseline') this.workspaceBaseline = frame
      this.broadcast({ type: 'event', channel: 'workspace', frame })
    })

    this.client.onRemoteEvent((event, args) => {
      this.broadcast({ type: 'event', channel: 'remote', event, args })
    })

    this.client.onStreamError((failure) => {
      this.broadcast({ type: 'stream-error', scope: failure.scope, error: failure.error })
    })

    // Carrier flips. The webview's status indicator reads this, so without it a
    // dropped connection would look healthy. (The old bridge wired this per
    // attach; it is a client-level fact, so it belongs here.)
    this.client.onStatus((connected) => {
      this.broadcast({ type: 'host-status', status: connected ? 'ready' : 'down' })
    })
  }

  /** Maintain the per-session `title` cache from control-stream projection frames. */
  private absorbTitles(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      for (const [sessionId, baseline] of Object.entries(frame.value.projections)) {
        if (Object.hasOwn(baseline.values, 'title')) {
          this.titles.set(sessionId, (baseline.values.title ?? null) as string | null)
        }
      }
      return
    }
    if (frame.type === 'projection' && frame.key === 'title') {
      this.titles.set(frame.sessionId, (frame.value ?? null) as string | null)
    }
  }

  /** Maintain the cached workspace baseline from the workspace stream. */
  private absorbWorkspace(frame: WorkspaceFollowFrame): void {
    switch (frame.type) {
      case 'baseline':
        this.workspaces = [...frame.value.items]
        this.archivedSessionIds = [...frame.value.archivedSessionIds]
        return
      case 'upsert': {
        const next = this.workspaces.filter((item) => item.workspaceId !== frame.workspace.workspaceId)
        next.push(frame.workspace)
        this.workspaces = next
        return
      }
      case 'remove':
        this.workspaces = this.workspaces.filter((item) => item.workspaceId !== frame.workspaceId)
        return
      case 'order': {
        const byId = new Map(this.workspaces.map((item) => [item.workspaceId, item]))
        this.workspaces = frame.workspaceIds
          .map((id) => byId.get(id))
          .filter((item): item is WorkspaceView => item !== undefined)
        return
      }
      case 'archived':
        this.archivedSessionIds = [...frame.archivedSessionIds]
        return
    }
  }

  /**
   * The host's canonical path for our workspace root, when the workspace stream
   * has reported one; otherwise the raw root.
   */
  private canonicalCwd(): string {
    const root = this.workspaceCwd()
    const match = this.workspaces.find((item) => item.path === root)
    return match?.path ?? root
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

  /** Fan one message out to every attached webview. */
  private broadcast(message: ExtensionMessage): void {
    for (const webview of this.attached) this.post(webview, message)
  }

  /** Best-effort post; a disposed webview rejects and is ignored. */
  private post(webview: vscode.Webview, message: ExtensionMessage): void {
    void webview.postMessage(message).then(undefined, () => undefined)
  }
}

/** True when two addresses name the same journal. */
function sameAddress(left: SessionAddress, right: SessionAddress): boolean {
  if (left.kind === 'session' && right.kind === 'session') return left.sessionId === right.sessionId
  if (left.kind === 'subagent' && right.kind === 'subagent') {
    return left.childSessionId === right.childSessionId && left.parentSessionId === right.parentSessionId
  }
  return false
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
