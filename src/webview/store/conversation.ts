/**
 * Conversation slice (owned by W3). Projects mux frames into the renderable
 * ConversationNode[] stream. applyMuxFrame is the frozen projector entry of
 * ARCHITECTURE.md section 5.2; it handles session/event + session/projection
 * frames here and ignores overlay/queue frames (routed to their own slices by
 * store/index.ts).
 */

import type { StateCreator } from 'zustand'
import type { CallId, SessionId } from '../../extension/protocol/brand'
import type { MuxFrame, ToolEventView } from '../../extension/protocol/events'
import type { ContentBlock, TokenUsage } from '../../extension/protocol/llm'
import type { SessionEvent } from '../../extension/protocol/session'
import type { SessionRpc } from '../../extension/protocol/sessions'
import { rpc } from '../bridge'
import type {
  AssistantTextNode,
  ConversationNode,
  ReasoningNode,
  TodoItem,
  ToolCallNode,
  TurnStats,
  TurnStatus,
} from '../types'
import type { AppStore } from './index'

type HistoryResult = SessionRpc['session.history']['value']

/** State + actions owned by the conversation workflow. */
export interface ConversationSlice {
  /** Current session's render nodes, in arrival order. */
  nodes: ConversationNode[]
  /** True when earlier history pages exist (Load older). */
  hasMoreHistory: boolean
  /** Turn lifecycle of the active session. */
  turnStatus: TurnStatus
  /** Epoch ms of the current turn's start (drives TurnStatusLine). */
  turnStartedAt: number | null
  /** Latest todo/write whole-list snapshot. */
  todos: TodoItem[]
  /** Accumulated token usage of the current/last turn. */
  stats: TurnStats | null

  /** Load the history tail page of a session and project it into nodes. */
  loadHistory: (sessionId: SessionId) => Promise<void>
  /** Fold one mux frame into conversation state (the frozen projector entry). */
  applyMuxFrame: (frame: MuxFrame) => void
  /** Append an error node (host/agent-error, rpc failures surfaced inline). */
  appendError: (message: string, code?: string) => void
  /** Reset all per-session conversation state (on session switch). */
  clearConversation: () => void
}

/** Key of the in-flight streaming node for one (turn, step, blockIndex). */
function streamKey(turn: number, step: number, index: number): string {
  return `stream-${turn}-${step}-${index}`
}

/** Flatten content blocks to plain text (generic result fallback). */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text':
        case 'reasoning':
          return b.text
        case 'image':
          return b.attachment.name ?? '[image]'
        case 'tool-call':
          return `[tool-call ${b.name}]`
        case 'tool-result':
          return blocksToText(b.content)
        default:
          return ''
      }
    })
    .filter((t) => t !== '')
    .join('\n')
}

