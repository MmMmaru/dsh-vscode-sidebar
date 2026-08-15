/**
 * ContextMeter (owned by W4): the 14px context-occupancy ring beside the send
 * button. The percentage is estimated from store.stats.inputTokens against a
 * 128k context window (the wire carries no capacity projection yet — see the
 * W4 report's contract-defect notes).
 * Contract: ARCHITECTURE.md section 5.3 ({ usedPct }).
 */

import type { JSX } from 'react'

/** Ring geometry: 14px viewBox, 2px stroke (same as the dsh web ContextMeter). */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface ContextMeterProps {
  /** 0-100; clamped defensively. */
  usedPct: number
}

export function ContextMeter({ usedPct }: ContextMeterProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(usedPct)))
  return (
    <span
      className="context-meter"
      role="img"
      aria-label={`上下文已用 ${pct}%`}
      title={`上下文已用 ${pct}%（按 128k 窗口估算）`}
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
        <circle className="context-meter-track" cx="7" cy="7" r={RADIUS} />
        <circle
          className="context-meter-fill"
          cx="7"
          cy="7"
          r={RADIUS}
          strokeDasharray={`${(CIRCUMFERENCE * pct) / 100} ${CIRCUMFERENCE}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span className="context-meter-pct">{pct}%</span>
    </span>
  )
}
