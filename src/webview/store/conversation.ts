/**
 * Conversation slice (owned by W3). Projects mux frames into the renderable
 * ConversationNode[] stream. applyMuxFrame is the frozen projector entry of
 * ARCHITECTURE.md section 5.2; it handles session/event + session/projection
 * frames here, snapshots the session/jobs frame into activeJobs, and ignores
 * overlay/queue frames (routed to their own slices by store/index.ts). It
 * also owns the subagent catalog of the active session (subagent.list /
 * subagent.interrupt).
 */

import type { StateCreator } from 'zustand'
import type { CallId, SessionId } from '../../extension/protocol/brand'
import type { MuxFrame, ToolEventView } from '../../extension/protocol/events'
import type { ContentBlock, TokenUsage } from '../../extension/protocol/llm'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  SessionStatsProjection,
  TokenUsageProjection,
} from '../../extension/protocol/projections'
import type { SessionEvent } from '../../extension/protocol/session'
import type { SessionRpc } from '../../extension/protocol/sessions'
import type {
  SubagentCatalog,
  SubagentInterruptReceipt,
  SubagentListEntry,
} from '../../extension/protocol/subagents'
import type { JobView } from '../../extension/protocol/views'
import { rpc } from '../bridge'
import type {
  AssistantTextNode,
  ConversationNode,
  ReasoningNode,
  TodoItem,
  ToolCallNode,
  TurnStats,
  TurnStatus,
  UserMessageNode,
} from '../types'
import type { AppStore } from './index'

type HistoryResult = SessionRpc['session.history']['value']

/** Parsed IDE-context block appended to a prompt (selection or file path). */
export interface IdeBlockHint {
  /** Compact display label, e.g. `选中代码（/work/src/a.ts）`. */
  label: string
  /** The source path parsed from the block, when present. */
  path?: string
}

/**
 * Split an IDE-context block off the end of a prompt text. The block markers
 * (`### 选中代码（`, `### 文件：`, `### 当前文件：`) are produced by the
 * send-time injection and the manual insert commands; the model receives the
 * full text but the user bubble shows only `clean` (with a hint row instead).
 * @param text - message text possibly carrying a trailing IDE block.
 * @returns the clean text plus the parsed hint (null when no block).
 */
