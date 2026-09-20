/**
 * ConversationView (W3): the message-stream container. The section element
 * itself is the scrollport (base.css gives .region-conversation overflow-y).
 * Behavior: bottom-follow while pinned (any reader scroll away unpins, back
 * near the floor re-pins), a floating "回到底部" button while unpinned, and a
 * top "Load older" button that prepends the next history page while keeping
 * the reader's scroll position. Node kinds dispatch to their row components.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SessionId } from '../../../extension/protocol/brand'
import { useAppStore } from '../../store'
import type { CommandNode, CompactionNode, ContextInjectionNode, ConversationNode, ErrorNode, ReasoningNode, RetryNode, ToolCallNode } from '../../types'
import { AssistantBubble, MessageBubble } from './MessageBubble'
import { IconBrowse, IconChevron, IconChecklist, IconThink } from './icons'
import { ReasoningRow } from './ReasoningRow'
import { groupRounds, roundLabel, roundSummary } from './rounds'
import { SegmentRail } from './SegmentRail'
import { ToolCallRow } from './ToolCallRow'
import { formatDuration, TurnStatusLine } from './TurnStatusLine'
import './conversation.css'

export interface ConversationViewProps {
  /** Active session; the view re-mounts when it changes. */
  sessionId: SessionId
}

/** Reader is pinned to the floor while within this many px of it. */
const FOLLOW_THRESHOLD = 24

