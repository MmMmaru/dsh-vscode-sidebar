/**
 * MessageBubble (W3): right-aligned user message bubble with image gallery on
 * top, copy button and timestamp below (PRD 3.2). History images arrive as
 * durable attachment references; their bytes are fetched lazily through the
 * session.attachment RPC.
 */

import { useEffect, useState, type JSX } from 'react'
import type { ImageAttachmentRef } from '../../../extension/protocol/llm'
import { rpc } from '../../bridge'
import { useAppStore } from '../../store'
import type { UserMessageNode } from '../../types'

/** Format epoch ms as HH:MM. */
function formatTime(time: number): string {
  const d = new Date(time)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** One history image: lazy-loads its bytes via session.attachment. */
function AttachmentImage(props: { attachment: ImageAttachmentRef }): JSX.Element {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (activeSessionId === null) return
    let alive = true
    rpc<{ attachment: ImageAttachmentRef; data: string }>('session.attachment', {
      sessionId: activeSessionId,
      attachmentId: props.attachment.attachmentId,
    })
      .then((res) => {
        if (alive) setSrc(`data:${res.attachment.mediaType};base64,${res.data}`)
      })
      .catch(() => {
        if (alive) setSrc(null)
      })
    return () => {
      alive = false
    }
  }, [activeSessionId, props.attachment.attachmentId])

  if (src === null) return <span className="msg-user-image-placeholder">{props.attachment.name ?? '图片'}</span>
  return <img src={src} alt={props.attachment.name ?? '附件图片'} />
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
            b.type === 'image' ? <AttachmentImage key={i} attachment={b.attachment} /> : null,
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
