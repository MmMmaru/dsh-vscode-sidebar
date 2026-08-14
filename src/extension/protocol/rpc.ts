/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/host/apiproxy/src/api/rpc.ts
 * Four-quadrant RPC message model: HTTP/WebSocket are physical carriers, while
 * logical messages form a four-member discriminated union.
 * Simplifications vs upstream: zod's $ZodIssue in 'bad-request' details is
 * replaced by `unknown[]`, and the runtime helpers (RpcId mint, transportError)
 * are kept because the extension client uses them.
 */

import type { Branded, MessageId, SessionId } from './brand'

/**
 * Message correlation id: the initiator mints it on a request; a response
 * echoes the matching request's rpcId and never mints a new one.
 */
export type RpcId = Branded<'rpc-id'>

/**
 * Brand a string as RpcId. Minted by the initiator:
 * client-request → client mints; server-request → host mints.
 * @param id - Raw id string (implementations mint UUIDs; tests may pass fixtures).
 * @returns The same string, branded (compile-time cast, zero runtime cost).
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Error code → details type map. New code = one row here. */
export interface RpcErrorDetailsMap {
  'bad-request': { issues: unknown[] }
  'cancelled': {}
  'session-not-found': { sessionId: SessionId }
  'model-unavailable': { provider: string; model: string }
  'session-conflict': { sessionId: SessionId; requestedCwd: string; existingCwd?: string }
  'invalid-time-zone': { value: string }
  'workspace-attach-failed': { sessionId: SessionId; workspaceId: string }
  'workspace-not-found': { workspaceId: string }
  'workspace-invalid-path': { path: string }
  'workspace-name-conflict': { name: string }
  'workspace-move-invalid': { workspaceId: string; sessionId: SessionId; beforeSessionId?: SessionId }
  'directory-unreadable': { path: string }
  'directory-exists': { path: string }
  'directory-create-failed': { path: string }
  'directory-picker-unavailable': { capability: string }
  'agent-preset-read-only': { agentPreset: string; reason: string }
  'agent-preset-locked': { sessionId: SessionId; agentPreset: string }
  'agent-preset-conflict': { sessionId: SessionId; requestedPreset: string; existingPreset?: string }
  'agent-preset-not-found': { agentPreset: string; available: string[] }
  'agent-preset-invalid': { agentPreset: string; reason: string }
  'agent-busy': { reason: string }
  'attachment-error': { reason: string }
  'queue-item-not-found': { itemId: MessageId }
  'steer-unavailable': { itemId: MessageId }
  /** A known slash command reported a usage/state error. */
  'command-error': {}
  /** A leading-/ prompt named no registered command. */
  'unknown-command': {}
  /** A settings write was refused (schema validation, unknown namespace, read-only provider, storage failure). */
  'settings-rejected': { ns: string }
  /** The namespace exists but is outside the configuration plane this proxy exposes. */
  'settings-not-exposed': { ns: string }
  /** The write carried an `expectedRevision` the namespace has already moved past. */
  'settings-conflict': { ns: string; expected: number; actual: number }
  /** A credential write was refused (read-only shadowing layer or storage failure). */
  'credential-rejected': { ref: string }
  /** Interrogating a draft provider endpoint did not produce a model listing. */
  'model-discovery-failed': { settingsNs: string; baseURL?: string }
  'title-invalid': { sessionId: SessionId }
  'fork-unavailable': { sessionId: SessionId }
  'subagent-parent-unavailable': { parentSessionId: SessionId }
  'subagent-not-found': { parentSessionId: SessionId; childSessionId: SessionId }
  'subagent-catalog-diagnostic': {
    parentSessionId: SessionId
    childSessionId: SessionId
    reason: 'corrupt' | 'unsupported' | 'unavailable'
  }
  'subagent-not-resumable': { childSessionId: SessionId }
  'subagent-unauthorized': { childSessionId: SessionId }
  'subagent-delivery-unavailable': { childSessionId: SessionId }
  'internal': {}
}

/** Closed error-code union (the keys of RpcErrorDetailsMap). */
export type RpcErrorCode = keyof RpcErrorDetailsMap

/** Distributive union: code is the discriminant, so `switch (error.code)` narrows details. */
export type RpcError = {
  [C in RpcErrorCode]: { code: C; message: string; details: RpcErrorDetailsMap[C] }
}[RpcErrorCode]

/** Business success/failure result: the result slot of a unary response; methods never throw business errors. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/**
 * Fold a transport exception into the RpcResult error branch ('internal' as the catch-all code).
 * @param error - the thrown value from the carrier.
 * @returns the error branch of an RpcResult.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

/** Signature-layer narrow form, request side: rpcId explicit, never mixed into the business payload. */
export interface RpcRequest<P> {
  rpcId: RpcId
  payload: P
}

/** Signature-layer narrow form, response side: rpcId always echoes the matching request. */
export interface RpcResponse<T> {
  rpcId: RpcId
  result: RpcResult<T>
}

// ---- Wire full forms: four named members of a discriminated union (discriminant = the four `type` literals) ----

/** Call initiated by the client (wire carrier: POST /api/<method> body). */
export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** Response to a ClientRequest (wire carrier: the HTTP response body of that POST); rpcId echoed. */
export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

/**
 * Message initiated by the server (wire carrier: downstream stream frame). Answerable
 * interactions (approval/question requested — stable rpcId) and pure pushes share this shape.
 */
export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** Response to a ServerRequest (wire carrier: POST /api/respond body); rpcId echoed, never minted anew. */
export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

/** Authoritative wire full-form union; narrow via `switch (message.type)`. */
export type RpcMessage = ClientRequest | ServerResponse | ServerRequest | ClientResponse

/**
 * Carrier receipt: the HTTP response body of the POST carrying a client-response.
 * Late/duplicate responses yield not-pending.
 */
export type RpcReceipt = { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }
