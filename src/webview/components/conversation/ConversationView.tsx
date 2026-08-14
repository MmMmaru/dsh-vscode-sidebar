/**
 * ConversationView placeholder (owned by W3). Contract props per
 * ARCHITECTURE.md section 5.3: `{ sessionId }` — the container is keyed by
 * session; node data comes from the conversation slice. This placeholder
 * renders one line per projected node so the projector output is visible.
 */

import type { JSX } from 'react'
import type { SessionId } from '../../../extension/protocol/brand'
import { useAppStore } from '../../store'
import type { ConversationNode } from '../../types'

export interface ConversationViewProps {
  /** Active session; the view re-mounts when it changes. */
  sessionId: SessionId
}

/** One-line text preview of a node, for the placeholder rendering. */
function preview(node: ConversationNode): string {
  switch (node.kind) {
    case 'user-message':
    case 'assistant-text':
    case 'reasoning':
      return 'text' in node ? node.text : node.blocks.map((b) => (b.type === 'text' ? b.text : '[image]')).join(' ')
    case 'tool-call':
      return `${node.name} (${node.status}) ${node.resultText ?? ''}`
    case 'context-injection':
      return `[${node.plugin}] ${node.text}`
    case 'compaction':
      return node.summary ?? '(compacted)'
    case 'retry':
      return `attempt ${node.attempt} ${node.message ?? ''}`
    case 'error':
      return node.message
  }
}

export function ConversationView({ sessionId }: ConversationViewProps): JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const turnStatus = useAppStore((s) => s.turnStatus)

  return (
    <section className="region region-conversation" data-region="ConversationView" data-session={sessionId}>
      {nodes.length === 0 ? (
        <div className="empty-hero">EmptyHero 占位 — 开始新对话</div>
      ) : (
        <ul className="node-list">
          {nodes.map((n) => (
            <li key={n.id} className={`node node-${n.kind}`}>
              <span className="node-kind">{n.kind}</span>
              <span className="node-preview">{preview(n)}</span>
            </li>
          ))}
        </ul>
      )}
      {turnStatus === 'running' && <div className="turn-status">Deep diving…</div>}
    </section>
  )
}