export function findIdeBlock(text: string): { clean: string; hint: IdeBlockHint | null } {
  const match = /\n\n### (?:选中代码（|文件：|当前文件：)/.exec(text)
  if (match === null) return { clean: text, hint: null }
  const block = text.slice(match.index + 2)
  const clean = text.slice(0, match.index)
  const selection = /^### 选中代码（([^）]*)）/.exec(block)
  const filePath = /^### (?:文件|当前文件)：(.+)/.exec(block)
  if (selection !== null) {
    return { clean, hint: { label: `选中代码（${selection[1]}）`, path: selection[1] } }
  }
  if (filePath !== null) {
    const path = filePath[1]?.trim() ?? ''
    return { clean, hint: path === '' ? null : { label: `当前文件：${path}`, path } }
  }
  return { clean, hint: null }
}

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
  /** Durable whole-log stats projection (sessionStats key), drives StatsLine. */
  sessionStats: SessionStatsProjection | null
  /** Durable token-billing projection (tokenUsage key), drives StatsLine. */
  tokenUsage: TokenUsageProjection | null
  /** Context occupancy projection (contextPressure key), drives ContextMeter. */
  contextPressure: ContextPressureProjection | null
  /** Heuristic context composition (contextBreakdown key), ContextMeter tooltip. */
  contextBreakdown: ContextBreakdownProjection | null
  /** Wall time of the last completed turn in ms (drives the turn-tail stats row). */
  lastTurnMs: number | null
  /** True while a Load-older page request is in flight. */
  loadingOlder: boolean
  /** Background jobs visible to the active session (session/jobs snapshot). */
  activeJobs: JobView[]
  /** Direct-child subagent catalog of the active session (subagent.list). */
  activeSubagents: SubagentListEntry[]

  /** Load the history tail page of a session and project it into nodes. */
  loadHistory: (sessionId: SessionId) => Promise<void>
  /** Prepend the next older history page (Load older at the top of the stream). */
  loadOlderHistory: (sessionId: SessionId) => Promise<void>
  /** Fetch the subagent catalog of one session into activeSubagents. */
  loadSubagents: (sessionId: SessionId) => Promise<void>
  /** Interrupt one continuable child of the active session, then refresh. */
  stopSubagent: (childSessionId: SessionId) => Promise<void>
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
      // IDE context blocks (auto-injected selection / current-file path) are
      // part of the prompt the model sees but are NOT shown in the user
      // bubble — they collapse into a compact context-injection hint row.
      const visible: ContentBlock[] = []
      let hint: IdeBlockHint | null = null
      for (const block of msg.content) {
        if (block.type !== 'text' && block.type !== 'image') continue
        if (block.type === 'text') {
          const split = findIdeBlock(block.text)
          if (split.clean !== '') visible.push({ ...block, text: split.clean })
          if (split.hint !== null) hint = split.hint
        } else {
          visible.push(block)
        }
      }
      const userNode: UserMessageNode = {
        id: `e${event.seq}`,
        kind: 'user-message',
        seq: event.seq,
        time: event.time,
        messageId: msg.id,
        blocks: visible,
      }
      if (hint === null) return [...nodes, userNode]
      return [
        ...nodes,
        userNode,
        {
          id: `e${event.seq}-ctx`,
          kind: 'context-injection',
          seq: event.seq,
          time: event.time,
          plugin: `ide：${hint.label}`,
          text: hint.path ?? hint.label,
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

/** Fold one history page into projected conversation state. */
function projectPage(entries: HistoryResult['events']): {
  nodes: ConversationNode[]
  stats: TurnStats | null
  todos: TodoItem[]
  lastTurnMs: number | null
  /** Start time of the newest turn that has not ended yet (a running turn). */
  runningSince: number | null
} {
  let nodes: ConversationNode[] = []
  let stats: TurnStats | null = null
  let todos: TodoItem[] = []
  let lastTurnMs: number | null = null
  const turnStarts = new Map<number, number>()
  const endedTurns = new Set<number>()
  for (const entry of entries) {
    nodes = projectEvent(nodes, entry.event, entry.view)
    const event = entry.event
    if (event.type === 'turn/start') turnStarts.set(event.data.turn, event.time)
    if (event.type === 'turn/end') {
      endedTurns.add(event.data.turn)
      const start = turnStarts.get(event.data.turn)
      if (start !== undefined) lastTurnMs = Math.max(0, event.time - start)
    }
    if (event.type === 'assistant/message' && event.data.usage) {
      stats = addUsage(stats, event.data.usage)
    }
    if (event.type === 'todo/write') todos = event.data.todos
  }
  // The tail page folds the live log, so a session running in the background
  // carries its open turn's turn/start here — that time resumes the elapsed
  // clock when the user re-enters the session (no turn/end yet).
  let runningSince: number | null = null
  for (const [turn, start] of turnStarts) {
    if (!endedTurns.has(turn) && (runningSince === null || start > runningSince)) runningSince = start
  }
  return { nodes, stats, todos, lastTurnMs, runningSince }
}

export const createConversationSlice: StateCreator<AppStore, [], [], ConversationSlice> = (set, get) => ({
  nodes: [],
  hasMoreHistory: false,
  turnStatus: 'idle',
  turnStartedAt: null,
  todos: [],
  stats: null,
  sessionStats: null,
  tokenUsage: null,
  contextPressure: null,
  contextBreakdown: null,
  lastTurnMs: null,
  loadingOlder: false,
  activeJobs: [],
  activeSubagents: [],

  loadHistory: async (sessionId) => {
    const page = await rpc<HistoryResult>('session.history', { sessionId })
    // A session switch may have happened while the page was in flight; a stale
    // page must not overwrite the current session's nodes or projections.
    if (get().activeSessionId !== sessionId) return
    const { nodes, stats, todos, lastTurnMs, runningSince } = projectPage(page.events)
    // The tail page carries the projection baseline (one consistent cut);
    // a key absent from values means the capability is absent on the host.
    const values = page.projections?.values
    get().applyGoalHistory(sessionId, values)
    // A session running in the background when we enter it: the open turn's
    // turn/start (from the tail page) resumes turnStatus and the elapsed clock
    // instead of resetting to idle — the stop button already rides the session
    // metadata running flag (PROGRESS 08-15 16:20), this restores the timer.
    const sessionRunning = get().sessions.find((s) => s.sessionId === sessionId)?.running === true
    const resumed = sessionRunning && runningSince !== null
    set({
      nodes,
      stats,
      todos,
      lastTurnMs,
      hasMoreHistory: page.hasMore,
      turnStatus: resumed ? 'running' : 'idle',
      turnStartedAt: resumed ? runningSince : null,
      sessionStats: values?.sessionStats ?? null,
      tokenUsage: values?.tokenUsage ?? null,
      contextPressure: values?.contextPressure ?? null,
      contextBreakdown: values?.contextBreakdown ?? null,
    })
  },

  loadOlderHistory: async (sessionId) => {
    if (!get().hasMoreHistory || get().loadingOlder) return
    const beforeSeq = get().nodes[0]?.seq
    if (beforeSeq === undefined) return
    set({ loadingOlder: true })
    try {
      const page = await rpc<HistoryResult>('session.history', { sessionId, beforeSeq })
      const older = projectPage(page.events)
      set({
        nodes: [...older.nodes, ...get().nodes],
        hasMoreHistory: page.hasMore,
        // Earlier pages only prepend content; stats/todos/lastTurnMs describe
        // the latest turn and the four projections stay owned by the tail
        // page's baseline plus live session/projection frames.
      })
    } finally {
      set({ loadingOlder: false })
    }
  },

  loadSubagents: async (sessionId) => {
    const catalog = await rpc<SubagentCatalog>('subagent.list', { parentSessionId: sessionId })
    // A session switch may have happened while the call was in flight.
    if (get().activeSessionId === sessionId) set({ activeSubagents: catalog.entries })
  },

  stopSubagent: async (childSessionId) => {
    const parentSessionId = get().activeSessionId
    if (parentSessionId === null) return
    // The receipt only acknowledges admission; the refreshed catalog reports
    // the actual activity flip to 'inactive'.
    await rpc<SubagentInterruptReceipt>('subagent.interrupt', {
      parentSessionId,
      childSessionId,
      mode: 'continuable',
    })
    await get().loadSubagents(parentSessionId)
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
          set({ turnStatus: 'running', turnStartedAt: event.time, stats: null, lastTurnMs: null })
        } else if (event.type === 'turn/end') {
          const startedAt = get().turnStartedAt
          set({
            turnStatus: 'idle',
            turnStartedAt: null,
            lastTurnMs: startedAt === null ? get().lastTurnMs : Math.max(0, event.time - startedAt),
          })
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
      case 'session/projection': {
        get().applyGoalMuxFrame(frame)
        // Whole-value projection updates (higher-seq-wins on the host); fan
        // out by key. The title key stays owned by the sessions slice.
        switch (frame.key) {
          case 'sessionStats':
            set({ sessionStats: frame.value as SessionStatsProjection })
            break
          case 'tokenUsage':
            set({ tokenUsage: frame.value as TokenUsageProjection })
            break
          case 'contextPressure':
            set({ contextPressure: frame.value as ContextPressureProjection })
            break
          case 'contextBreakdown':
            set({ contextBreakdown: frame.value as ContextBreakdownProjection })
            break
          default:
            break
        }
        break
      }
      case 'session/jobs':
        // Whole-set snapshot after every registry commit (higher-wins on host).
        set({ activeJobs: frame.jobs })
        break
      // approval/question/queue frames are routed to their own slices.
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
    get().resetGoal()
    set({
      nodes: [],
      hasMoreHistory: false,
      turnStatus: 'idle',
      turnStartedAt: null,
      todos: [],
      stats: null,
      sessionStats: null,
      tokenUsage: null,
      contextPressure: null,
      contextBreakdown: null,
      lastTurnMs: null,
      loadingOlder: false,
      activeJobs: [],
      activeSubagents: [],
    })
  },
})
