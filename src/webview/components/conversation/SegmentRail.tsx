/**
 * SegmentRail: an overview rail on the right edge of the conversation stream.
 * Every user message gets one tick mark in a vertically centered cluster
 * (clicking a tick jumps straight to that message). Hovering the rail pops up
 * the overall conversation navigation menu listing ALL message entries
 * (20-code-point previews); clicking an item jumps likewise.
 *
 * Popup stability contract (mirrors the old one-tip design): the menu is
 * anchored ONCE to the cluster rect when the pointer enters the rail and is
 * NEVER re-anchored afterwards — neither by per-tick hovers nor by the menu's
 * own mouseenter (re-anchoring teleports the panel away from the cursor and
 * it closes before an item can be clicked). Closing goes through a grace
 * timer so the pointer can travel across the rail↔menu gap; the ::after
 * bridge in conversation.css widens that corridor.
 */

import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { parseUserMessage } from '../../../shared/attached-text'
import { useAppStore } from '../../store'
import type { UserMessageNode } from '../../types'

/** Per-tick slot height; the whole cluster caps at 120px. */
const TICK_SLOT_PX = 10
const CLUSTER_MAX_PX = 120

/** Default preview length: 20 code points. */
const PREVIEW_MAX_CHARS = 20

/** Grace period (ms) before the menu closes after the pointer leaves rail/menu. */
const CLOSE_GRACE_MS = 200

/**
 * One-line preview of a user message: the first 20 code points plus an
 * ellipsis when truncated. Array.from keeps surrogate pairs (emoji) intact.
 */
export function previewText(text: string, maxChars: number = PREVIEW_MAX_CHARS): string {
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`
}

/** Plain text of a user message node (clean prompt text only). */
function userMessageText(node: UserMessageNode): string {
  const raw = node.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
  const { cleanText } = parseUserMessage(raw)
  return cleanText !== '' ? cleanText : raw.trim()
}

interface MenuPos {
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
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const clusterRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = (): void => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  /**
   * Anchor to the cluster rect, recomputed on each rail-side entry (a closed
   * menu may hold a stale anchor after scrolling). Only ever called while the
   * pointer is over the rail itself — never from the menu — so the panel
   * cannot teleport away from the cursor.
   */
  const openMenu = (): void => {
    cancelClose()
    const el = clusterRef.current
    if (el !== null) {
      const rect = el.getBoundingClientRect()
      setPos({ left: rect.left - 8, top: rect.top + rect.height / 2 })
    }
    setOpen(true)
  }

  const scheduleClose = (): void => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, CLOSE_GRACE_MS)
  }

  const handleJump = (id: string): void => {
    props.onJumpTo(id)
    cancelClose()
    setOpen(false)
  }

  // While open: Escape closes; any scroll (capture phase, incl. the stream)
  // invalidates the fixed anchor, so close instead of drifting.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = (): void => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  // Clear a pending grace timer on unmount.
  useEffect(() => cancelClose, [])

  const clusterHeight = Math.min(userNodes.length * TICK_SLOT_PX, CLUSTER_MAX_PX)

  return (
    <div className={`segment-rail${open ? ' segment-rail-open' : ''}`}>
      {userNodes.length > 0 && (
        <div
          ref={clusterRef}
          className="segment-rail-cluster"
          style={{ height: clusterHeight }}
          onMouseEnter={openMenu}
          onMouseLeave={scheduleClose}
        >
          {userNodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className="segment-rail-mark"
              title="定位到该消息"
              onClick={() => handleJump(node.id)}
            >
              <span className="segment-rail-dash" />
            </button>
          ))}
        </div>
      )}
      {open && pos !== null && userNodes.length > 0 && (
        <div
          className="segment-rail-menu"
          style={{ left: pos.left, top: pos.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="segment-rail-menu-list">
            {userNodes.map((node) => {
              const text = userMessageText(node)
              return (
                <button
                  key={node.id}
                  type="button"
                  className="segment-rail-menu-item"
                  onClick={() => handleJump(node.id)}
                  title={text}
                >
                  <span className="segment-rail-menu-text">{previewText(text)}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
