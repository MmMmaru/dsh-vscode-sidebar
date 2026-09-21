/**
 * Forwarded Remote Events: the replacement for the retired apiproxy event
 * streams (`/api/events.mux` + `/api/events.host`) and for `POST /api/respond`.
 * Vendored from deepseek-harness at dsh 0.1.5-rc.2:
 *   - packages/api/gateway/src/types/stream-protocol.ts (frames)
 *   - packages/api/gateway/src/types/index.ts (dispatch + result parsing)
 *   - packages/api/remotes/src/types/remote-events.ts (forwarded allowlist)
 *   - packages/user/approval + packages/user/questions (waterfall payloads)
 *
 * The client opens one logical `$events` stream on the mux socket. The host
 * answers with a `ready` frame (carrying this generation's clientId and the
 * stable host facts), then `emit` frames for broadcast events and `waterfall`
 * frames for events that need an answer. A waterfall request is answered by a
 * unary call to `$events/result` while its lifetime is still open.
 */

import type { SessionId } from './brand'
import type { AskUserQuestionItem } from './events'

/** Internal mux endpoint owning the forwarded-event stream. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** Unary endpoint that settles one delivered waterfall request. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** Payload used to open the event stream; the host requires an empty args object. */
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** First frame of every event-stream generation: proves the source is ready. */
export interface RemoteEventReadyFrame {
  type: 'ready'
  /** Correlation id for every result this generation sends back. */
  clientId: string
  /** Stable host facts captured at registration (dsh 0.1.5-rc.2 sends `{ home }` only). */
  host: { home: string }
}

/** One broadcast host event; `args` are the event's own positional arguments. */
export interface RemoteEventEmitFrame {
  type: 'emit'
  event: string
  args: unknown[]
}

/**
 * One host event that needs an answer. `eventId` is the reply correlation id;
 * `agentId` is the Session the event is scoped to (the request's own `agent`
 * field is stripped before it reaches the wire).
 */
export interface RemoteEventWaterfallFrame {
  type: 'waterfall'
  event: string
  eventId: string
  agentId: SessionId
  request: Record<string, unknown>
}

/** The host withdrew a pending waterfall request (its Agent Context was released). */
export interface RemoteEventCancelFrame {
  type: 'cancel'
  eventId: string
}

/** Any frame of the forwarded-event stream. */
export type RemoteEventFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventWaterfallFrame
  | RemoteEventCancelFrame

// ---- Answering a waterfall request ----

/** Delegate the request to the next waterfall listener. */
export interface RemoteEventOutcomeNext {
  kind: 'next'
}

/** Claim the request and settle it with `value` (omitted means "no value"). */
export interface RemoteEventOutcomeResult {
  kind: 'result'
  value?: unknown
}

/** Claim the request and fail it; the host rebuilds an Error from these fields. */
export interface RemoteEventOutcomeRejected {
  kind: 'rejected'
  error: { name: string; message: string; code?: string; details?: unknown }
}

/** Closed settlement vocabulary of one delivered waterfall request. */
export type RemoteEventOutcome = RemoteEventOutcomeNext | RemoteEventOutcomeResult | RemoteEventOutcomeRejected

/** Args object of the `$events/result` unary call. */
export interface RemoteEventResultArgs {
  clientId: string
  eventId: string
  outcome: RemoteEventOutcome
}

// ---- Forwarded event allowlist (packages/api/remotes/src/types/remote-events.ts) ----

/** Every host event this application forwards, with its Cordis dispatch mode. */
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  { event: 'api-session/activity', mode: 'emit' },
  { event: 'api-session/added', mode: 'emit' },
  { event: 'api-session/error', mode: 'emit' },
  { event: 'api-session/removed', mode: 'emit' },
  { event: 'api-session/status', mode: 'emit' },
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'goal/activation-changed', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
] as const

// ---- Approval waterfall ----

/**
 * Closed approval outcomes. Callers fail closed on `unavailable`; the host maps
 * any unrecognized value to `unavailable`. `ApprovalOutcome` already carries the
 * exact wire vocabulary (see ./events), so it is reused rather than restated.
 */

/**
 * Wire request of the `approval/request` waterfall. The host projects the
 * request's `agent` field away before it crosses, so the requester identity is
 * carried by the frame's `agentId` instead.
 */
export interface ApprovalRequestWire {
  toolName: string
  callId?: string
  reason?: string
}

// ---- Ask-user-questions waterfall ----
// The question and answer shapes are already declared in ./events and match the
// host's user-questions package field for field; reuse them to avoid drift.

/** Wire request of the `user-questions/request` waterfall. */
export interface AskUserQuestionRequestWire {
  questions: AskUserQuestionItem[]
}

/**
 * Parse one host-to-client text frame of the `$events` stream.
 * @param text - complete WebSocket text message (the mux `item` value re-encoded).
 * @returns the validated frame.
 * @throws when the frame matches no legal shape.
 */
export function parseRemoteEventFrame(value: unknown): RemoteEventFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('remote events: frame is not an object')
  }
  const record = value as Record<string, unknown>
  if (record.type === 'ready' && typeof record.clientId === 'string') {
    const host = record.host
    const home = typeof host === 'object' && host !== null ? (host as Record<string, unknown>).home : undefined
    return { type: 'ready', clientId: record.clientId, host: { home: typeof home === 'string' ? home : '' } }
  }
  if (record.type === 'emit' && typeof record.event === 'string' && Array.isArray(record.args)) {
    return { type: 'emit', event: record.event, args: record.args }
  }
  if (
    record.type === 'waterfall'
    && typeof record.event === 'string'
    && typeof record.eventId === 'string'
    && typeof record.agentId === 'string'
    && typeof record.request === 'object'
    && record.request !== null
  ) {
    return {
      type: 'waterfall',
      event: record.event,
      eventId: record.eventId,
      agentId: record.agentId as SessionId,
      request: record.request as Record<string, unknown>,
    }
  }
  if (record.type === 'cancel' && typeof record.eventId === 'string') {
    return { type: 'cancel', eventId: record.eventId }
  }
  throw new Error('remote events: invalid frame')
}
