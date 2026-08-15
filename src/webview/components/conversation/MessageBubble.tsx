/**
 * MessageBubble (W3): right-aligned user message bubble with image gallery on
 * top, copy button and timestamp below (PRD 3.2); plus the assistant message
 * chrome: the markdown body followed by a ghost icon action row (copy / fork,
 * mirroring the dsh web client's MessageIconActions). History images arrive
 * as durable attachment references; their bytes are fetched lazily through
 * the session.attachment RPC.
 */

import { useEffect, useState, type JSX } from 'react'
import type { ImageAttachmentRef } from '../../../extension/protocol/llm'
import { rpc } from '../../bridge'
import { useAppStore } from '../../store'
import type { AssistantTextNode, UserMessageNode } from '../../types'
import { MarkdownBlock } from './MarkdownBlock'

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

/** 16px stroke icon: two overlapping squares (copy). */
function CopyIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 4V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H4" />
    </svg>
  )
}

/** 16px stroke icon: a branch forking off a main line (fork). */
function ForkIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="5.5" r="1.75" />
      <path d="M4 5.25v5.5" />
      <path d="M12 7.25v.75a3.5 3.5 0 0 1-3.5 3.5H6.5" />
    </svg>
  )
}

/**
 * Assistant message chrome: the markdown body plus a trailing ghost action
 * row — copy the raw markdown, and fork the session at this node's seq
 * (hidden while the node is still streaming).
 */
export function AssistantBubble(props: { node: AssistantTextNode }): JSX.Element {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const forkSession = useAppStore((s) => s.forkSession)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(props.node.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const fork = (): void => {
    if (activeSessionId === null) return
    void forkSession(activeSessionId, props.node.seq)
  }

  return (
    <div className="msg-assistant">
      <MarkdownBlock text={props.node.text} streaming={props.node.streaming} />
      <div className="msg-actions">
        <button type="button" className="msg-action" onClick={copy} title="复制">
          {copied ? <span className="msg-action-copied">已复制</span> : <CopyIcon />}
        </button>
        {!props.node.streaming && (
          <button type="button" className="msg-action" onClick={fork} title="分叉新对话">
            <ForkIcon />
          </button>
        )}
      </div>
    </div>
  )
}