function addUsage(stats: TurnStats | null, usage: TokenUsage): TurnStats {
  const base: TurnStats = stats ?? { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: (base.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
  }
}

/** Project one settled assistant message into text/reasoning nodes. */
function assistantNodes(
  event: Extract<SessionEvent, { type: 'assistant/message' }>,
): ConversationNode[] {
  const out: ConversationNode[] = []
  const base = { seq: event.seq, time: event.time }
  for (const block of event.data.message.content) {
    if (block.type === 'text') {
      const node: AssistantTextNode = {
        ...base,
        id: `e${event.seq}-t${out.length}`,
        kind: 'assistant-text',
        text: block.text,
        streaming: false,
        provenance: event.data.message.source,
      }
      out.push(node)
    } else if (block.type === 'reasoning') {
      const node: ReasoningNode = {
        ...base,
        id: `e${event.seq}-r${out.length}`,
        kind: 'reasoning',
        text: block.text,
        streaming: false,
      }
      out.push(node)
    }
  }
  return out
}

/** Project one session event into node mutations, applied against `nodes`. */
function projectEvent(nodes: ConversationNode[], event: SessionEvent, view?: ToolEventView): ConversationNode[] {
  switch (event.type) {
    case 'user/message': {
      const msg = event.data
      if (msg.source.kind === 'plugin') {
        return [
          ...nodes,
          {
            id: `e${event.seq}`,
            kind: 'context-injection',
            seq: event.seq,
            time: event.time,
            plugin: msg.source.plugin,
            form: 'form' in msg.source ? msg.source.form : undefined,
            text: blocksToText(msg.content),
          },
        ]
      }
      if (msg.source.kind !== 'user') return nodes // tool results arrive via tool/result
      return [
        ...nodes,
        {
          id: `e${event.seq}`,
          kind: 'user-message',
          seq: event.seq,
          time: event.time,
          messageId: msg.id,
          blocks: msg.content.filter((b) => b.type === 'text' || b.type === 'image'),
        },
      ]
    }
    case 'assistant/message': {
      // Settled message: drop any stream placeholders of the same step first.
      const { turn, step } = event.data
      const settled = nodes.filter((n) => !n.id.startsWith(`stream-${turn}-${step}-`))
      return [...settled, ...assistantNodes(event)]
    }
    case 'assistant/chunk': {
      const { turn, step, chunk } = event.data
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return nodes
      const key = streamKey(turn, step, chunk.index)
      const kind = chunk.type === 'text-delta' ? 'assistant-text' : 'reasoning'
      const existing = nodes.findIndex((n) => n.id === key)
      if (existing >= 0) {
        const prev = nodes[existing] as AssistantTextNode | ReasoningNode
        const next = { ...prev, text: prev.text + chunk.text, seq: event.seq, time: event.time }
        return [...nodes.slice(0, existing), next, ...nodes.slice(existing + 1)]
      }
      const node: AssistantTextNode | ReasoningNode =
        kind === 'assistant-text'
          ? { id: key, kind, seq: event.seq, time: event.time, text: chunk.text, streaming: true }
          : { id: key, kind, seq: event.seq, time: event.time, text: chunk.text, streaming: true }
      return [...nodes, node]
    }
    case 'tool/call': {
      const node: ToolCallNode = {
        id: `e${event.seq}`,
        kind: 'tool-call',
        seq: event.seq,
        time: event.time,
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
        status: 'pending',
        ...(view?.for === 'call' ? { callView: view.view } : {}),
      }
      return [...nodes, node]
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const callId: CallId = block.toolCallId
      const idx = nodes.findIndex((n) => n.kind === 'tool-call' && n.callId === callId)
      if (idx < 0) return nodes
      const prev = nodes[idx] as ToolCallNode
      const next: ToolCallNode = {
        ...prev,
        seq: event.seq,
        time: event.time,
        status: event.data.error || block.isError ? 'error' : 'done',
        resultText: blocksToText(block.content),
        ...(event.data.error ? { error: event.data.error } : {}),
        ...(view?.for === 'result' ? { resultView: view.view } : {}),
      }
      return [...nodes.slice(0, idx), next, ...nodes.slice(idx + 1)]
    }
    default:
      return nodes // turn/step markers, headers and todos update other state fields
  }
}

export const createConversationSlice: StateCreator<AppStore, [], [], ConversationSlice> = (set, get) => ({
  nodes: [],
  hasMoreHistory: false,
  turnStatus: 'idle',
  turnStartedAt: null,
  todos: [],
  stats: null,

  loadHistory: async (sessionId) => {
    const page = await rpc<HistoryResult>('session.history', { sessionId })
    let nodes: ConversationNode[] = []
    let stats: TurnStats | null = null
    let todos: TodoItem[] = []
    for (const entry of page.events) {
      nodes = projectEvent(nodes, entry.event, entry.view)
      if (entry.event.type === 'assistant/message' && entry.event.data.usage) {
        stats = addUsage(stats, entry.event.data.usage)
      }
      if (entry.event.type === 'todo/write') todos = entry.event.data.todos
    }
    set({ nodes, stats, todos, hasMoreHistory: page.hasMore, turnStatus: 'idle', turnStartedAt: null })
  },

  applyMuxFrame: (frame) => {
    if (frame.type === 'stream/error') {
      get().appendError(frame.error.message, frame.error.code)
      return
    }
    if (frame.sessionId !== get().activeSessionId) return
    switch (frame.type) {
      case 'session/event': {
        const event = frame.event
        set({ nodes: projectEvent(get().nodes, event, frame.view) })
        if (event.type === 'turn/start') {
          set({ turnStatus: 'running', turnStartedAt: event.time, stats: null })
        } else if (event.type === 'turn/end') {
          set({ turnStatus: 'idle', turnStartedAt: null })
          if (event.data.reason.kind === 'error') {
            get().appendError(event.data.reason.error.message, event.data.reason.error.code)
          }
        } else if (event.type === 'assistant/message' && event.data.usage) {
          set({ stats: addUsage(get().stats, event.data.usage) })
        } else if (event.type === 'todo/write') {
          set({ todos: event.data.todos })
        }
        break
      }
      // session/projection frames are routed to the sessions slice (titles),
      // approval/question/queue frames to their own slices.
      default:
        break
    }
  },

  appendError: (message, code) => {
    const seq = get().nodes.reduce((max, n) => Math.max(max, n.seq), 0) + 1
    set({
      nodes: [
        ...get().nodes,
        { id: `err-${seq}-${Date.now()}`, kind: 'error', seq, time: Date.now(), message, code },
      ],
    })
  },

  clearConversation: () => {
    set({ nodes: [], hasMoreHistory: false, turnStatus: 'idle', turnStartedAt: null, todos: [], stats: null })
  },
})
