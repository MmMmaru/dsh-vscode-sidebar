/**
 * ContextMeter (owned by W4): the 14px context-occupancy ring beside the send
 * button, fed by the store's contextPressure projection. The numerator is
 * `projectedTokens` — the provider sample carried forward over the surface's
 * movement since — falling back to the bare `pressureTokens` sample; both
 * token fields and the capacity are independent last-wins projection fields,
 * so this is a reference figure rather than an exact measurement. Renders
 * nothing until a token figure and the route capacity are both known.
 *
 * The ring is a button: clicking it raises a popup card above the ring with
 * the full session statistics (statsLineGroups) and the heuristic context
 * composition (contextBreakdown, one row per bucket — moved out of the title
 * tooltip in 0.0.9). The popup closes on outside click and Escape.
 * Contract: ARCHITECTURE.md section 5.3 — no props, reads the store slices.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
} from '../../../extension/protocol/projections'
import { useAppStore } from '../../store'
import { formatTokens, statsLineGroups } from './StatsLine'

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

/** Breakdown rows for the popup: one label/value pair per heuristic bucket. */
function breakdownRows(breakdown: ContextBreakdownProjection): Array<{ label: string; value: string }> {
  return [
    { label: '系统提示', value: `~${formatTokens(breakdown.systemTokens)}` },
    { label: '工具', value: `~${formatTokens(breakdown.toolsTokens)}` },
    { label: '对话', value: `~${formatTokens(breakdown.messageTokens)}` },
  ]
}

export function ContextMeter(): JSX.Element | null {
  const pressure = useAppStore((s) => s.contextPressure)
  const breakdown = useAppStore((s) => s.contextBreakdown)
  const stats = useAppStore((s) => s.sessionStats)
  const usage = useAppStore((s) => s.tokenUsage)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  // The popup closes on outside pointer-down and on Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pct = contextOccupancy(pressure)
  if (pct === null) return null
  const groups = statsLineGroups(stats, usage)

  return (
    <span className="context-meter" data-composer-tool="meter" ref={rootRef}>
      <button
        type="button"
        className="context-meter-btn"
        aria-expanded={open}
        aria-label={`上下文已用 ${pct}%，点击查看统计`}
        title={`上下文已用 ${pct}%`}
        onClick={() => setOpen((v) => !v)}
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
      </button>
      {open && (
        <div className="context-meter-pop" role="dialog" aria-label="上下文与统计">
          <div className="context-meter-pop-title">上下文已用 {pct}%</div>
          {breakdown !== null && (
            <div className="context-meter-pop-section">
              {breakdownRows(breakdown).map((row) => (
                <div key={row.label} className="context-meter-pop-row">
                  <span>{row.label}</span>
                  <span className="context-meter-pop-value">{row.value}</span>
                </div>
              ))}
            </div>
          )}
          {groups.length > 0 && (
            <div className="context-meter-pop-section">
              {groups.map((group) => (
                <div key={group} className="context-meter-pop-row">{group}</div>
              ))}
            </div>
          )}
          {breakdown === null && groups.length === 0 && (
            <div className="context-meter-pop-row context-meter-pop-empty">暂无统计数据</div>
          )}
        </div>
      )}
    </span>
  )
}
