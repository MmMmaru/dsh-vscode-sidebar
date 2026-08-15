/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/session/session-stats/src/types.ts (SessionStatsProjection)
 *   packages/llm/token-meter/src/projection.ts (TokenUsageProjection,
 *     ContextPressureProjection, ContextBreakdownProjection)
 * Type-only full copies of the projection values the session/projection mux
 * frames and history-tail baseline carry.
 */

/** Whole-log turn/step counts and wall times (projection key `sessionStats`). */
export interface SessionStatsProjection {
  /** Distinct turns carrying at least one closed step; rejected/empty turns uncounted. */
  turns: number
  /** Closed steps (step/end) — completed, failed, and cancelled alike. */
  steps: number
  /** Summed model wall time (step/start → assistant/message). */
  llmMs: number
  /** Summed tool wall time over tool/call → tool/result pairs matched by callId. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`. */
  ttftMs: number
  /** Steps carrying a recorded first token. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed provider output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * Provider-reported usage accumulated across the complete durable log
 * (projection key `tokenUsage`). The four buckets are disjoint; reasoning
 * tokens are already included in outputTokens.
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Approximate context occupancy for a status display (projection key
 * `contextPressure`). Fields are independent last-wins records, not one atomic
 * observation. Absent fields mean "not known yet".
 */
export interface ContextPressureProjection {
  /** Provider-reported prompt size of the most recent request (output excluded). */
  pressureTokens?: number
  /** Estimated prompt size of the NEXT request (pressure + surface movement). */
  projectedTokens?: number
  /** Newest recorded route capacity; absent when no adapter advertised one. */
  contextWindow?: number
}

/**
 * Heuristic composition of the next request's context (projection key
 * `contextBreakdown`). Fixed-density estimates; never sums to projectedTokens.
 */
export interface ContextBreakdownProjection {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}
