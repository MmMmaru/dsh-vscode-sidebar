/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/core/session/src/types.ts
 * Type-only minimal copy of the session event log vocabulary; the upstream
 * merge-extensible SessionEventMap is flattened into a plain discriminated
 * union (the plugin reads events, it never extends the map).
 */

import type {
  AssistantMessage,
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  LlmFailure,
  StreamChunk,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from './llm'
import type { CallId, JsonValue } from './brand'

/** Why a turn ended (flattened from the upstream TurnEndReasonMap). */
export type TurnEndReason =
  | { kind: 'completed' }
  /** A cancellation request interrupted the live turn. */
  | { kind: 'aborted'; reason: TurnEndCancelCause }
  | { kind: 'blocked' }
  /** The turn failed with structured failure facts. */
  | { kind: 'error'; error: LlmFailure }
  /** At least one step reached its output-token ceiling. */
  | { kind: 'max-tokens' }
  /** A persistence backend closed a crash-orphaned turn on reload. */
  | { kind: 'interrupted' }

/** Why an active agent driver was cancelled (`legacy` covers imports with no cause). */
export type TurnEndCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }
  | { readonly kind: 'legacy' }

/**
 * One entry in an agent's todo list — the unit of the `todo/write` event's
 * whole-list snapshot. Deliberately minimal: no id, priority, or activeForm.
 */
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks a task being worked now. */
  status: 'pending' | 'in_progress' | 'completed'
}

/** Logged request state outside derived history: call config, system prompt, and tools. */
export interface EpochHeader {
  /** The conversation's call configuration. */
  config: LlmCallConfig
  /** Effective config fields materialized from the exact adapter. */
  adapterDefaults?: LlmCallConfigAdapterDefaults
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
}

/** Registration-bound metadata for one resolved model route. */
export interface RequestContext {
  /** Registered provider route the metadata belongs to. */
  provider: string
  /** Provider-owned model id the metadata belongs to. */
  model: string
  /** Maximum combined request and response context in tokens, when advertised. */
  contextWindow?: number
}

/** Why a `request/header` snapshot was appended. */
export type RequestHeaderReason = 'initial' | 'resume' | 'change'

/** How a session event entered the ordered surface. */
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

/** The append-only source of truth for an agent interaction (event type -> data). */
export interface SessionEventMap {
  /** Opens turn `turn` before the loop claims queued input or runs pre-step. */
  'turn/start': { turn: number }
  /** Closes turn `turn` with the reason that ended it. */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus its tool executions. */
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  'step/end': { turn: number; step: number }
  /** A user-role message on the model-visible surface. */
  'user/message': UserMessage
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /** Assembled assistant message for one step, with optional token accounting. */
  'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
  /** The model requested one tool invocation (raw JSON arguments string). */
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  /** A completed tool call's model-facing result plus optional failure/meta. */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
    meta?: JsonValue
  }
  /** Whole-list todo snapshot; latest write wins on replay. */
  'todo/write': { todos: TodoItem[] }
  /** Full header for the next request (log-only). */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  /** Route metadata for the next request (log-only). */
  'request/context': RequestContext
  /** Marks the end of a constructor seed (log-only, empty payload). */
  'session/end-seed': Record<string, never>
}

/** The appendable event-type keys, plugin-merged extensions included upstream. */
export type SessionEventType = keyof SessionEventMap

/** Event types whose events produce LLM messages and are eligible for the ordered surface. */
export type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'

/**
 * One immutable entry in the session log: a discriminated union over `type`,
 * so `switch (event.type)` narrows `event.data` without casts.
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
    /** Marks an event a reader may safely skip when it does not recognize `type`. */
    ignorable?: true
  } & (K extends SurfaceEventType ? {
    /** Seq numbers of earlier events that this event cites as sources. */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
