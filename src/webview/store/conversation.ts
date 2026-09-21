/**
 * Conversation slice (owned by W3). Projects the session journal into the
 * renderable ConversationNode[] stream. `applySessionFrame` is the frozen
 * projector entry of ARCHITECTURE.md section 5.2; the slice also owns the
 * subagent catalog of the active session (`subagents/list` /
 * `subagents/interruptByParent`).
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the retired apiproxy
 * protocol broadcast every session's `session/event` frames over one socket, so
 * this slice demultiplexed them itself. The journal is now a per-session
 * `session/follow` stream that the extension opens for whichever session the
 * webview is viewing and forwards on the `session` bridge channel. Three
 * consequences shape this file:
 *
 *   - The stream is GENERATION-SCOPED. Every (re)open — first subscribe,
 *     carrier loss, host restart — begins with a `snapshot` frame whose records
 *     ARE the whole log window: it FULLY REPLACES the transcript. Only the
 *     `event` frames after it append and update incrementally. Folding a
 *     snapshot as an increment would duplicate the entire history on every
 *     reconnect.
 *   - Token-by-token assistant rendering is gone. The host offers incremental
 *     chunks only through the optional `assistantStream` mode, which this
 *     plugin deliberately does NOT request, so no `assistant/chunk` event and
 *     no `assistant-stream` frame ever reaches the webview. Text and reasoning
 *     are built from the settled `assistant/message` events instead: a step's
 *     content appears once, complete, when the step's message lands.
 *   - Queues, background jobs and projection values moved out of the session
 *     channel onto the Host-wide `session/control` stream (the `control` bridge
 *     channel): see `applyConversationProjection` / `applyConversationControl`.
 */

import type { StateCreator } from 'zustand'
import type { CallId, SessionId } from '../../extension/protocol/brand'
import type {
  SessionAddress,
  SessionControlFrame,
  SessionControlProjectionFrame,
  SessionFollowFrame,
  SessionPageValue,
  SessionWireEvent,
} from '../../extension/protocol/follow'
import type { ContentBlock, TokenUsage } from '../../extension/protocol/llm'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  SessionStatsProjection,
  TokenUsageProjection,
} from '../../extension/protocol/projections'
import type { SessionEvent, SessionEventType } from '../../extension/protocol/session'
import type { SessionProjectionsBlock } from '../../extension/protocol/sessions'
import type {
  SubagentCatalog,
  SubagentInterruptReceipt,
  SubagentListEntry,
} from '../../extension/protocol/subagents'
import type { JobView } from '../../extension/protocol/views'
import { rpc } from '../bridge'
import type {
  AssistantTextNode,
  CommandNode,
  ConversationNode,
  ReasoningNode,
  TodoItem,
  ToolCallNode,
  TurnStats,
  TurnStatus,
  UserMessageNode,
} from '../types'
import type { AppStore } from './index'

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
  /**
   * Inclusive log cut the current window ends at — the `session/follow`
   * snapshot's `cursor`. Every `session/page` call carries it so a page and the
   * live tail share one cut; null until a snapshot of the active session lands.
   */
  historyCursor: number | null
  /**
   * Session whose `session/follow` snapshot built the current nodes. Event
   * frames carry no session id of their own, so this is what attributes them —
   * and what drops the leftovers of a subscription the user has already left.
   */
  followedSessionId: SessionId | null
  /** Turn lifecycle of the active session. */
  turnStatus: TurnStatus
  /** Epoch ms of the current turn's start (drives TurnStatusLine). */
  turnStartedAt: number | null
  /** Latest todo/write whole-list snapshot. */
  todos: TodoItem[]
  /** Accumulated token usage of the current/last turn. */
  stats: TurnStats | null
  /** Durable whole-log stats projection (sessionStats key), drives the ContextMeter popup. */
  sessionStats: SessionStatsProjection | null
  /** Durable token-billing projection (tokenUsage key), drives the ContextMeter popup. */
  tokenUsage: TokenUsageProjection | null
  /** Context occupancy projection (contextPressure key), drives ContextMeter. */
  contextPressure: ContextPressureProjection | null
  /** Heuristic context composition (contextBreakdown key), ContextMeter popup. */
  contextBreakdown: ContextBreakdownProjection | null
  /** Wall time of the last completed turn in ms (drives the turn-tail stats row). */
  lastTurnMs: number | null
  /** True while a Load-older page request is in flight. */
  loadingOlder: boolean
  /** Background jobs of the active session (control stream `jobs` / `baseline`). */
  activeJobs: JobView[]
  /** Direct-child subagent catalog of the active session (subagents/list). */
  activeSubagents: SubagentListEntry[]

  /** Prepend the next older history page (Load older at the top of the stream). */
  loadOlderHistory: (sessionId: SessionId) => Promise<void>
  /** Fetch the subagent catalog of one session into activeSubagents. */
  loadSubagents: (sessionId: SessionId) => Promise<void>
  /** Interrupt one continuable child of the active session, then refresh. */
  stopSubagent: (childSessionId: SessionId) => Promise<void>
  /** Fold one `session/follow` frame into conversation state (the frozen projector entry). */
  applySessionFrame: (frame: SessionFollowFrame) => void
  /** Fold one `session/control` projection frame into the rendered projection values. */
  applyConversationProjection: (frame: SessionControlProjectionFrame) => void
  /** Fold one `session/control` frame's job slots into activeJobs. */
  applyConversationControl: (frame: SessionControlFrame) => void
  /** Append an error node (a failed turn, an rpc failure surfaced inline). */
  appendError: (message: string, code?: string) => void
  /** Reset all per-session conversation state (on session switch). */
  clearConversation: () => void
}

