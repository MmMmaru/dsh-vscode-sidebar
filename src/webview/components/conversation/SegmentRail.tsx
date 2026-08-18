/**
 * SegmentRail (TODO 19): an overview rail on the right edge of the
 * conversation stream. Every user message ("对话开始点") gets one tick —
 * ticks are NOT a scroll-position map; they form a vertically centered
 * cluster expressing "which round" each message is. Hovering a tick raises a
 * one-line preview (fixed-positioned so the rail's overflow clip cannot cut
 * it); clicking scrolls the stream to the message. The rail stays dimmed
 * (opacity 0.25) until hovered.
 */

import { useMemo, useState, type JSX, type RefObject } from 'react'
import { useAppStore } from '../../store'
import type { UserMessageNode } from '../../types'

/** Per-tick slot height; the whole cluster caps at 120px. */
const TICK_SLOT_PX = 10
const CLUSTER_MAX_PX = 120

/**
 * One-line preview of a user message: the first 10 code points plus an
 * ellipsis when truncated. Array.from keeps surrogate pairs (emoji) intact.
 */
export function previewText(text: string): string {
  const chars = Array.from(text)
  return chars.length <= 10 ? text : `${chars.slice(0, 10).join('')}…`
}

/** Plain text of a user message node (text blocks only). */
function userMessageText(node: UserMessageNode): string {
  return node.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
}

/** Floating preview state; `null` hides the tip. */
interface Tip {
  id: string
  text: string
  /** Viewport coordinates of the tip's right-center anchor. */
  left: number
  top: number
}

export function SegmentRail(props: { scrollRef: RefObject<HTMLElement | null>; onJumpTo: (id: string) => void }): JSX.Element {
  // Select the raw node array (stable identity) and filter in useMemo: a
  // selector returning a fresh filtered array would re-run on every render
  // (React error #185).
  const nodes = useAppStore((s) => s.nodes)
  const userNodes = useMemo(
    () => nodes.filter((n): n is UserMessageNode => n.kind === 'user-message'),
    [nodes],
  )
  const [tip, setTip] = useState<Tip | null>(null)

  const clusterHeight = Math.min(userNodes.length * TICK_SLOT_PX, CLUSTER_MAX_PX)

  const openTip = (node: UserMessageNode, el: HTMLElement): void => {
    const rect = el.getBoundingClientRect()
    setTip({ id: node.id, text: previewText(userMessageText(node)), left: rect.left - 8, top: rect.top + rect.height / 2 })
  }

  return (
    <div className="segment-rail">
      {userNodes.length > 0 && (
        <div className="segment-rail-cluster" style={{ height: clusterHeight }}>
          {userNodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`segment-rail-mark${tip?.id === node.id ? ' segment-rail-mark-active' : ''}`}
              title="定位到该消息"
              onClick={() => {
                props.onJumpTo(node.id)
                setTip(null)
              }}
              onMouseEnter={(e) => openTip(node, e.currentTarget)}
              onMouseLeave={() => setTip(null)}
            >
              <span className="segment-rail-dash" />
            </button>
          ))}
        </div>
      )}
      {tip !== null && (
        <div className="segment-rail-tip" style={{ left: tip.left, top: tip.top }} data-tip-for={tip.id}>
          {tip.text}
        </div>
      )}
    </div>
  )
}
