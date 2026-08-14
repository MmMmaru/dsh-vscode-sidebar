/**
 * UI-layer view models (ARCHITECTURE.md section 5.4). Every type here is
 * derived from the vendored protocol types under src/extension/protocol/ (or
 * the bridge SessionMeta of src/shared/bridge.ts); no backend concept is
 * invented. Components consume only these types plus the store actions.
 */

import type {
  ApprovalRequestId,
  AttachmentId,
  CallId,
  GoalId,
  MessageId,
  SessionId,
} from '../extension/protocol/brand'
import type {
  AskUserQuestionItem,
  QueuedInboxItem,
} from '../extension/protocol/events'
import type {
  ContentBlock,
  ContextForm,
  ImageMediaType,
  Message,
  ModelMessageSource,
} from '../extension/protocol/llm'
import type { TodoItem } from '../extension/protocol/session'
import type { ModelReasoning, ModelSelection } from '../extension/protocol/sessions'
import type { ToolCallView, ToolResultView } from '../extension/protocol/tool-views'
import type { SessionMeta } from '../shared/bridge'

// `SessionMeta` is defined on the bridge contract (src/shared/bridge.ts) and
// re-exported here so UI code has a single import surface.
export type { SessionMeta }
export type { TodoItem, ModelSelection, AskUserQuestionItem }

// ---------------------------------------------------------------------------
// ConversationNode: the discriminated union the conversation view renders.
// Projected from SessionEvent frames by applyMuxFrame (store/conversation.ts).
// ---------------------------------------------------------------------------

/** Fields every conversation node carries. */
interface NodeBase {
  /** Stable React key: `e<seq>` for event-backed nodes, `stream-<n>` for live ones. */
  id: string
  /** Seq of the last event that touched this node (ordering / fork anchor). */
  seq: number
  /** Epoch ms of the last event that touched this node. */
  time: number
}

/** A human-authored message (`user/message` with source.kind = 'user'). */
export interface UserMessageNode extends NodeBase {
  kind: 'user-message'
  messageId: MessageId
  /** Visible content: text and image blocks only. */
  blocks: ContentBlock[]
}

/** Visible assistant text for one step (`assistant/message` text blocks). */
export interface AssistantTextNode extends NodeBase {
  kind: 'assistant-text'
  text: string
  /** True while stream deltas are still arriving (two-phase rendering). */
  streaming: boolean
  /** Provenance of the producing model, when known. */
  provenance?: ModelMessageSource
}

/** A collapsible Think row (`assistant/message` reasoning blocks). */
export interface ReasoningNode extends NodeBase {
  kind: 'reasoning'
  text: string
  streaming: boolean
}

/** One tool invocation, from `tool/call` to its matching `tool/result`. */
export interface ToolCallNode extends NodeBase {
  kind: 'tool-call'
  callId: CallId
  name: string
  /** Raw JSON arguments string as produced by the model. */
  arguments: string
  status: 'pending' | 'done' | 'error'
  /** Host-computed render intents riding the mux frames, when present. */
  callView?: ToolCallView
  resultView?: ToolResultView
  /** Flattened plain-text result for the generic card fallback. */
  resultText?: string
  /** Structured failure facts when the call errored. */
  error?: { name: string; code: string }
}

/** Producer-injected context (`user/message` with source.kind = 'plugin'). */
export interface ContextInjectionNode extends NodeBase {
  kind: 'context-injection'
  /** Producer plugin name. */
  plugin: string
  /** Semantic form of the injected content, when declared. */
  form?: ContextForm
  text: string
}

/**
 * Context compaction marker. Reserved for W3: the vendored event vocabulary
 * signals compaction through surface `replace` ops; the projector materializes
 * this node when it applies one.
 */
export interface CompactionNode extends NodeBase {
  kind: 'compaction'
  /** Human-readable summary of what was compacted, when available. */
  summary?: string
}

