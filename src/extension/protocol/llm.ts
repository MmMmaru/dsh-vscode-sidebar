/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/llm/llm/src/types.ts        (content blocks, StreamChunk, TokenUsage, LlmFailure, ToolSchema)
 *   packages/llm/llm/src/message.ts      (Message family, MessageSource)
 *   packages/attachment/attachment/src/types.ts (ImageMediaType, ImageAttachmentRef, ImageAttachmentLimits)
 * Type-only minimal copy; merge-extensible maps from upstream are flattened
 * into plain unions here (the plugin is a consumer, not an extender).
 */

import type { AttachmentId, CallId, MessageId } from './brand'

/** Media types accepted for image attachments. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}

/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: string
}

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** A durable raster image reference, valid in user or assistant content. */
export interface ImageBlock {
  type: 'image'
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError?: boolean
}

/** Any known content block; switch on `type` and fall through unknowns. */
export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

/** The block `type` tag vocabulary. */
export type ContentBlockType = ContentBlock['type']

/** Why a model response stopped. */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/**
 * Token accounting for one model call (cache fields are optional). Counts are
 * DISJOINT: `inputTokens` is uncached input only; cached input is reported
 * separately as `cacheReadTokens`/`cacheWriteTokens`.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Raw streaming protocol emitted by adapters. Block indexes correlate
 * interleaved deltas, and `block-end` carries the assembled block.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

/** Provider/model identity and adapter-private replay data for an assistant message. */
export interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id that produced the message. */
  model: string
  /** Lossless-JSON adapter state needed to replay the provider response. */
  replayState?: unknown
}

/** Required source of an assistant message produced by a routed model. */
export interface ModelMessageSource extends AssistantProvenance {
  kind: 'model'
}

/** Required source of a user-role message carrying one tool result. */
export interface ToolMessageSource {
  kind: 'tool'
  callId: CallId
}

/** The kind of information in producer-supplied context (semantic, never visual). */
export type ContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

/** One named contribution to a `snapshot`-form context, in assembly order. */
export interface ContextSnapshotSection {
  readonly name: string
  readonly text: string
}

/** Producer-declared ContextForm plus the fields that form requires. */
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | { readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[] }
  | { readonly form: 'notice'; readonly summary: string }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

/** Where a message (or injected content) came from. */
export type MessageSource =
  | { kind: 'user' }
  | ({ kind: 'plugin'; plugin: string } & ContextFormed)
  | ModelMessageSource
  | ToolMessageSource

/** One immutable message representation shared by delivery, durable history, and model requests. */
export interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource
}

/** A user-role specialization of the one shared message representation. */
export interface UserMessage extends Message {
  readonly role: 'user'
}

/** A model-produced assistant specialization of the shared message representation. */
export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/** A tool-result specialization whose model-facing block retains call correlation. */
export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}

/** The conversation's call configuration carried by `request/header` events. */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
}

/** Effective config fields materialized from the exact adapter. */
export type LlmCallConfigAdapterDefaults = Record<string, unknown>
