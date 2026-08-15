/**
 * MessageBubble (W3): right-aligned user message bubble with image gallery on
 * top, copy button and timestamp below (PRD 3.2).
 */

import { useState, type JSX } from 'react'
import type { UserMessageNode } from '../../types'

/** Format epoch ms as HH:MM. */
function formatTime(time: number): string {
  const d = new Date(time)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MessageBubble(props: { node: UserMessageNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const texts = props.node.blocks.filter((b) => b.type === 'text')
  const images = props.node.blocks.filter((b) => b.type === 'image')
  const plain = texts.map((b) => (b.type === 'text' ? b.text : '')).join('\n')

  const copy = (): void => {
    void navigator.clipboard.writeText(plain).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }

  return (
    <div className="msg-user">
      {images.length > 0 && (
        <div className="msg-user-images">
          {images.map((b, i) =>
            b.type === 'image' ? (
              <img key={i} src={`data:${b.attachment.mediaType};base64,${b.attachment.data}`} alt={b.attachment.name ?? '附件图片'} />
            ) : null,
          )}
        </div>
      )}
      {plain !== '' && <div className="msg-user-bubble">{plain}</div>}
      <div className="msg-user-meta">
        <button type="button" className="msg-copy" onClick={copy} title="复制">
          {copied ? '✓' : '⧉'}
        </button>
        <span className="msg-time">{formatTime(props.node.time)}</span>
      </div>
    </div>
  )
}
