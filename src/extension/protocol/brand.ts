/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/util/brand/src/index.ts                       (Branded)
 *   packages/core/session/src/types.ts                     (SessionId)
 *   packages/llm/llm/src/brand.ts                          (MessageId, CallId)
 *   packages/interaction/user-approval/src/types.ts        (ApprovalRequestId)
 *   packages/host/apiproxy/src/api/workspace.ts            (WorkspaceId)
 *   packages/host/apiproxy/src/api/goals.ts                (GoalId)
 *   packages/core/session/src/json.ts                      (JsonValue)
 * Type-only minimal copy: brands are compile-time casts with zero runtime cost.
 * Do not hand-edit semantics; re-copy when upgrading dsh.
 */

declare const BRAND: unique symbol

/** Branded string base type (compile-time only). */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/** Stable identity of one message. */
export type MessageId = Branded<'MessageId'>

/** Provider-issued tool call id; correlates a tool/call with its tool/result. */
export type CallId = Branded<'CallId'>

/** Identifies one approval request. */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/** Wire-side workspace id brand. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Identifies one goal across its durable revisions. */
export type GoalId = Branded<'GoalId'>

/** Registry-issued background job identity (`<kind>-N`). */
export type JobId = Branded<'JobId'>

/** Opaque attachment storage identifier. */
export type AttachmentId = Branded<'AttachmentId'>

/** Lossless-JSON value bound: everything on the wire conforms to this. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
