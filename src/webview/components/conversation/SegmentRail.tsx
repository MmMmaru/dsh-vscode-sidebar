/**
 * SegmentRail: an overview block on the right edge of the conversation stream.
 * Converts into a single solid indicator block; hovering over it raises a
 * full-conversation navigation list showing all user messages (up to 20 chars
 * per preview), and clicking any item jumps directly to that message.
 */

import { useMemo, useState, type JSX, type RefObject } from 'react'
import { parseUserMessage } from '../../../shared/attached-text'
import { useAppStore } from '../../store'
import type { UserMessageNode } from '../../types'

/** Default preview length: 20 code points. */
const PREVIEW_MAX_CHARS = 20

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
  const nodes = useAppStore((s) => s.nodes)
  const userNodes = useMemo(
    () => nodes.filter((n): n is UserMessageNode => n.kind === 'user-message'),
    [nodes],
  )
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)

  const blockHeight = Math.max(32, Math.min(userNodes.length * 10 + 20, 100))

  const handleMouseEnter = (el: HTMLElement): void => {
    const rect = el.getBoundingClientRect()
    setPos({
      left: rect.left - 8,
      top: rect.top + rect.height / 2,
    })
    setOpen(true)
  }

  return (
    <div className="segment-rail">
      {userNodes.length > 0 && (
        <div
          className="segment-rail-block"
          style={{ height: blockHeight }}
          onMouseEnter={(e) => handleMouseEnter(e.currentTarget)}
          onMouseLeave={() => setOpen(false)}
        >
          <div className="segment-rail-bar" />
        </div>
      )}
      {open && pos !== null && userNodes.length > 0 && (
        <div
          className="segment-rail-menu"
          style={{ left: pos.left, top: pos.top }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <div className="segment-rail-menu-header">
            <span>对话导航 ({userNodes.length})</span>
          </div>
          <div className="segment-rail-menu-list">
            {userNodes.map((node, index) => {
              const text = userMessageText(node)
              const preview = previewText(text, 20)
              return (
                <button
                  key={node.id}
                  type="button"
                  className="segment-rail-menu-item"
                  onClick={() => {
                    props.onJumpTo(node.id)
                    setOpen(false)
                  }}
                  title={text}
                >
                  <span className="segment-rail-menu-idx">{index + 1}.</span>
                  <span className="segment-rail-menu-text">{preview}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
