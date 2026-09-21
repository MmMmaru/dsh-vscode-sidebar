/**
 * Stream frames of the Typert Remote session domain (dsh 0.1.5-rc.2).
 * Sources (built install, `<pkg>/lib/types/*.d.ts`):
 *   dsh-api-session-controller/lib/types/{types,history,control,assistant-stream}.d.ts
 *
 * These three streams replace the retired apiproxy channels:
 *   `session/follow`  <-  `session.history` + the `session/event` mux frame
 *   `session/control` <-  the `session/queue` / `session/jobs` / `session/projection`
 *                         mux frame families, Host-wide in one stream
 *   `session/page`    <-  `session.history` with `beforeSeq` (backward paging)
 *
 * Every generation of a stream opens with exactly one baseline frame
 * (`snapshot`, or `baseline` for control), so a reconnect is handled by
 * discarding prior state and re-applying the new opening frame.
 */

import type { SessionId } from './brand'
import type { HistoryEntry, SessionProjectionsBlock, SessionSummary } from './sessions'
import type { JobView } from './views'

/** Durable address of one ordinary session or one addressed direct subagent. */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
      readonly kind: 'subagent'
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
      readonly mode: 'one-shot' | 'continuable'
    }

/** Session log header carried only by a follow opening snapshot. */
export interface SessionWireHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/**
 * One durable session event as it crosses the wire: the payload the plugin
 * already understood under `SessionEvent`, wrapped in a log-position envelope.
 * `session/event` frames of the old protocol carried the payload alone.
 */
export interface SessionWireEvent {
  readonly type: string
  /** Log position; the ordering key for the whole stream. */
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: boolean
  readonly sourceEventSeqs?: readonly number[]
  /**
   * How this event entered the surface. This is the WIRE vocabulary
   * (`add`/`replace`/`remove`), which deliberately differs from the legacy
   * read-model `SessionEvent.surfaceOp` in `./session.ts` (`'append'` or
   * `{op:'replace'…}`), vendored from a different generator. The two are not
   * assignable to each other, so a value crossing between them must be mapped,
   * never cast. No production code reads this field: the conversation projector
   * rebuilds state from `type` + `data` alone.
   */
  readonly surfaceOp?: 'add' | 'replace' | 'remove'
}

/** One record of a follow snapshot or a `session/page` answer. */
export interface SessionEventEntry {
  readonly type: 'event'
  readonly event: SessionWireEvent
}

/** Active assistant attempt advertised in a reconnect opening snapshot. */
export interface SessionAssistantStreamBaseline {
  readonly revision: number
  readonly activeAttempt?: { readonly attemptId: string; readonly turn: number; readonly step: number }
}

/** Process-local assistant presentation frame (only when `assistantStream: true`). */
export type SessionAssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly revision: number; readonly startedAfterSeq: number; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: string; readonly revision: number; readonly index: number; readonly time: number; readonly chunk: unknown }
  | { readonly type: 'end'; readonly attemptId: string; readonly revision: number; readonly index: number; readonly outcome: 'committed' | 'abandoned' }

/** Opening frame of one `session/follow` generation. */
export interface SessionFollowSnapshotFrame {
  readonly type: 'snapshot'
  readonly header: SessionWireHeader
  /** Inclusive log cut this window ends at; feed to `session/page.throughSeq`. */
  readonly cursor: number
  readonly records: readonly HistoryEntry[] | readonly SessionEventEntry[]
  readonly hasMore: boolean
  readonly projections?: SessionProjectionsBlock
  readonly assistantStream?: SessionAssistantStreamBaseline
}

/** One live durable event after the snapshot. */
export interface SessionFollowEventFrame {
  readonly type: 'event'
  readonly event: SessionWireEvent
}

/** One assistant presentation frame after the snapshot. */
export interface SessionFollowAssistantFrame {
  readonly type: 'assistant-stream'
  readonly frame: SessionAssistantStreamFrame
}

/** Any frame of the `session/follow` stream. */
export type SessionFollowFrame = SessionFollowSnapshotFrame | SessionFollowEventFrame | SessionFollowAssistantFrame

/** One still-pending queue item. */
export interface SessionQueuedItem {
  readonly id: string
  /** `queued` waits its turn; `steering` interrupts; `context` rides along. */
  readonly placement: 'queued' | 'steering' | 'context'
  readonly rpcId?: string
  readonly message: { readonly id: string; readonly content: unknown }
}

/** One background job as the control stream reports it (same shape as {@link JobView}). */
export type SessionJob = JobView

/** Projection values at an exact cursor; an absent key means the unit is absent. */
export interface SessionProjectionBaseline {
  readonly asOfSeq: number
  readonly values: Record<string, unknown>
}

/** Opening frame of one `session/control` generation, Host-wide and complete. */
export interface SessionControlBaselineFrame {
  readonly type: 'baseline'
  readonly value: {
    readonly queues: Record<string, readonly SessionQueuedItem[]>
    readonly jobs: Record<string, readonly SessionJob[]>
    readonly projections: Record<string, SessionProjectionBaseline>
  }
}

/** Authoritative replacement of one session's transient queue. */
export interface SessionControlQueueFrame {
  readonly type: 'queue'
  readonly sessionId: SessionId
  readonly items: readonly SessionQueuedItem[]
}

/** Authoritative replacement of one session's background jobs. */
export interface SessionControlJobsFrame {
  readonly type: 'jobs'
  readonly sessionId: SessionId
  readonly jobs: readonly SessionJob[]
}

/** One projection value change for one session. */
export interface SessionControlProjectionFrame {
  readonly type: 'projection'
  readonly sessionId: SessionId
  readonly key: string
  readonly value: unknown
  readonly seq: number
}

/** Any frame of the Host-wide `session/control` stream. */
export type SessionControlFrame =
  | SessionControlBaselineFrame
  | SessionControlQueueFrame
  | SessionControlJobsFrame
  | SessionControlProjectionFrame

/** Answer value of `session/page`. */
export interface SessionPageValue {
  readonly records: readonly HistoryEntry[] | readonly SessionEventEntry[]
  readonly hasMore: boolean
}

/** Re-export so consumers of the follow frames can name a list row. */
export type { SessionSummary }
