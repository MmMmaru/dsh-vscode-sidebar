/**
 * TurnStatusLine (W3): turn-level activity label shown while a turn runs
 * ("Deep diving..."). Anchored to turn/start so a mid-turn reload keeps the
 * real elapsed time; the clock only appears once the turn has clearly been
 * running for a while (15s), mirroring the dsh web client.
 */

import { useEffect, useState, type JSX } from 'react'

/** Milliseconds after which the elapsed clock joins the label. */
const CLOCK_AFTER_MS = 15_000

/** Format a duration as a compact `1m 05s` / `12s` string. */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

export function TurnStatusLine(props: { startedAt: number }): JSX.Element {
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - props.startedAt))
  useEffect(() => {
    const tick = (): void => setElapsedMs(Math.max(0, Date.now() - props.startedAt))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [props.startedAt])
  return (
    <div className="turn-status-line" role="status" aria-live="polite">
      <span className="tool-spinner turn-status-spinner" aria-hidden />
      Deep diving...
      {elapsedMs >= CLOCK_AFTER_MS && (
        <span className="turn-status-clock">{formatDuration(elapsedMs)}</span>
      )}
    </div>
  )
}
