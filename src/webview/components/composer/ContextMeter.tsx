/**
 * ContextMeter (owned by W4): the 14px context-occupancy ring beside the send
 * button, fed by the store's contextPressure projection. The numerator is
 * `projectedTokens` — the provider sample carried forward over the surface's
 * movement since — falling back to the bare `pressureTokens` sample; both
 * token fields and the capacity are independent last-wins projection fields,
 * so this is a reference figure rather than an exact measurement. Renders
 * nothing until a token figure and the route capacity are both known. When
 * the contextBreakdown projection is present, its heuristic composition goes
 * to the title tooltip.
 * Contract: ARCHITECTURE.md section 5.3 — no props, reads the store slices.
 */

import type { JSX } from 'react'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
} from '../../../extension/protocol/projections'
import { useAppStore } from '../../store'
import { formatTokens } from './StatsLine'

/** Ring geometry: 14px viewBox, 2px stroke (same as the dsh web ContextMeter). */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Approximate context occupancy percent with the TUI's integer rounding and
 * upper clamp.
 * @param pressure - the session's context-pressure projection value.
 * @returns 0-100 occupancy, or null until a token figure and capacity are known.
 */
export function contextOccupancy(pressure: ContextPressureProjection | null): number | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100))
}

/** Title tooltip: the occupancy line plus the heuristic breakdown when served. */
function meterTitle(pct: number, breakdown: ContextBreakdownProjection | null): string {
  const head = `上下文已用 ${pct}%`
  if (breakdown === null) return head
  return `${head}\n系统提示 ~${formatTokens(breakdown.systemTokens)} · 工具 ~${formatTokens(breakdown.toolsTokens)} · 对话 ~${formatTokens(breakdown.messageTokens)}`
}

export function ContextMeter(): JSX.Element | null {
  const pressure = useAppStore((s) => s.contextPressure)
  const breakdown = useAppStore((s) => s.contextBreakdown)
  const pct = contextOccupancy(pressure)
  if (pct === null) return null
  return (
    <span
      className="context-meter"
      data-composer-tool="meter"
      role="img"
      aria-label={`上下文已用 ${pct}%`}
      title={meterTitle(pct, breakdown)}
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