/**
 * One journal record as it crosses the wire: a `session/follow` snapshot record
 * or one `session/page` entry. The wire only ever carries
 * `{type:'event', event}` (`SessionEventEntry`); the looser shape accepted here
 * also covers the type union's history-entry arm without a cast.
 */
type JournalRecord = { readonly event: SessionEvent | SessionWireEvent }

/**
 * Event types this projector folds into nodes or slice state. The wire types an
 * event's `type` as a plain string (the host's event map is merge-extensible),
 * so recognition has to happen here; an unrecognized or `ignorable` event is
 * dropped rather than guessed at. Step markers, request headers, compaction
 * markers and the seed sentinel are absent on purpose — they change no node and
 * no state field of this slice.
 */
const PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'command/run',
  'command/done',
  'turn/start',
  'turn/end',
  'todo/write',
] satisfies SessionEventType[])

/**
 * Narrow one wire record to the typed event vocabulary.
 * @param record - one journal record (already the shape of the wire envelope).
 * @returns the event when this projector knows its type, else null.
 */
function decodeRecord(record: JournalRecord): SessionEvent | null {
  const wire = record.event
  // The cast is safe: the wire envelope carries exactly the typed event's
  // `type`/`seq`/`time`/`data` slots, and the type itself was just recognized.
  return PROJECTED_EVENT_TYPES.has(wire.type) ? (wire as SessionEvent) : null
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

/**
 * Project one settled assistant message into text/reasoning nodes. `streaming`
 * is always false: a step's content arrives complete (see the module note on
 * the deliberately unrequested `assistantStream` mode), so the UI renders the
 * settled form from the start instead of token by token.
 */
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
function projectEvent(nodes: ConversationNode[], event: SessionEvent): ConversationNode[] {
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
    case 'assistant/message':
      // One assembled message per step: its text and reasoning blocks are the
      // whole step's content, so the nodes are appended as-is.
      return [...nodes, ...assistantNodes(event)]
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
      }
      return [...nodes.slice(0, idx), next, ...nodes.slice(idx + 1)]
    }
    case 'command/run': {
      const data = event.data
      const node: CommandNode = {
        id: `cmd-${data.commandId}`,
        kind: 'command',
        seq: event.seq,
        time: event.time,
        commandId: data.commandId,
        name: data.name,
        args: data.args ?? null,
        status: 'running',
      }
      return [...nodes, node]
    }
    case 'command/done': {
      const data = event.data
      const idx = nodes.findIndex((n) => n.kind === 'command' && n.commandId === data.commandId)
      if (idx >= 0) {
        const prev = nodes[idx] as CommandNode
        const next: CommandNode = {
          ...prev,
          seq: event.seq,
          time: event.time,
          status: data.kind,
          text: data.text,
        }
        return [...nodes.slice(0, idx), next, ...nodes.slice(idx + 1)]
      }
      const node: CommandNode = {
        id: `cmd-${data.commandId}`,
        kind: 'command',
        seq: event.seq,
        time: event.time,
        commandId: data.commandId,
        name: 'command',
        args: null,
        status: data.kind,
        text: data.text,
      }
      return [...nodes, node]
    }
    default:
      return nodes // turn/step markers and headers update other state fields
  }
}

