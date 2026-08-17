/**
 * Bridge message protocol (extension host <-> webview), the frozen contract of
 * ARCHITECTURE.md section 3. All messages are JSON objects carried by
 * `vscode.postMessage` / `onDidReceiveMessage`. Shared by both sides: the
 * extension posts ExtensionMessage, the webview posts WebviewMessage.
 */

import type { ApprovalRequestId, SessionId } from '../extension/protocol/brand'
import type { AskUserQuestionAnswerItem, MuxFrame, HostFrame } from '../extension/protocol/events'

/** Host lifecycle states pushed to the webview. */
export type HostStatus = 'starting' | 'ready' | 'down'

/** What IDE content a `requestIdeContent` / `ide-content` message carries. */
export type IdeContentKind = 'selection' | 'active-file'

/**
 * Replayed answerable-frame facts: the extension host retains pending
 * approval/question frames while no webview is attached (a hidden sidebar
 * webview is disposed and re-resolved later), and hands them back in the init
 * payload so the takeover panel can re-appear after switching back.
 */
export type PendingOverlayReplay =
  | { kind: 'approval'; frame: Extract<MuxFrame, { type: 'approval/requested' }> }
  | { kind: 'question'; frame: Extract<MuxFrame, { type: 'question/requested' }> }

/**
 * UI-facing session list row (SessionMeta of ARCHITECTURE.md section 5.4).
 * Derived from the vendored SessionSummary by the bridge: `title` is read from
 * the row's `title` projection (null when absent).
 */
export interface SessionMeta {
  sessionId: SessionId
  /** Session title from the projection baseline; null means "no title yet". */
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
  /** dsh host app version reported by `host.describe`. */
  hostVersion: string
  /** Full session list; the webview filters by `cwd`. */
  sessions: SessionMeta[]
  /**
   * Answerable frames that arrived while no webview was attached (sidebar
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
  /** Passthrough dsh RPC; `method` is e.g. `session.list`. Answered by `rpc-result`. */
  | { type: 'rpc'; id: string; method: string; params?: unknown }
  /**
   * Answer an answerable frame (contract addition, ARCHITECTURE.md section 3
   * revision 2). Approval/question requests are server-requests answered via
   * POST /api/respond echoing the frame's rpcId; that rpcId never reaches the
   * webview (the MuxFrame union does not carry it), so the webview correlates
   * by `approvalId` / `sessionId` and the extension resolves the rpcId from
   * the client's pending-request tables.
   */
  | { type: 'respond'; kind: 'approval'; approvalId: ApprovalRequestId; decision: 'allow-once' | 'refuse' }
  | { type: 'respond'; kind: 'question'; sessionId: SessionId; answers: AskUserQuestionAnswerItem[] }
  /** Ask the extension host for IDE content (selection / active file). An
   * `id` turns the push into a request/response pair (send-time auto-inject);
   * without it the answer fans out to the fire-and-forget subscribers. */
  | { type: 'ide-request'; kind: IdeContentKind; id?: string }

/** Messages the extension host sends to the webview. */
export type ExtensionMessage =
  /** Initialization data answering `ready`. */
  | ({ type: 'init' } & InitPayload)
  /** RPC answer paired by `id`. */
  | { type: 'rpc-result'; id: string; result?: unknown; error?: string }
  /** dsh event stream passthrough. */
  | { type: 'event'; channel: 'mux' | 'host'; frame: MuxFrame | HostFrame }
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
