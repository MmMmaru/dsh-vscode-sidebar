/**
 * ReasoningRow (W3): the collapsible "Think" row, aligned with the dsh web
 * ReasoningRow. Collapsed it shows a single line (bulb icon + "Think" +
 * summary); while streaming the summary tracks the latest line and pins its
 * scroll to the write edge (`data-follow-end` switches ellipsis to clip so
 * the newest words stay visible); settled it shows the first line. Click
 * toggles the full indented text. The in-flight signal is the shared row
 * glare sweep (conversation.css), not a spinner or pulse.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { ReasoningNode } from '../../types'
import { IconChevron, IconThink } from './icons'

/** First non-empty line of a settled text. */
function firstLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines[0] ?? ''
}

/** Latest non-empty line of a streaming text. */
function latestLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines[lines.length - 1] ?? ''
}

export function ReasoningRow(props: { node: ReasoningNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { node } = props
  const running = node.streaming
  const summaryRef = useRef<HTMLSpanElement>(null)
  // Collapsed summary: the newest line while streaming, the first line once
  // settled. An empty stream still needs a spoken summary — the sweep is
  // aria-hidden.
  const summary = running ? latestLine(node.text) || '思考中…' : firstLine(node.text)

  // Follow the write edge while streaming: pin scrollLeft to the end on each
  // summary change, coalesced into one animation frame so a fast delta burst
  // costs one layout read/write per frame. Settled rows reset to the start.
  useEffect(() => {
    const el = summaryRef.current
    if (el === null) return
    if (!running) {
      el.scrollLeft = 0
      return
    }
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth - el.clientWidth
    })
    return () => cancelAnimationFrame(raf)
  }, [running, summary])

  return (
    <div className={`reasoning-row${running ? ' reasoning-running' : ''}`}>
      <button
        type="button"
        className={`disclosure-head reasoning-header${open ? ' disclosure-open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="row-leading" aria-hidden>
          <span className="row-leading-idle">
            <IconThink size={14} />
          </span>
          <IconChevron size={14} className="row-leading-chevron" />
        </span>
        <span className="reasoning-label">Think</span>
        <span ref={summaryRef} className="reasoning-summary" data-follow-end={running || undefined}>
          {summary}
        </span>
      </button>
      {open && <div className="reasoning-body">{node.text}</div>}
    </div>
  )
}
