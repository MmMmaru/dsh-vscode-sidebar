/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/host/apiproxy/src/api/events.ts    (MuxFrame, HostFrame, QueuedInboxItem, ToolEventView)
 *   packages/interaction/user-questions/src/types.ts (AskUserQuestionItem family)
 *   packages/interaction/user-approval/src/types.ts  (ApprovalOutcome)
 * Frame unions for the two logical streams (mux + host). Streams yield the
 * narrow form RpcRequest<Frame>; answerable frames (approval/question
 * requested) echo their rpcId in the client-response.
 */

import type { ApprovalRequestId, CallId, JsonValue, MessageId, SessionId } from './brand'
import type { Message } from './llm'
import type { SessionEvent } from './session'
import type { ToolCallView, ToolResultView } from './tool-views'
import type { RpcError, RpcId } from './rpc'
import type { JobView, WorkspaceView } from './views'

/** One pending inbox occurrence in the authoritative `session/queue` snapshot. */
export interface QueuedInboxItem {
  /** Message identity used by inbox mutations. */
  id: MessageId
  /** Agent-resolved FIFO placement. */
  placement: 'queued' | 'steering' | 'context'
  /** Complete pending message; it is not durable until the Agent claims it. */
  message: Message
}

/**
 * Host-computed render intent accompanying a `tool/call` or `tool/result`
 * event. A pure derivation, never persisted. An absent view means the client's
 * documented default (generic JSON card).
 */
export type ToolEventView =
  | { for: 'call'; view: ToolCallView }
  | { for: 'result'; view: ToolResultView }

/** The final outcome of one approval request. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/**
 * A caller-declared presentation intent: the question IS this kind of decision.
 * An intent changes presentation only, never the protocol.
 */
export type AskUserQuestionIntent = {
  /** A plan submitted for review: `detail` is the plan markdown, and the decision approves or declines it. */
  kind: 'plan-review'
  /** The option label that approves the plan; every other option declines it. */
  approve: string
}

/** One question in a user-questions request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
  /** Optional presentation intent for capable UIs. */
  intent?: AskUserQuestionIntent
}

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer to one ask() batch. */
export interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}

/**
 * Mux stream frames: raw session-event passthrough + control frames +
 * approval/question frames (requested = answerable server-request, the rest
 * are pure pushes). On open, the host emits a subscribed control frame for
 * every attached session, then replays each session's still-pending
 * approval/question requested frames (rpcId reused verbatim).
 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: ApprovalRequestId; outcome: ApprovalOutcome }
  | { type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  /** Complete transient inbox state after every enqueue, mutation, claim, or discard. */
  | { type: 'session/queue'; sessionId: SessionId; items: QueuedInboxItem[] }
  /** Complete set of background jobs this session can see, after every registry commit. */
  | { type: 'session/jobs'; sessionId: SessionId; jobs: JobView[] }
  /** One projection unit's finished value changed (higher-seq-wins). */
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }

/**
 * Host stream frames: session create/destroy, running-status flips, agent
 * failures with no turn position, and workspace/archive snapshot pushes.
 */
export type HostFrame =
  | {
    type: 'host/session-added'
    sessionId: SessionId
    blank: boolean
    parentSessionId?: SessionId
    origin?: 'subagent'
    cwd?: string
    agentPreset?: string
  }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  | { type: 'host/workspace-removed'; workspaceId: WorkspaceView['workspaceId'] }
  | { type: 'host/workspace-order-changed'; workspaceIds: WorkspaceView['workspaceId'][] }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: SessionId[] }
  /** One allowlisted host cordis event forwarded verbatim. */
  | { type: 'host/remote-event'; event: string; args: JsonValue[] }
  | { type: 'stream/error'; error: RpcError }
