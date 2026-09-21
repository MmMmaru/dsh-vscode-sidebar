/**
 * Client for forwarded Remote Events — the replacement for the retired
 * apiproxy `/api/events.mux` + `/api/events.host` sockets and for the
 * `POST /api/respond` reply path.
 *
 * Contract (dsh 0.1.5-rc.2):
 *   - Subscribe by opening the `$events` logical stream on the mux carrier with
 *     an empty args object.
 *   - The host's first frame of each generation is `ready`, carrying this
 *     generation's `clientId` and the stable host facts.
 *   - Broadcast events arrive as `emit`; events needing an answer arrive as
 *     `waterfall` (approvals, ask-user questions); `cancel` retracts a pending
 *     waterfall.
 *   - Answer a waterfall with a UNARY call to `$events/result`, echoing the
 *     generation's `clientId` and the request's `eventId`. Answering with
 *     `{kind:'next'}` delegates to the next listener instead of claiming it.
 *
 * Pure Node; the mux carrier and unary caller are injected so this module is
 * unit-testable without sockets.
 */

import type { RemoteMuxClient, RemoteStream } from './mux'
import type { UnaryTarget } from './unary'
import { callRemoteUnary } from './unary'
import type { RemoteEventFrame, RemoteEventOutcome } from '../protocol/remote-events'
import {
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  parseRemoteEventFrame,
} from '../protocol/remote-events'
import type { SessionId } from '../protocol/brand'

/** A waterfall request awaiting this client's answer. */
export interface PendingWaterfall {
  event: string
  eventId: string
  agentId: SessionId
  request: Record<string, unknown>
}

/** Sinks the owner supplies to receive host events. */
export interface RemoteEventListener {
  /** One broadcast event with its positional arguments. */
  onEmit?: (event: string, args: unknown[]) => void
  /** One answerable request; the listener either settles or ignores it. */
  onWaterfall?: (request: PendingWaterfall) => void
  /** The host retracted a pending waterfall request. */
  onCancel?: (eventId: string) => void
  /** The generation opened (also fires after every carrier-driven reopen). */
  onReady?: (clientId: string, host: { home: string }) => void
  /** The generation ended; the owner should expect a reopen. */
  onClosed?: (error: unknown) => void
}

/**
 * Owns the `$events` subscription for one connection generation and routes
 * frames to a listener.
 *
 * A carrier loss invalidates the generation: the host mints a new `clientId`,
 * so any answer attempted against the old one is rejected. The client therefore
 * drops `clientId` on close and reopens on demand.
 */
export class RemoteEventsClient {
  private stream: RemoteStream<unknown> | null = null
  private generation: string | null = null
  private closed = false

  constructor(
    private readonly mux: RemoteMuxClient,
    private readonly target: () => UnaryTarget,
    private readonly listener: RemoteEventListener,
  ) {}

  /** This generation's client id, or null when no generation is live. */
  get clientId(): string | null {
    return this.generation
  }

  /** Subscribe, replacing any previous generation. */
  async subscribe(): Promise<void> {
    this.stream?.cancel()
    this.stream = null
    this.generation = null
    const stream = this.mux.openStream(REMOTE_EVENT_STREAM_ENDPOINT, {})
    this.stream = stream
    try {
      for await (const value of stream) {
        this.handleValue(value)
      }
      if (!this.closed) {
        this.generation = null
        this.listener.onClosed?.(undefined)
      }
    } catch (error) {
      this.generation = null
      if (!this.closed) this.listener.onClosed?.(error)
    }
  }

  /**
   * Answer one pending waterfall request.
   * @param eventId - the request's correlation id.
   * @param outcome - settlement decision.
   * @returns the host's acknowledgement value.
   * @throws when no generation is live, or the host rejects the answer.
   */
  async respond(eventId: string, outcome: RemoteEventOutcome): Promise<unknown> {
    const clientId = this.generation
    if (clientId === null) throw new Error('remote events: no live generation to answer on')
    return callRemoteUnary<unknown>(this.target(), REMOTE_EVENT_RESULT_ENDPOINT, { clientId, eventId, outcome })
  }

  /**
   * Answer an approval waterfall with a closed outcome.
   * @param eventId - the `approval/request` correlation id.
   * @param outcome - the decision.
   */
  async respondApproval(eventId: string, outcome: string): Promise<void> {
    await this.respond(eventId, { kind: 'result', value: outcome })
  }

  /**
   * Answer an ask-user-questions waterfall.
   * @param eventId - the `user-questions/request` correlation id.
   * @param answers - one answer per asked question.
   */
  async respondQuestions(eventId: string, answers: readonly unknown[]): Promise<void> {
    await this.respond(eventId, { kind: 'result', value: { answers } })
  }

  /** Release the subscription. */
  close(): void {
    this.closed = true
    this.stream?.cancel()
    this.stream = null
    this.generation = null
  }

  /** Validate and route one stream value. */
  private handleValue(value: unknown): void {
    let frame: RemoteEventFrame
    try {
      frame = parseRemoteEventFrame(value)
    } catch {
      return
    }
    switch (frame.type) {
      case 'ready':
        this.generation = frame.clientId
        this.listener.onReady?.(frame.clientId, frame.host)
        return
      case 'emit':
        this.listener.onEmit?.(frame.event, frame.args)
        return
      case 'waterfall':
        this.listener.onWaterfall?.({
          event: frame.event,
          eventId: frame.eventId,
          agentId: frame.agentId,
          request: frame.request,
        })
        return
      case 'cancel':
        this.listener.onCancel?.(frame.eventId)
        return
    }
  }
}
