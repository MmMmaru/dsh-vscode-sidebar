/**
 * Unary carrier for Typert Remote endpoints.
 * Vendored wire contract (dsh 0.1.5-rc.2):
 *   POST http://127.0.0.1:<port>/api/<namespace>/<method>
 *   {"type":"client-request","rpcId":<uuid>,"method":"<namespace>/<method>",
 *    "payload":{"args":{...}}}
 *   -> {"type":"server-response","rpcId":<echo>,
 *       "result":{"ok":true,"value":V} | {"ok":false,"error":{code,message,details}}}
 *
 * Notes that matter in practice:
 *   - `payload` always nests the method arguments under `args`, and the argument
 *     field names are the Host method's parameter names (so `session/list` takes
 *     `_request`, not `request`).
 *   - An unknown route answers HTTP 404 with the plain-text body `not found`, and
 *     a missing/expired credential answers 401 `unauthorized`. Both must be
 *     classified BEFORE JSON parsing, otherwise the parser reports a confusing
 *     `Unexpected token 'u', "unauthorized" is not valid JSON`.
 *   - Business failures are `ok:false` inside a 200 response; they never use an
 *     HTTP error status.
 *
 * Pure Node (global fetch, Node >= 22); no vscode runtime import, so this module
 * stays unit-testable under node:test.
 */

import * as crypto from 'node:crypto'
import type { ClientRequest, ServerResponse } from '../protocol/rpc'
import { RpcId } from '../protocol/rpc'

/** Default per-call deadline; a hung host must not stall the whole UI. */
export const UNARY_TIMEOUT_MS = 30_000

/** Business error raised when the host answers `ok:false`. */
export class RpcBusinessError extends Error {
  constructor(
    /** Stable machine-routing code from the Remote error union. */
    readonly code: string,
    message: string,
    /** Structured details carried by the error code's details row. */
    readonly details: unknown,
  ) {
    super(message)
    this.name = 'RpcBusinessError'
  }
}

/** Transport-level failure: the call never produced a business result. */
export class RpcTransportError extends Error {
  constructor(
    message: string,
    /** HTTP status when one was received, else undefined. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RpcTransportError'
  }
}

/** Facts one unary call needs: where the host is and how to authenticate. */
export interface UnaryTarget {
  /** `http://127.0.0.1:<port>` with no trailing slash. */
  baseUrl: string
  /** Signed browser-session cookie, when the host requires browser auth. */
  cookie?: string
  /** Bearer token, when the host is configured for token auth instead. */
  token?: string
}

/**
 * Build the header set for one authenticated host request.
 * @param target - host address plus credentials.
 * @param base - headers the caller already decided on.
 * @returns a fresh header record to hand to fetch.
 */
export function hostHeaders(target: UnaryTarget, base: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...base }
  if (target.token !== undefined && target.token !== '') headers['Authorization'] = `Bearer ${target.token}`
  if (target.cookie !== undefined && target.cookie !== '') headers['Cookie'] = target.cookie
  return headers
}

/** Outcome of one unary call before the result slot is unwrapped. */
export type UnaryOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'business'; error: { code: string; message: string; details: unknown } }
  | { kind: 'transport'; status: number; body: string }

/**
 * Perform one unary Remote call and classify its outcome without throwing.
 * A caller that wants exceptions uses {@link callRemoteUnary}.
 * @param target - host address plus credentials.
 * @param endpoint - Remote endpoint, `<namespace>/<method>`.
 * @param args - method arguments, placed under `payload.args`.
 * @param options - timeout and cancellation overrides.
 * @returns the classified outcome.
 */
export async function callRemoteOutcome(
  target: UnaryTarget,
  endpoint: string,
  args: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<UnaryOutcome> {
  const request: ClientRequest = {
    type: 'client-request',
    rpcId: RpcId(crypto.randomUUID()),
    method: endpoint,
    payload: { args },
  }
  const timeout = options.timeoutMs ?? UNARY_TIMEOUT_MS
  const signals = [AbortSignal.timeout(timeout)]
  if (options.signal !== undefined) signals.push(options.signal)
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: hostHeaders(target, { 'content-type': 'application/json' }),
      body: JSON.stringify(request),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    return { kind: 'transport', status: 0, body: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      // A body that cannot be read still leaves the status as the diagnosis.
    }
    return { kind: 'transport', status: response.status, body }
  }
  let parsed: ServerResponse
  try {
    parsed = (await response.json()) as ServerResponse
  } catch (error) {
    return { kind: 'transport', status: response.status, body: error instanceof Error ? error.message : String(error) }
  }
  if (parsed.type !== 'server-response') {
    return { kind: 'transport', status: response.status, body: 'response is not a server-response envelope' }
  }
  if (parsed.rpcId !== request.rpcId) {
    return {
      kind: 'transport',
      status: response.status,
      body: `rpcId mismatch: sent ${request.rpcId}, got ${String(parsed.rpcId)}`,
    }
  }
  if (!parsed.result.ok) {
    const error = parsed.result.error
    return { kind: 'business', error: { code: error.code, message: error.message, details: error.details } }
  }
  return { kind: 'ok', value: parsed.result.value }
}

/**
 * Perform one unary Remote call, raising on any non-success outcome.
 * @param target - host address plus credentials.
 * @param endpoint - Remote endpoint, `<namespace>/<method>`.
 * @param args - method arguments, placed under `payload.args`.
 * @param options - timeout and cancellation overrides.
 * @returns the method's success value.
 * @throws {RpcBusinessError} when the host answered `ok:false`.
 * @throws {RpcTransportError} when the carrier failed or answered an error status.
 */
export async function callRemoteUnary<T>(
  target: UnaryTarget,
  endpoint: string,
  args: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const outcome = await callRemoteOutcome(target, endpoint, args, options)
  if (outcome.kind === 'ok') return outcome.value as T
  if (outcome.kind === 'business') {
    throw new RpcBusinessError(outcome.error.code, outcome.error.message, outcome.error.details)
  }
  throw new RpcTransportError(
    outcome.status === 401
      ? `unauthorized for ${endpoint}`
      : `transport failure for ${endpoint}: HTTP ${outcome.status} ${outcome.body}`.trim(),
    outcome.status,
  )
}
