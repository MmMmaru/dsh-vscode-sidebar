/**
 * Bridge message protocol (extension host <-> webview).
 * All messages are JSON objects carried by `vscode.postMessage` /
 * `onDidReceiveMessage`. Shared by both sides: the extension posts
 * ExtensionMessage, the webview posts WebviewMessage.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the old contract forwarded two
 * apiproxy sockets to the webview as `channel: 'mux' | 'host'` frames. Those
 * sockets no longer exist. The new contract forwards four distinct channels:
 *
 *   control   — Host-wide `session/control`: queues, jobs, projection values.
 *   workspace — `workspace/follow`: workspace set, manual order, archived set.
 *   session   — one `session/follow` journal, explicitly subscribed per session
 *               (the host no longer fans out every session's events to everyone).
 *   remote    — sparse broadcast `$events` emits (`api-session/added`, …).
 *
 * Answerable requests (approvals, ask-user questions) are keyed by `eventId`
 * from the moment they reach the webview: the old `approvalId` /`sessionId`
 * correlation existed only because the frame's rpcId was hidden from the
 * webview, and `POST /api/respond` is gone entirely.
 */

import type { SessionId } from '../extension/protocol/brand'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '../extension/protocol/events'
import type { RpcError } from '../extension/protocol/rpc'
import type { SessionAddress, SessionControlFrame, SessionFollowFrame } from '../extension/protocol/follow'
import type { WorkspaceFollowFrame } from '../extension/protocol/workspace'
import type { WorkspaceView } from '../extension/protocol/views'

/** Host lifecycle states pushed to the webview. */
export type HostStatus = 'starting' | 'ready' | 'down'

/**
 * One forwarded Remote channel message.
 *
 * Declared here (rather than on either side) because both the extension host
 * and the webview need the same discriminated union: the host produces it, the
 * webview consumes it, and the e2e harness synthesizes it.
 *
 * - `control`   Host-wide queues, jobs, and projection values.
 * - `workspace` workspace set, manual order, and archived set.
 * - `session`   the followed session's journal; each generation starts with a
 *               `snapshot` that fully replaces prior history.
 * - `remote`    a sparse broadcast host event with its positional arguments.
 */
export type RemoteChannelMessage =
  | { channel: 'control'; frame: SessionControlFrame }
  | { channel: 'workspace'; frame: WorkspaceFollowFrame }
  | { channel: 'session'; frame: SessionFollowFrame }
  | { channel: 'remote'; event: string; args: unknown[] }

/** What IDE content a `requestIdeContent` / `ide-content` message carries. */
export type IdeContentKind = 'selection' | 'active-file'

/**
 * One pending answerable request, replayable into a freshly attached webview.
 *
 * The extension retains these while no webview is attached (a hidden sidebar
 * webview is disposed and re-resolved later) and hands them back in the init
 * payload so a takeover panel re-appears after switching back.
 *
 * `eventId` is the reply key: it is what `$events/result` accepts, and it is
 * stable for the request's whole lifetime.
 */
export interface PendingApprovalOverlay {
  kind: 'approval'
  eventId: string
  /** Session (or subagent) the approval is scoped to. */
  agentId: string
  toolName: string
  callId?: string
  reason?: string
}

/** One pending ask-user-questions batch, replayable the same way. */
export interface PendingQuestionOverlay {
  kind: 'question'
  eventId: string
  agentId: string
  questions: AskUserQuestionItem[]
}

/** Any replayed answerable request. */
export type PendingOverlayReplay = PendingApprovalOverlay | PendingQuestionOverlay

/**
 * UI-facing session list row.
 *
 * Derived by the bridge from a `session/list` row plus that session's cached
 * `title` projection: 0.1.5-rc.2 removed the inline title from the list row, so
 * the bridge assembles the two sources itself.
 */
export interface SessionMeta {
  sessionId: SessionId
  /** Session title from the `title` projection; null means "no title yet". */
  title: string | null
  /** The later of creation and the latest human-authored prompt (epoch ms). */
  updatedAt: number
  /** Whether the attached agent is currently running. */
  running: boolean
  /** Conversation-not-started bit: true while no turn has run. */
  blank: boolean
  /** fork/spawn lineage; absent for root sessions. */
  parentSessionId?: SessionId
  /** Coarse durable origin used by navigation surfaces. */
  origin?: 'subagent'
  /** Session working directory; the webview filters the list by the workspace cwd. */
  cwd?: string
}

/** Payload of the `init` message answering `ready`. */
export interface InitPayload {
  /** Current VSCode workspace root (session ownership anchor). */
  cwd: string
  /**
   * Current configured/active port for dsh host.
   *
   * The old payload also carried `hostVersion`, read from `host.describe`. That
   * method is gone and no Remote method reports a host version, so the field was
   * removed rather than left permanently empty.
   */
  port?: number
  /**
   * Custom environment variables configured for the spawned dsh host
   * (`dsh.env`); empty/absent when none are set.
   */
  env?: Record<string, string>
  /** Full session list; the webview filters by `cwd`. */
  sessions: SessionMeta[]
  /** Workspace rows from the `workspace/follow` baseline, when one has arrived. */
  workspaces?: WorkspaceView[]
  /** Archived session ids from the same baseline. */
  archivedSessionIds?: SessionId[]
  /**
   * Answerable requests that arrived while no webview was attached (sidebar
   * hidden = webview disposed). Replayed so the takeover panel re-appears.
   */
  pendingOverlays?: PendingOverlayReplay[]
}

/** Payload of the `ide-content` message answering `ide-request`. */
export interface IdeContentPayload {
  kind: IdeContentKind
  /** The editor text (selection, or the whole document for `active-file`). */
  text: string
  /** Absolute path of the source document, when one was read. */
  path?: string
  /** Human-readable failure (no active editor, empty selection); text absent. */
  error?: string
  /** True when the payload came from a non-empty editor selection ('selection'
   * falls back to the whole document when the selection is empty). Drives the
   * send-time auto-injection: only real selections are auto-attached. */
  fromSelection?: boolean
  /** Correlation id echoing the `ide-request`; absent for toolbar-command
   * pushes (fire-and-forget subscribers). */
  id?: string
}

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  /** webview mounted; requests initialization. */
  | { type: 'ready' }
  /** Open the Settings full editor panel tab. */
  | { type: 'open-settings-tab' }
  /** Update the DSH base port setting in VS Code configuration. */
  | { type: 'set-port'; port: number }
  /** Restart the dsh host process (kills spawned instance or reconnects). */
  | { type: 'restart-host' }
  /**
   * Update the custom host environment (`dsh.env`) in VS Code configuration.
   * Values are persisted and injected into the next spawned host process; a
   * host that is already running keeps its old environment.
   */
  | { type: 'set-env'; env: Record<string, string> }
  /**
   * Passthrough dsh Remote call; `method` is e.g. `session/list`, and `params`
   * is the EXACT `args` object its descriptor declares.
   */
  | { type: 'rpc'; id: string; method: string; params?: unknown }
  /**
   * Subscribe to one session journal. The host no longer broadcasts every
   * session's events, so the extension opens a `session/follow` stream for the
   * addressed session and forwards its frames on channel `session`.
   * Opening a new address replaces the previous subscription.
   */
  | { type: 'follow-session'; address: SessionAddress }
  /** Stop the current `session/follow` subscription. */
  | { type: 'unfollow-session' }
  /**
   * Answer a pending request. Both kinds are keyed by the `eventId` delivered
   * with the request: it is the reply key `$events/result` accepts (the old
   * `approvalId` / `sessionId` correlation is gone along with `POST /api/respond`).
   */
  | { type: 'respond'; kind: 'approval'; eventId: string; decision: 'allow-once' | 'refuse' }
  | { type: 'respond'; kind: 'question'; eventId: string; answers: AskUserQuestionAnswerItem[] }
  /** Ask the extension host for IDE content (selection / active file). An
   * `id` turns the push into a request/response pair (send-time auto-inject);
   * without it the answer fans out to the fire-and-forget subscribers. */
  | { type: 'ide-request'; kind: IdeContentKind; id?: string }
  /** Ask the extension host to open a `path:line` reference (code jump). The
   * path is resolved session-cwd-first, then workspace-root; the target range
   * is revealed and highlighted in the editor. An `id` turns it into a
   * request/response pair answered by `ide-open-file-result`, so the webview
   * can surface failures in-place (the VSCode notification alone is easy to
   * miss while watching the sidebar). */
  | {
      type: 'ide-open-file'
      path: string
      /** 1-based start line; absent for refs without a line suffix (opens at line 1). */
      line?: number
      endLine?: number
      col?: number
      /** Session working directory the webview resolved the ref against. */
      cwd?: string
      /** Correlation id echoed by `ide-open-file-result`. */
      id?: string
    }

/** Messages the extension host sends to the webview. */
export type ExtensionMessage =
  /** Initialization data answering `ready`. */
  | ({ type: 'init' } & InitPayload)
  /** Port updated notification. */
  | { type: 'port-changed'; port: number }
  /**
   * Custom host environment updated notification; carries the cleaned map the
   * extension actually stored (invalid entries already dropped), so the editor
   * can settle on the persisted truth.
   */
  | { type: 'env-changed'; env: Record<string, string> }
  /** RPC answer paired by `id`. */
  | { type: 'rpc-result'; id: string; result?: unknown; error?: string }
  /** Host-wide queue/job/projection stream. */
  | { type: 'event'; channel: 'control'; frame: SessionControlFrame }
  /** Workspace set/order/archived stream. */
  | { type: 'event'; channel: 'workspace'; frame: WorkspaceFollowFrame }
  /** The followed session's journal. Every generation begins with a `snapshot`. */
  | { type: 'event'; channel: 'session'; frame: SessionFollowFrame }
  /** One sparse broadcast host event with its positional arguments. */
  | { type: 'event'; channel: 'remote'; event: string; args: unknown[] }
  /**
   * One logical stream died. A dead stream does NOT drop the connection, so
   * without this message the failure would be invisible.
   */
  | { type: 'stream-error'; scope: string; error: RpcError }
  /** Host lifecycle notification. */
  | { type: 'host-status'; status: HostStatus }
  /**
   * Toolbar command forwarded to the webview (extension of the frozen table for
   * the W1 commands; the webview store owns the actual behavior).
   */
  | { type: 'command'; command: 'newChat' | 'openSettings' }
  /**
   * IDE content answering an `ide-request` (or a toolbar command): the
   * extension reads the active editor and posts the text back here.
   */
  | ({ type: 'ide-content' } & IdeContentPayload)
  /**
   * Code-jump receipt answering an `ide-open-file` that carried an `id`:
   * `path` is the resolved absolute file on success; `error` is the
   * human-readable failure (unresolvable path, vscode open failure).
   */
  | { type: 'ide-open-file-result'; id: string; path?: string; error?: string }