/**
 * An automatic retry of a failed model call. Reserved for W3: derived from
 * turn/step events carrying an LlmFailure followed by a new step.
 */
export interface RetryNode extends NodeBase {
  kind: 'retry'
  /** 1-based attempt number being retried. */
  attempt: number
  message?: string
}

/** A surfaced failure (turn/end error, host/agent-error, stream/error). */
export interface ErrorNode extends NodeBase {
  kind: 'error'
  message: string
  /** Stable machine-routing code, when the failure carried one. */
  code?: string
}

/** Everything the conversation view can render; narrow on `kind`. */
export type ConversationNode =
  | UserMessageNode
  | AssistantTextNode
  | ReasoningNode
  | ToolCallNode
  | ContextInjectionNode
  | CompactionNode
  | RetryNode
  | ErrorNode

/** Conversation-level turn lifecycle, projected from turn/start + turn/end. */
export type TurnStatus = 'idle' | 'running'

// ---------------------------------------------------------------------------
// Takeover overlays (approval / question / plan review)
// ---------------------------------------------------------------------------

/** A pending tool approval, straight from the `approval/requested` frame. */
export interface ApprovalRequest {
  sessionId: SessionId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  reason?: string
}

/** A pending ask-user batch, straight from the `question/requested` frame. */
export interface QuestionRequest {
  sessionId: SessionId
  questions: AskUserQuestionItem[]
}

/**
 * Plan-review overlay state, derived from a QuestionRequest whose question
 * carries `intent.kind = 'plan-review'`. Approving answers the question with
 * the intent's `approve` option label; any other answer declines.
 */
export interface PlanReviewState {
  /** The plan markdown (the question's `detail`). */
  plan: string
  /** Option label that approves the plan. */
  approveLabel: string
  /** The underlying request; answered through answerQuestion. */
  request: QuestionRequest
  /** Id of the question carrying the plan-review intent. */
  questionId: string
}

// ---------------------------------------------------------------------------
// Composer view models
// ---------------------------------------------------------------------------

/** One pending inbox message, flattened from the `session/queue` snapshot. */
export interface QueuedMessage {
  /** Message identity used by queue mutations (edit/remove/steer). */
  id: MessageId
  /** Agent-resolved FIFO placement. */
  placement: QueuedInboxItem['placement']
  /** Flattened plain-text preview of the message content. */
  text: string
  /** The full pending message, for editors that need the blocks. */
  message: Message
}

/** One selectable model, flattened from its provider group (ModelCatalogModel). */
export interface ModelInfo {
  /** Provider route id used for requests. */
  provider: string
  /** Provider display name (group header). */
  providerName: string
  /** Provider-owned model id. */
  id: string
  /** Display name. */
  name: string
  description?: string
  /** Exact-route reasoning metadata when the adapter exposes it. */
  reasoning?: ModelReasoning
}

/**
 * Permission mode selector value (UI-owned concept; the dsh protocol has no
 * per-message permission field — the mode gates which tools need approval on
 * the agent side and is a host-level setting).
 */
export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access'

/**
 * Goal mode state. Goal reads ride session projections upstream; this is the
 * UI projection of the goal projection unit (P1, refined by W4).
 */
export interface GoalState {
  /** Compare-and-set identity of the current revision. */
  id: GoalId
  revision: number
  objective: string
  status: 'active' | 'paused' | 'completed'
  round?: number
  maxRounds?: number
}

/** Per-turn token accounting, accumulated from `assistant/message` usage. */
export interface TurnStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** One not-yet-sent image attachment held by the composer. */
export interface Attachment {
  /** Local UI id (crypto.randomUUID); NOT the durable AttachmentId. */
  id: string
  name?: string
  mediaType: ImageMediaType
  /** Base64 image bytes; promoted to a durable reference by the host on send. */
  data: string
  /** Object URL for the thumbnail rail (revoked on remove/send). */
  previewUrl?: string
}

/** Re-export so attachment payloads can reference the durable id brand. */
export type { AttachmentId }
