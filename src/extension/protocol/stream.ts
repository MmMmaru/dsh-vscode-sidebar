/**
 * Wire frames of the Typert Remote stream carrier (WS `/api/remote.mux`).
 * Vendored from deepseek-harness at dsh 0.1.5-rc.2:
 * Source: packages/api/gateway/src/types/stream-protocol.ts
 *   (built: dsh-api-gateway/lib/types/stream-protocol.js:155-196)
 *
 * One WebSocket multiplexes any number of logical streams. Frames are text
 * only; the host closes 1003 on binary and 1008 on an invalid message.
 *
 * Client -> host:
 *   { type:'open',   streamId, endpoint, payload }   endpoint is '<ns>/<method>'
 *   { type:'cancel', streamId }
 * Host -> client:
 *   { type:'item',  streamId, value }
 *   { type:'end',   streamId }
 *   { type:'error', streamId, error: { code, message, details } }
 */

import type { RpcError } from './rpc'

/** Path of the sole WebSocket carrier owning every logical Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** Logical stream identity minted by the client; unique per socket. */
export type StreamId = string & { readonly __brand: 'remote-stream-id' }

/**
 * Brand a string as a StreamId.
 * @param id - raw id (implementations mint UUIDs).
 * @returns the same string, branded.
 */
export function StreamId(id: string): StreamId {
  return id as StreamId
}

/** Wire payload of a stream open: Remote args ride under `args`, always an object. */
export interface RemoteStreamPayload {
  args: Record<string, unknown>
}

/** Open one logical stream on the mux socket. */
export interface StreamOpenMessage {
  type: 'open'
  streamId: StreamId
  /** Remote endpoint, `<namespace>/<method>`. */
  endpoint: string
  payload: RemoteStreamPayload
}

/** Cancel one open logical stream; the host aborts its AbortSignal. */
export interface StreamCancelMessage {
  type: 'cancel'
  streamId: StreamId
}

/** Any client-to-host mux frame. */
export type RemoteStreamClientMessage = StreamOpenMessage | StreamCancelMessage

/** One produced value of a logical stream. `value` is omitted for a valueless item. */
export interface StreamItemMessage {
  type: 'item'
  streamId: StreamId
  value?: unknown
}

/** Normal completion of one logical stream. */
export interface StreamEndMessage {
  type: 'end'
  streamId: StreamId
}

/** Terminal failure of one logical stream; the stream is dead afterwards. */
export interface StreamErrorMessage {
  type: 'error'
  streamId: StreamId
  error: RpcError
}

/** Any host-to-client mux frame. */
export type RemoteStreamServerMessage = StreamItemMessage | StreamEndMessage | StreamErrorMessage

/** True for a non-empty string usable as a stream id on the wire. */
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** True when the value is a plain object carrying exactly the expected own keys. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one host-to-client text frame.
 * Mirrors `parseRemoteStreamServerMessage` (built line 175) so a malformed frame
 * is rejected rather than half-applied.
 * @param text - complete WebSocket text message.
 * @returns the validated frame.
 * @throws when the frame does not match one of the three legal shapes.
 */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('remote stream: frame is not JSON')
  }
  if (!isRecord(value) || !validId(value.streamId)) {
    throw new Error('remote stream: invalid stream id')
  }
  const streamId = StreamId(value.streamId)
  if (value.type === 'item') {
    if (!exactKeys(value, ['type', 'streamId']) && !exactKeys(value, ['type', 'streamId', 'value'])) {
      throw new Error('remote stream: invalid item frame')
    }
    return Object.hasOwn(value, 'value')
      ? { type: 'item', streamId, value: value.value }
      : { type: 'item', streamId }
  }
  if (value.type === 'end' && exactKeys(value, ['type', 'streamId'])) {
    return { type: 'end', streamId }
  }
  if (value.type === 'error' && exactKeys(value, ['type', 'streamId', 'error']) && isRecord(value.error)) {
    const error = value.error
    if (
      exactKeys(error, ['code', 'message', 'details'])
      && typeof error.code === 'string'
      && typeof error.message === 'string'
      && isRecord(error.details)
    ) {
      return {
        type: 'error',
        streamId,
        error: { code: error.code, message: error.message, details: error.details } as RpcError,
      }
    }
  }
  throw new Error('remote stream: invalid server message')
}

/**
 * Serialize one client-to-host mux frame.
 * @param message - the frame to send.
 * @returns the exact JSON text the host accepts.
 */
export function encodeRemoteStreamClientMessage(message: RemoteStreamClientMessage): string {
  return JSON.stringify(message)
}
