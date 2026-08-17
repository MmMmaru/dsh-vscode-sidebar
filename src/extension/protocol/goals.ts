/**
 * Vendored Goal projection vocabulary from deepseek-harness.
 * Sources:
 *   packages/goal/goal/src/types.ts (GoalPhase, GoalBlockReason, GoalSnapshot,
 *     GoalProjection)
 *   packages/host/apiproxy/src/api/goals.ts (GoalRef)
 * Goal reads are whole-value projection units (`goal` key, `GoalProjection |
 * null`); mutations acknowledge a compare-and-set ref and never feed client
 * state — the committed goal/change event reaches clients on the mux stream.
 */

import type { GoalId } from './brand'

/** Durable lifecycle phase of a goal. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Machine code and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Compare-and-set identity of one exact goal revision. */
export interface GoalRef {
  readonly id: GoalId
  readonly revision: number
}

/** Durable goal snapshot carried by every non-clear projection value. */
export interface GoalSnapshot extends GoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

/**
 * Whole value of the `goal` projection: the current durable snapshot with its
 * replay counters. `null` is the pre-create/cleared state.
 */
export interface GoalProjection {
  readonly goal: GoalSnapshot
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}
