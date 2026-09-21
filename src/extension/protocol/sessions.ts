/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: dsh 0.1.5-rc.2 (Typert Remote / api-gateway).
 * Sources (built install):
 *   dsh-api-session-controller/lib/types/{types,index}.d.ts
 * Session-domain payload/value types. The upstream descriptors are the source of
 * truth for wire names; here only the payload/value shapes are kept (see
 * rpc-map.ts).
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
import type { GoalProjection } from './goals'
import type { SessionEvent } from './session'
import type { ToolEventView } from './events'
import type { SessionAddress, SessionPageValue } from './follow'

/** Persisted hints used to summarize a cold session without reading a large log. */
export interface SessionListMetadata {
  /** Whether the checkpoint prefix contains no turn/start event. */
  blank: boolean
  /** Latest source.kind=user message time in the checkpoint prefix. */
  lastPromptAt: number | null
}

/**
 * Client view of the durable model-selection fold (projection key
 * `modelSelection`). Replaces the retired `session.models.current`: the route a
 * session will use next is `next ?? lastUsed`.
 */
export interface ModelSelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next request should use, falling back to `lastUsed`. */
  readonly next: ModelSelection | null
}

/**
 * Known session projection keys. Keys beyond this list stay reachable through
 * the index signature; an absent key means the projection unit is not mounted.
 */
export interface SessionProjectionValues {
  /** Latest normalized session title; null before the first title lands. */
  title?: string | null
  sessionListMetadata?: SessionListMetadata
  imageLimits?: ImageAttachmentLimits
  /** Durable model selection for the next request (replaces `session.models.current`). */
  modelSelection?: ModelSelectionProjection
  /** Agent preset this session's agent was composed from. */
  agentPreset?: string | null
  /** Whole-log turn/step counts and wall times (session-stats unit). */
  sessionStats?: SessionStatsProjection
  /** Provider-reported usage across the durable log (token-meter unit). */
  tokenUsage?: TokenUsageProjection
  /** Approximate context occupancy (token-meter unit). */
  contextPressure?: ContextPressureProjection
  /** Heuristic context composition (token-meter unit). */
  contextBreakdown?: ContextBreakdownProjection
  /** Current goal projection; null is the durable clear/pre-create tombstone. */
  goal?: GoalProjection | null
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

/**
 * Host-wide model catalog returned by `session/modelCatalog`.
 *
 * Replaces both the retired `session.models` and `llm.models`. Two differences
 * from `SessionModels` matter to consumers:
 *   - `default` is the host's configured default route (which the retired
 *     `host.describe` used to supply), not a per-session selection; the
 *     per-session selection now arrives as the `modelSelection` projection.
 *   - `routableProviders` is a flat provider-id list, not the previous
 *     boolean pair.
 */
export interface SessionModelCatalog {
  /** Host-configured default route used when a session selects none. */
  default: ModelSelection
  /** Provider ids the host can currently route to. */
  routableProviders: string[]
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

/** Payload/value shapes of the session-domain unary Remote methods (0.1.5-rc.2). */
export interface SessionRpc {
  /**
   * The only method whose wire parameter is not named `request`: the upstream
   * signature is `list(_request: SessionListRequest)`, and `args` must carry the
   * exact descriptor name, so the payload key is literally `_request`.
   */
  'session/list': { payload: { _request: { cursor?: string } }; value: { items: SessionSummary[] } }
  'session/create': {
    payload: { request: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentPreset?: string } }
    value: { sessionId: SessionId; agentPreset?: string }
  }
  /** Backward paging of one addressed journal; `throughSeq` comes from the follow snapshot `cursor`. */
  'session/page': {
    payload: { request: { address: SessionAddress; throughSeq: number; beforeSeq?: number; maxMessages?: number } }
    value: SessionPageValue
  }
  /** Host-wide model catalog; replaces both `session.models` and `llm.models`. Takes no arguments. */
  'session/modelCatalog': { payload: Record<string, never>; value: SessionModelCatalog }
  'session/selectModel': {
    payload: { request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string } }
    value: { selected: ModelSelection }
  }
  'session/rename': {
    payload: { request: { sessionId: SessionId; title: string } }
    value: { title: string; seq: number }
  }
  'session/fork': { payload: { request: { sessionId: SessionId; atSeq?: number } }; value: { sessionId: SessionId } }
  'session/prompt': {
    payload: {
      request: {
        /** Client-minted and required in 0.1.5-rc.2; echoed by the queue/command events. */
        requestId: string
        sessionId: SessionId
        mode: 'queue' | 'steer'
        content: PromptContentPart[]
        clientTimeZone?: string
      }
    }
    /** The old `command` field is gone: slash commands report through `commands/execute`. */
    value: { accepted: true }
  }
  'session/attachment': {
    payload: { request: { sessionId: SessionId; attachmentId: AttachmentId } }
    value: { attachment: ImageAttachmentRef; data: string }
  }
  'session/updateQueue': {
    payload: { request: { sessionId: SessionId; itemId: MessageId; action: QueueAction } }
    value: { accepted: true }
  }
  'session/cancel': { payload: { request: { sessionId: SessionId } }; value: { accepted: true } }
  'session/openWorkspacePath': {
    payload: { request: { path: string; action?: 'reveal' } }
    value: { opened: true }
  }
  'session/canOpenWorkspacePath': { payload: Record<string, never>; value: boolean }
}

/**
 * Parameters of the session-domain stream methods. Streams are not unary, so
 * they stay out of {@link RpcMethodMap}; the client opens them on the mux
 * carrier with these args and consumes {@link import('./follow').SessionFollowFrame}
 * / {@link import('./follow').SessionControlFrame}.
 */
export interface SessionStreamMap {
  /** One addressed session's durable journal plus live events. */
  'session/follow': { request: { address: SessionAddress; maxMessages?: number; assistantStream?: true } }
  /** Host-wide queues, jobs, and projection values. Takes no arguments. */
  'session/control': Record<string, never>
}
