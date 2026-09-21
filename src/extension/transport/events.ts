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
  /**
   * Waterfall ids delivered in THIS generation and not yet settled.
   *
   * The host only accepts an answer naming a request it still considers open.
   * Without this set the client would happily post an answer for an id it never
   * received, for one it already answered, or for one the host retracted — and
   * the contract is explicit that a cancelled event "must not be answered". Those
   * posts are not harmless: the host rejects them with `gateway/internal`, which
   * surfaces to the user as an opaque failure on an action that appeared valid.
   * Refusing locally turns that into a clear error at the call site.
   */
  private readonly pending = new Set<string>()

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
    // A new generation mints new eventIds, so nothing from the old one is answerable.
    this.pending.clear()
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
   *
   * Refuses an id this generation never delivered, already settled, or saw
   * retracted — see {@link pending}. A `next` outcome is NOT terminal (it
   * delegates to the next listener), so it leaves the request open.
   * @param eventId - the request's correlation id.
   * @param outcome - settlement decision.
   * @returns the host's acknowledgement value.
   * @throws when no generation is live, the id is not answerable, or the host
   *   rejects the answer.
   */
  async respond(eventId: string, outcome: RemoteEventOutcome): Promise<unknown> {
    const clientId = this.generation
    if (clientId === null) throw new Error('remote events: no live generation to answer on')
    if (!this.pending.has(eventId)) {
      throw new Error(`remote events: unknown, already-answered or retracted eventId ${eventId}`)
    }
    const result = await callRemoteUnary<unknown>(this.target(), REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId,
      eventId,
      outcome,
    })
    // Only on success: a failed post means the answer did not land, so the
    // request stays answerable rather than becoming silently unanswerable.
    if (outcome.kind !== 'next') this.pending.delete(eventId)
    return result
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
    this.pending.clear()
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
        this.pending.add(frame.eventId)
        this.listener.onWaterfall?.({
          event: frame.event,
          eventId: frame.eventId,
          agentId: frame.agentId,
          request: frame.request,
        })
        return
      case 'cancel':
        // Retracted: the contract forbids answering it, so forget it before the
        // listener is told (which is what drops the overlay in the webview).
        this.pending.delete(frame.eventId)
        this.listener.onCancel?.(frame.eventId)
        return
    }
  }
}
