/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/host/apiproxy/src/api/sessions.ts
 * Session-domain payload/value types. Method signatures upstream are the source
 * of truth; here only the payload/value shapes are kept (see rpc-map.ts).
 * Simplification: SessionProjectionMap (merge-extensible upstream) is flattened
 * to a `Record<string, unknown>`-style partial map with the known keys.
 */

import type { AttachmentId, MessageId, SessionId, WorkspaceId } from './brand'
import type { ContentBlock, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from './llm'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  SessionStatsProjection,
  TokenUsageProjection,
} from './projections'
import type { SessionEvent } from './session'
import type { ToolEventView } from './events'

/** Persisted hints used to summarize a cold session without reading a large log. */
export interface SessionListMetadata {
  /** Whether the checkpoint prefix contains no turn/start event. */
  blank: boolean
  /** Latest source.kind=user message time in the checkpoint prefix. */
  lastPromptAt: number | null
}

/**
 * Known session projection keys. `title` (string) rides the generic projection
 * pair; `sessionListMetadata` and `imageLimits` are documented upstream.
 * Unknown keys remain accessible via the index signature.
 */
export interface SessionProjectionValues {
  title?: string
  sessionListMetadata?: SessionListMetadata
  imageLimits?: ImageAttachmentLimits
  /** Whole-log turn/step counts and wall times (session-stats unit). */
  sessionStats?: SessionStatsProjection
  /** Provider-reported usage across the durable log (token-meter unit). */
  tokenUsage?: TokenUsageProjection
  /** Approximate context occupancy (token-meter unit). */
  contextPressure?: ContextPressureProjection
  /** Heuristic context composition (token-meter unit). */
  contextBreakdown?: ContextBreakdownProjection
  [key: string]: unknown
}

/**
 * The projection baseline riding the history tail page: one synchronous cut
 * over every registered projection unit. A key absent from `values` means the
 * capability is absent.
 */
export interface SessionProjectionsBlock {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: number
  /** Whole current value per registered projection key. */
  values: SessionProjectionValues
}

/**
 * One history page entry: the raw event plus the optional host-computed render
 * intent (a pagination-time derivation, never persisted).
 */
export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

/** Browser-submitted prompt content; the host promotes image bytes to durable references. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }

/** Complete model selection for one session. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort; absence preserves adapter/provider default behavior. */
  reasoningEffort?: string
}

/** One adapter-owned reasoning effort displayed for an exact model route. */
export interface ModelReasoningEffort {
  /** Opaque value submitted back to the owning adapter. */
  id: string
  /** Adapter-supplied display name. */
  name: string
  /** Optional adapter-supplied description. */
  description?: string
}

/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  /** Efforts in adapter-preferred display order. */
  efforts: ModelReasoningEffort[]
  /** Adapter-configured default; absence preserves the provider default. */
  defaultEffort?: string
}

/** One model displayed inside its provider group. */
export interface ModelCatalogModel {
  /** Provider-owned model id. */
  id: string
  /** Provider-supplied display name. */
  name: string
  /** Optional provider-supplied description. */
  description?: string
  /** Exact-route reasoning metadata when the adapter exposes it. */
  reasoning?: ModelReasoning
}

/** One provider and the models it advertised successfully. */
export interface ModelProviderGroup {
  /** Provider route id used for requests. */
  id: string
  /** Provider display name. */
  name: string
  /** Models in provider-preferred order. */
  models: ModelCatalogModel[]
}

/** A provider whose asynchronous catalog lookup failed. */
export interface ModelCatalogFailure {
  /** Provider route id. */
  id: string
  /** Provider display name. */
  name: string
  /** Lookup failure diagnostic. */
  message: string
}

/** Detached model-directory snapshot for one session. */
export interface SessionModels {
  /** Model selection for the session's next assembled step. */
  current: ModelSelection
  /** Whether an adapter currently serves `current.provider`. */
  routable: boolean
  /** Successfully loaded provider groups. */
  groups: ModelProviderGroup[]
  /** Provider-local failures; successful groups remain usable. */
  failures: ModelCatalogFailure[]
}

/** A client-requested mutation of one still-pending queue item. */
export type QueueAction =
  | { kind: 'edit'; content: ContentBlock[] }
  | { kind: 'remove' }
  | { kind: 'steer' }

/** One session list entry. */
export interface SessionSummary {
  sessionId: SessionId
  /** The later of creation and the latest human-authored prompt. */
  updatedAt: number
  /** Status of the attached agent; always false for cold (unattached) sessions. */
  running: boolean
  /** Derived conversation-not-started bit: true while no turn has run. */
  blank: boolean
  /** fork/spawn lineage; absent for root sessions. */
  parentSessionId?: SessionId
  /** Coarse durable origin used by navigation surfaces. */
  origin?: 'subagent'
  /** Session working directory (header.cwd passthrough); absent when unrecorded. */
  cwd?: string
  /** Agent preset this session's agent was composed from. */
  agentPreset?: string
  /** Projection baseline for this row (never wrong, possibly stale per asOfSeq). */
  projections?: SessionProjectionsBlock
}

/** One session-content search result; display metadata stays owned by `session.list`. */
export interface SessionSearchItem {
  sessionId: SessionId
  /** Plain-text excerpt around the strongest matching visible message. */
  snippet: string
}

/** Payload/value shapes of the session-domain RPC methods. */
export interface SessionRpc {
  'session.list': { payload: { cursor?: string }; value: { items: SessionSummary[] } }
  'session.search': { payload: { query: string }; value: { items: SessionSearchItem[]; hasMore: boolean } }
  'session.create': {
    payload: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentPreset?: string }
    value: { sessionId: SessionId; agentPreset?: string }
  }
  'session.history': {
    payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }
    value: { events: HistoryEntry[]; hasMore: boolean; projections?: SessionProjectionsBlock }
  }
  'session.models': { payload: { sessionId: SessionId }; value: SessionModels }
  'session.selectModel': {
    payload: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }
    value: { selected: ModelSelection }
  }
  'session.rename': { payload: { sessionId: SessionId; title: string }; value: { title: string; seq: number } }
  'session.fork': { payload: { sessionId: SessionId; atSeq?: number }; value: { sessionId: SessionId } }
  'session.prompt': {
    payload: { sessionId: SessionId; mode: 'queue' | 'steer'; content: PromptContentPart[]; clientTimeZone?: string }
    value: { accepted: true; command?: { kind: 'success'; text?: string } }
  }
  'session.attachment': {
    payload: { sessionId: SessionId; attachmentId: AttachmentId }
    value: { attachment: ImageAttachmentRef; data: string }
  }
  'session.updateQueue': { payload: { sessionId: SessionId; itemId: MessageId; action: QueueAction }; value: { accepted: true } }
  'session.cancel': { payload: { sessionId: SessionId }; value: { accepted: true } }
}
