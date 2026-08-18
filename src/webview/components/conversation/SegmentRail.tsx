/**
 * SegmentRail (TODO 19): a thin rail on the right edge of the conversation
 * stream. Every user message ("对话开始点") gets one marker — normally a
 * small `-` tick; hovering a marker raises a floating one-line preview of that
 * message's text; clicking scrolls the stream to the message.
 *
 * Markers are measured live against the scrollport: positions recompute on
 * scroll (rAF-throttled), on flow resize (ResizeObserver) and whenever the
 * conversation nodes change, so expansion of tool cards and streaming content
 * never leaves stale markers. The preview tip is fixed-positioned (viewport
 * coordinates) so the scrollport's overflow clipping cannot cut it off.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { useAppStore } from '../../store'
import type { UserMessageNode } from '../../types'

/** One measured marker row. */
interface Marker {
  id: string
  /** Y offset inside the scrollport viewport (section-relative). */
  y: number
  /** One-line preview text (the user message's plain text). */
  text: string
}

/** Floating preview state; `null` hides the tip. */
interface Tip {
  id: string
  text: string
  /** Viewport coordinates of the tip's right-center anchor. */
  left: number
  top: number
}

/** Plain text of a user message node (text blocks only). */
function userMessageText(node: UserMessageNode): string {
  return node.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
}

/** Live marker positions for the current nodes, measured against the scrollport.
 * Every user message gets a dash; out-of-view dashes are clipped by the rail's
 * overflow (they are the timeline, so they must exist even while scrolled away). */
function measureMarkers(scrollEl: HTMLElement, nodes: readonly UserMessageNode[]): Marker[] {
  const rect = scrollEl.getBoundingClientRect()
  const markers: Marker[] = []
  for (const node of nodes) {
    const row = scrollEl.querySelector(`[data-node-id="${node.id}"]`)
    if (!(row instanceof HTMLElement)) continue
    const y = row.getBoundingClientRect().top - rect.top
    markers.push({ id: node.id, y, text: userMessageText(node) })
  }
  return markers
}

export function SegmentRail(props: { scrollRef: RefObject<HTMLElement | null>; onJumpTo: (id: string) => void }): JSX.Element {
  // Select the raw node array (stable identity) and filter in useMemo: a
  // selector returning a fresh filtered array would re-run on every render,
  // destabilize `measure`, and loop the effect below (React error #185).
  const nodes = useAppStore((s) => s.nodes)
  const userNodes = useMemo(
    () => nodes.filter((n): n is UserMessageNode => n.kind === 'user-message'),
    [nodes],
  )
  const [markers, setMarkers] = useState<Marker[]>([])
  const [tip, setTip] = useState<Tip | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)

  const measure = useCallback(() => {
    const el = props.scrollRef.current
    if (el === null) return
    setMarkers(measureMarkers(el, userNodes))
  }, [props.scrollRef, userNodes])

  // Re-measure when the node set changes (new messages, compaction).
  useEffect(() => {
    measure()
  }, [measure])

  // Live tracking: scroll + flow resize (tool-card expansion, streaming).
  useEffect(() => {
    const el = props.scrollRef.current
    if (el === null) return
    let raf = 0
    const reschedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        measure()
        setTip(null)
      })
    }
    el.addEventListener('scroll', reschedule, { passive: true })
    const flow = el.querySelector('.conv-flow')
    const observer = new ResizeObserver(reschedule)
    if (flow !== null) observer.observe(flow)
    else observer.observe(el)
    return () => {
      el.removeEventListener('scroll', reschedule)
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [measure])

  const openTip = (marker: Marker, el: HTMLElement): void => {
    const rect = el.getBoundingClientRect()
    setTip({ id: marker.id, text: marker.text, left: rect.left - 8, top: rect.top + rect.height / 2 })
  }

  return (
    <div className="segment-rail" ref={railRef}>
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          className={`segment-rail-mark${tip?.id === marker.id ? ' segment-rail-mark-active' : ''}`}
          style={{ top: marker.y }}
          title="定位到该消息"
          onClick={() => {
            props.onJumpTo(marker.id)
            setTip(null)
          }}
          onMouseEnter={(e) => openTip(marker, e.currentTarget)}
          onMouseLeave={() => setTip(null)}
        >
          <span className="segment-rail-dash" />
        </button>
      ))}
      {tip !== null && (
        <div className="segment-rail-tip" style={{ left: tip.left, top: tip.top }} data-tip-for={tip.id}>
          {tip.text}
        </div>
      )}
    </div>
  )
}