/** Collapsed context-injection row (AGENTS.md and friends); click expands. */
function ContextInjectionRow(props: { node: ContextInjectionNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const label = props.node.form !== undefined ? `${props.node.plugin} · ${props.node.form}` : props.node.plugin
  return (
    <div className="ctx-row">
      <button
        type="button"
        className={`disclosure-head ctx-row-head${open ? ' disclosure-open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="row-leading" aria-hidden>
          <span className="row-leading-idle">
            <IconBrowse size={14} />
          </span>
          <IconChevron size={14} className="row-leading-chevron" />
        </span>
        <span className="ctx-row-label">Context injection</span>
        <span className="tool-row-summary">{label}</span>
      </button>
      {open && <pre className="ctx-row-body">{props.node.text}</pre>}
    </div>
  )
}

/**
 * One collapsible round: a whole run of Think + tool calls folded into a
 * single disclosure row, so a settled conversation shows only the model's
 * output prose (TODO 0.0.12 R2). Expanding reveals the individual rows, which
 * keep their own per-row detail toggles. A live round (still streaming or
 * awaiting a tool result) starts expanded and auto-collapses when it settles.
 * The leading glyph follows the round's composition: pure thinking keeps the
 * bulb, any tool call shows the checklist.
 */
function RoundGroup(props: { id: string; nodes: Array<ReasoningNode | ToolCallNode>; live: boolean }): JSX.Element {
  const [open, setOpen] = useState(props.live)
  const userToggledRef = useRef(false)
  const prevLiveRef = useRef(props.live)

  useEffect(() => {
    // If the user manually toggled, preserve their choice and do not auto-collapse.
    if (userToggledRef.current) return
    if (prevLiveRef.current && !props.live) {
      setOpen(false)
    } else if (!prevLiveRef.current && props.live) {
      setOpen(true)
    }
    prevLiveRef.current = props.live
  }, [props.live])

  const toggle = (): void => {
    userToggledRef.current = true
    setOpen((v) => !v)
  }

  const hasTools = props.nodes.some((n) => n.kind === 'tool-call')
  return (
    <div className={`round-group${props.live ? ' round-group-live' : ''}`}>
      <button
        type="button"
        className={`disclosure-head round-head${open ? ' disclosure-open' : ''}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="row-leading" aria-hidden>
          <span className="row-leading-idle">{hasTools ? <IconChecklist size={14} /> : <IconThink size={14} />}</span>
          <IconChevron size={14} className="row-leading-chevron" />
        </span>
        <span className="reasoning-label">{roundLabel(props.nodes)}</span>
        <span className="round-summary">{roundSummary(props.nodes)}</span>
      </button>
      {open && (
        <div className="round-body">
          {props.nodes.map((n) => (
            <div key={n.id} className={`conv-node conv-node-${n.kind}`} data-node-id={n.id}>
              <NodeView node={n} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Command invocation card (e.g. /goal, /compact, /plan). */
function CommandRow(props: { node: CommandNode }): JSX.Element {
  const { node } = props
  const [open, setOpen] = useState(false)
  const isRunning = node.status === 'running'
  const isError = node.status === 'error'
  const text = node.text
  const hasBody = text !== undefined && text.includes('\n')
  const summary = text
    ? (text.includes('\n') ? text.split('\n')[0] : text)
    : (isRunning ? '执行中...' : isError ? '执行失败' : '执行完成')

  return (
    <div className={`command-row-card${isError ? ' command-row-error' : ''}`} data-state={node.status}>
      <button
        type="button"
        className={`disclosure-head command-head${open ? ' disclosure-open' : ''}${hasBody ? '' : ' disclosure-static'}`}
        aria-expanded={hasBody ? open : undefined}
        onClick={hasBody ? () => setOpen((v) => !v) : undefined}
      >
        <span className="row-leading" aria-hidden>
          {isError ? (
            <span className="tool-dot-error" />
          ) : isRunning ? (
            <span className="command-spinner" />
          ) : (
            <span className="command-icon">/</span>
          )}
          {hasBody && <IconChevron size={14} className="row-leading-chevron" />}
        </span>
        <span className="command-name">/{node.name}{node.args ? ` ${node.args}` : ''}</span>
        <span className={`command-summary${isError ? ' command-summary-error' : ''}`}>{summary}</span>
      </button>
      {open && hasBody && <pre className="command-body">{text}</pre>}
    </div>
  )
}

/** Automatic model-retry marker line. */
function RetryRow(props: { node: RetryNode }): JSX.Element {
  return (
    <div className="marker-row marker-retry">
      <span aria-hidden>↻</span> {`重试 ${props.node.attempt}`}
      {props.node.message !== undefined ? `，${props.node.message}` : ''}
    </div>
  )
}

/** Turn failure line: red dot + message + optional machine code. */
function ErrorRow(props: { node: ErrorNode }): JSX.Element {
  return (
    <div className="marker-row marker-error">
      <span className="tool-dot-error" aria-hidden /> {props.node.message}
      {props.node.code !== undefined && <span className="marker-code">{props.node.code}</span>}
    </div>
  )
}

/**
 * Dispatch one conversation node to its row component. Memoized on the node
 * reference: the store reuses node objects for unchanged rows, so during
 * streaming only the mutated node re-renders — settled markdown/diff rows are
 * not re-parsed per delta (the main long-session CPU cost). Store-reading
 * children (FileRefChip, AssistantBubble actions) keep their own
 * subscriptions, so memo does not stale them. Exported for tests.
 */
export const NodeView = memo(function NodeView(props: { node: ConversationNode; isFinalInTurn?: boolean }): JSX.Element | null {
  const { node, isFinalInTurn } = props
  switch (node.kind) {
    case 'user-message':
      return <MessageBubble node={node} />
    case 'assistant-text':
      return <AssistantBubble node={node} isFinalInTurn={isFinalInTurn} />
    case 'reasoning':
      return <ReasoningRow node={node} />
    case 'tool-call':
      return <ToolCallRow node={node} />
    case 'context-injection':
      return <ContextInjectionRow node={node} />
    case 'command':
      return <CommandRow node={node} />
    case 'compaction':
      return null
    case 'retry':
      return <RetryRow node={node} />
    case 'error':
      return <ErrorRow node={node} />
  }
})

/** Turn-tail stats row: run duration plus accumulated token usage. */
function TurnStatsRow(): JSX.Element | null {
  const stats = useAppStore((s) => s.stats)
  const lastTurnMs = useAppStore((s) => s.lastTurnMs)
  const turnStatus = useAppStore((s) => s.turnStatus)
  if (turnStatus !== 'idle' || stats === null) return null
  const parts: string[] = []
  if (lastTurnMs !== null) parts.push(`Ran for ${formatDuration(lastTurnMs)}`)
  parts.push(`输入 ${stats.inputTokens} tok`)
  parts.push(`输出 ${stats.outputTokens} tok`)
  return <div className="turn-stats-row">{parts.join(' · ')}</div>
}

export function ConversationView({ sessionId }: ConversationViewProps): JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const turnStatus = useAppStore((s) => s.turnStatus)
  const turnStartedAt = useAppStore((s) => s.turnStartedAt)
  const hasMoreHistory = useAppStore((s) => s.hasMoreHistory)
  const loadingOlder = useAppStore((s) => s.loadingOlder)
  const loadOlderHistory = useAppStore((s) => s.loadOlderHistory)

  const scrollRef = useRef<HTMLElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Scroll height captured when a Load-older request starts. */
  const prependHeightRef = useRef<number | null>(null)

  // Bottom-follow: new flow content snaps to the floor only while pinned.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el !== null && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [nodes, turnStatus])

  // After a prepend lands, restore the reader's position over the new head.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el !== null && !loadingOlder && prependHeightRef.current !== null) {
      el.scrollTop += el.scrollHeight - prependHeightRef.current
      prependHeightRef.current = null
    }
  }, [loadingOlder, nodes])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD
    atBottomRef.current = pinned
    setAtBottom(pinned)
  }

  const toBottom = (): void => {
    const el = scrollRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }

  const loadOlder = (): void => {
    const el = scrollRef.current
    if (el !== null) prependHeightRef.current = el.scrollHeight
    void loadOlderHistory(sessionId)
  }

  /** Think/tool-call runs folded into collapsible rounds (see rounds.ts). */
  const flowItems = useMemo(() => groupRounds(nodes), [nodes])

  /**
   * Identifies the final assistant-text node in each turn. Mid-turn narration
   * before a tool-call or earlier text nodes in a multi-message response stay chrome-free.
   */
  const finalAssistantNodeIds = useMemo(() => {
    const ids = new Set<string>()
    let currentLastAssistantId: string | null = null
    for (const node of nodes) {
      if (node.kind === 'user-message') {
        if (currentLastAssistantId !== null) {
          ids.add(currentLastAssistantId)
          currentLastAssistantId = null
        }
      } else if (node.kind === 'assistant-text') {
        currentLastAssistantId = node.id
      }
    }
    if (currentLastAssistantId !== null) {
      ids.add(currentLastAssistantId)
    }
    return ids
  }, [nodes])

  /** SegmentRail click: scroll the message row into view and unpin bottom-follow. */
  const jumpToNode = (nodeId: string): void => {
    const el = scrollRef.current
    if (el === null) return
    const row = el.querySelector(`[data-node-id="${nodeId}"]`)
    if (!(row instanceof HTMLElement)) return
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 12
    atBottomRef.current = false
    setAtBottom(false)
  }

  return (
    <div className="conversation-wrap">
      <section
        ref={scrollRef}
        className="region region-conversation conversation-view"
        data-region="ConversationView"
        data-session={sessionId}
        onScroll={onScroll}
      >
        {hasMoreHistory && (
          <div className="conv-older">
            <button type="button" className="conv-older-btn" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? '加载中…' : 'Load older'}
            </button>
          </div>
        )}
        {nodes.length === 0 ? (
          <div className="empty-hero">输入消息，开始对话</div>
        ) : (
          <div className="conv-flow">
            {flowItems.map((item) =>
              item.kind === 'node' ? (
                <div key={item.node.id} className={`conv-node conv-node-${item.node.kind}`} data-node-id={item.node.id}>
                  <NodeView node={item.node} isFinalInTurn={finalAssistantNodeIds.has(item.node.id)} />
                </div>
              ) : (
                <div key={item.id} className="conv-node conv-node-round" data-node-id={item.id}>
                  <RoundGroup id={item.id} nodes={item.nodes} live={item.live} />
                </div>
              ),
            )}
          </div>
        )}
        {turnStatus === 'running' && turnStartedAt !== null && <TurnStatusLine startedAt={turnStartedAt} />}
        <TurnStatsRow />
        {!atBottom && (
          <div className="conv-tobottom-slot">
            <button type="button" className="conv-tobottom" aria-label="回到底部" onClick={toBottom}>
              ↓ 回到底部
            </button>
          </div>
        )}
      </section>
      <SegmentRail scrollRef={scrollRef} onJumpTo={jumpToNode} />
    </div>
  )
}