/** Derived conversation state folded out of one contiguous journal window. */
interface ProjectedJournal {
  nodes: ConversationNode[]
  stats: TurnStats | null
  todos: TodoItem[]
  lastTurnMs: number | null
  /** Start time of the newest turn that has not ended yet (a running turn). */
  runningSince: number | null
}

/**
 * Fold one contiguous journal window into projected conversation state. The two
 * windows that reach it are the `session/follow` snapshot (the whole opening
 * window of a generation) and a `session/page` answer (one older page), so the
 * result always replaces whatever window it describes.
 * @param records - the window's records, oldest first.
 * @returns render nodes plus the turn/usage/todo state the window implies.
 */
function projectJournal(records: readonly JournalRecord[]): ProjectedJournal {
  let nodes: ConversationNode[] = []
  let stats: TurnStats | null = null
  let todos: TodoItem[] = []
  let lastTurnMs: number | null = null
  const turnStarts = new Map<number, number>()
  const endedTurns = new Set<number>()
  for (const record of records) {
    const event = decodeRecord(record)
    if (event === null) continue
    nodes = projectEvent(nodes, event)
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
  // The window's tail is the live log, so a session running in the background
  // carries its open turn's turn/start here — that time resumes the elapsed
  // clock when the user re-enters the session (no turn/end yet).
  let runningSince: number | null = null
  for (const [turn, start] of turnStarts) {
    if (!endedTurns.has(turn) && (runningSince === null || start > runningSince)) runningSince = start
  }
  return { nodes, stats, todos, lastTurnMs, runningSince }
}

/** The four projection slots this slice renders. */
interface ConversationProjections {
  sessionStats: SessionStatsProjection | null
  tokenUsage: TokenUsageProjection | null
  contextPressure: ContextPressureProjection | null
  contextBreakdown: ContextBreakdownProjection | null
}

/**
 * Read the four rendered projection keys out of one projection cut (the follow
 * snapshot's baseline, which describes the window just installed). A key absent
 * from `values` means the projection unit is not mounted on the host, so the
 * slot becomes null and the UI hides the meter instead of showing zeros.
 * @param values - one whole-projection cut, when the host supplied one.
 * @returns the four slots keyed by the slice's state field names.
 */
function readProjections(values?: SessionProjectionsBlock['values']): ConversationProjections {
  return {
    sessionStats: values?.sessionStats ?? null,
    tokenUsage: values?.tokenUsage ?? null,
    contextPressure: values?.contextPressure ?? null,
    contextBreakdown: values?.contextBreakdown ?? null,
  }
}

/** The session address a `session/page` request targets. */
function sessionAddress(sessionId: SessionId): SessionAddress {
  return { kind: 'session', sessionId }
}

export const createConversationSlice: StateCreator<AppStore, [], [], ConversationSlice> = (set, get) => ({
  nodes: [],
  hasMoreHistory: false,
  historyCursor: null,
  followedSessionId: null,
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

  loadOlderHistory: async (sessionId) => {
    const cursor = get().historyCursor
    // Backward paging is cut-anchored: without a follow snapshot cursor there
    // is no sound `throughSeq`, and `hasMoreHistory` is only ever set by that
    // same snapshot (or by a previous page).
    if (!get().hasMoreHistory || get().loadingOlder || cursor === null) return
    const beforeSeq = get().nodes[0]?.seq
    if (beforeSeq === undefined) return
    set({ loadingOlder: true })
    try {
      const page = await rpc<SessionPageValue>('session/page', {
        request: { address: sessionAddress(sessionId), throughSeq: cursor, beforeSeq },
      })
      // A session switch may have happened while the page was in flight; a
      // stale page must not prepend into another session's transcript.
      if (get().activeSessionId !== sessionId) return
      set({
        nodes: [...projectJournal(page.records).nodes, ...get().nodes],
        hasMoreHistory: page.hasMore,
        // Earlier pages only prepend content; stats/todos/lastTurnMs describe
        // the newest turn and the four projections stay owned by the follow
        // snapshot plus the control stream's projection frames.
      })
    } finally {
      set({ loadingOlder: false })
    }
  },

  loadSubagents: async (sessionId) => {
    const catalog = await rpc<SubagentCatalog>('subagents/list', { parentSessionId: sessionId })
    // A session switch may have happened while the call was in flight.
    if (get().activeSessionId === sessionId) set({ activeSubagents: catalog.entries })
  },

  stopSubagent: async (childSessionId) => {
    const parentSessionId = get().activeSessionId
    if (parentSessionId === null) return
    // The receipt only acknowledges admission; the refreshed catalog reports
    // the actual activity flip to 'inactive'.
    await rpc<SubagentInterruptReceipt>('subagents/interruptByParent', {
      parentSessionId,
      childSessionId,
      mode: 'continuable',
    })
    await get().loadSubagents(parentSessionId)
  },

  applySessionFrame: (frame) => {
    switch (frame.type) {
      case 'snapshot': {
        // GENERATION BOUNDARY: this frame's records ARE the whole opening
        // window of the stream, so the transcript is rebuilt from scratch —
        // never appended to what a previous generation left behind.
        const sessionId = frame.header.id
        // Stale generation: the user has already left this session (the
        // subscription was replaced, but a frame can still be in flight).
        if (sessionId !== get().activeSessionId) return
        const journal = projectJournal(frame.records)
        // A session running in the background when we enter it: the open turn's
        // turn/start (folded from the snapshot) resumes turnStatus and the
        // elapsed clock instead of resetting to idle — the stop button already
        // rides the session metadata running flag, this restores the timer.
        const running = get().sessions.find((s) => s.sessionId === sessionId)?.running === true
        const resumed = running && journal.runningSince !== null
        set({
          nodes: journal.nodes,
          stats: journal.stats,
          todos: journal.todos,
          lastTurnMs: journal.lastTurnMs,
          turnStatus: resumed ? 'running' : 'idle',
          turnStartedAt: resumed ? journal.runningSince : null,
          hasMoreHistory: frame.hasMore,
          historyCursor: frame.cursor,
          followedSessionId: sessionId,
          loadingOlder: false,
          ...readProjections(frame.projections?.values),
        })
        get().applyGoalHistory(sessionId, frame.projections?.values)
        break
      }
      case 'event': {
        // Increment: only a session whose snapshot was already applied may
        // extend the transcript, because these frames carry no session id.
        const sessionId = get().followedSessionId
        if (sessionId === null || sessionId !== get().activeSessionId) return
        const event = decodeRecord(frame)
        if (event === null) return
        set({ nodes: projectEvent(get().nodes, event) })
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
      case 'assistant-stream':
        // Arrives only for clients that request `assistantStream`, which this
        // plugin deliberately does not (see the module note); the settled
        // `assistant/message` events above carry all the content.
        break
    }
  },

  applyConversationProjection: (frame) => {
    if (frame.sessionId !== get().activeSessionId) return
    // Whole-value projection updates (higher-seq-wins on the host); fan out by
    // key. The title key stays owned by the sessions slice and the goal key by
    // the goal slice, so both fall through here.
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
  },

  applyConversationControl: (frame) => {
    switch (frame.type) {
      // GENERATION BOUNDARY: the control stream opens with exactly one baseline
      // carrying the complete queue, job and projection maps. Only the active
      // session's jobs belong to this slice: queue frames are the composer
      // slice's and the projection values are seeded by the follow snapshot (a
      // different cut, so mixing the two would need per-key seq ordering — the
      // stream's per-key deltas carry that seq and are applied below).
      case 'baseline': {
        const active = get().activeSessionId
        if (active === null) return
        set({ activeJobs: [...(frame.value.jobs[active] ?? [])] })
        break
      }
      case 'jobs':
        // Whole-set replacement after every registry commit (higher-wins on host).
        if (frame.sessionId !== get().activeSessionId) return
        set({ activeJobs: [...frame.jobs] })
        break
      case 'projection':
        get().applyConversationProjection(frame)
        break
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
      historyCursor: null,
      followedSessionId: null,
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
