/**
 * Mock bridge client (implements the BridgeClient surface of ../api.ts).
 * Lets W2-W6 develop without a dsh host: 30 fake sessions, one demo session
 * with a scripted history (reasoning + tool call + todos) and a scripted live
 * stream (prompt -> text -> tool call -> approval -> question -> done), plus a
 * two-provider model catalog and minimal settings namespaces.
 * Selection: bridge.ts picks this module for `?mock` / VITE_DSH_MOCK=1.
 */

import type { ApprovalRequestId, CallId, MessageId, SessionId } from '../../extension/protocol/brand'
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  HostFrame,
  MuxFrame,
} from '../../extension/protocol/events'
import type { SessionEvent } from '../../extension/protocol/session'
import type { HistoryEntry, SessionModels, SessionSummary } from '../../extension/protocol/sessions'
import type { SettingsNamespaceView } from '../../extension/protocol/settings'
import type { ConfigurableProviderView } from '../../extension/protocol/settings'
import type { HostStatus, InitPayload, SessionMeta } from '../../shared/bridge'
import type { BridgeClient } from '../api'

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

const MOCK_CWD = '/mock/workspace'
/** Session id of the demo session carrying scripted history and live stream. */
export const DEMO_SESSION_ID = 's-demo' as SessionId

const SESSION_TITLES = [
  '修复侧边栏滚动贴底', '重构 queue 投影逻辑', 'W2 会话列表联调', '添加 diff 卡片折叠',
  '排查 WS 断线重连', '整理 vendored 协议类型', 'ContextMeter 对齐设计稿', '审批面板键盘操作',
  'compaction 事件回放', '模型两级菜单分组', 'fork 会话标题继承', 'TodoPanel 状态流转',
  'EmptyHero 空态插画', 'settings.mutate 冲突处理', 'attachment 上传限流', 'host 版本兼容告警',
  'TurnStatusLine 计时', 'Markdown 流式两阶段渲染', 'ReasoningRow 折叠摘要', 'web_search 卡片来源列表',
  'QueueDock steer 插话', 'GoalBar 暂停恢复', 'Load older 分页锚点', 'SessionSearch 防抖',
  'PlanReview 三按钮行为', 'credential 写入门禁', '工具行 follow-along 跳转', 'subagent 会话标记',
  'max-tokens 截断提示', 'archive 会话回收',
]

/** Milliseconds per day, for spreading fake updatedAt values. */
const DAY_MS = 86_400_000

function buildSessions(): SessionMeta[] {
  const now = Date.now()
  const metas: SessionMeta[] = [
    {
      sessionId: DEMO_SESSION_ID,
      title: 'Demo：工具调用 + 审批 + 提问',
      updatedAt: now - 5 * 60_000,
      running: false,
      blank: false,
      cwd: MOCK_CWD,
    },
  ]
  for (let i = 0; i < 29; i += 1) {
    metas.push({
      sessionId: `s-${String(i + 1).padStart(2, '0')}` as SessionId,
      title: SESSION_TITLES[i] ?? `会话 ${i + 1}`,
      updatedAt: now - (i + 1) * (DAY_MS / 3) - i * 17 * 60_000,
      running: i === 2,
      blank: i % 9 === 8,
      cwd: MOCK_CWD,
      ...(i === 5 ? { parentSessionId: DEMO_SESSION_ID } : {}),
    })
  }
  return metas
}

const sessions: SessionMeta[] = buildSessions()
const archived = new Set<SessionId>()

let seq = 100

/** Mint one session event with a fresh seq/time. */
function ev<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  seq += 1
  return { type, seq, time: Date.now(), data } as SessionEvent
}

let msgSeq = 0
function nextMessageId(): MessageId {
  msgSeq += 1
  return `m-${msgSeq}` as MessageId
}

/** Scripted history of the demo session (finished turn: reasoning + tool call + todos). */
function demoHistory(): SessionEvent[] {
  const callId = 'call-1' as CallId
  return [
    ev('turn/start', { turn: 1 }),
    ev('user/message', {
      id: nextMessageId(),
      role: 'user',
      content: [{ type: 'text', text: '帮我看一下 store 的切片划分有没有冲突' }],
      source: { kind: 'user' },
    }),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: nextMessageId(),
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先列出每个 slice 的状态字段，检查是否有两个 slice 写同一字段。' },
          { type: 'text', text: '我先读一下各个 slice 文件，确认状态归属。' },
        ],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
      },
      usage: { inputTokens: 1280, outputTokens: 96 },
    }),
    ev('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"ls src/webview/store"}' }),
    ev('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: nextMessageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'index.ts\nsessions.ts\nconversation.ts\ncomposer.ts\noverlay.ts\nsettings.ts' }] }],
        source: { kind: 'tool', callId },
      },
    }),
    ev('todo/write', {
      todos: [
        { content: '检查 slice 字段归属', status: 'completed' },
        { content: '确认事件路由只在 index.ts', status: 'in_progress' },
        { content: '输出结论', status: 'pending' },
      ],
    }),
    ev('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: nextMessageId(),
        role: 'assistant',
        content: [{ type: 'text', text: '结论：六个 slice 字段两两不相交，事件路由统一在 `store/index.ts` 的 initialize() 里扇出，没有写冲突。' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
      },
      usage: { inputTokens: 2100, outputTokens: 140, reasoningTokens: 60 },
    }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** Model catalog served by session.models. */
const MODELS: SessionModels = {
  current: { provider: 'deepseek-official', model: 'deepseek-chat' },
  routable: true,
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话模型' },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: '推理模型',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High', description: '最长思考链' },
            ],
            defaultEffort: 'medium',
          },
        },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        { id: 'gpt-5-mini', name: 'GPT-5 mini' },
        { id: 'gpt-5', name: 'GPT-5', reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'high', name: 'High' }] } },
      ],
    },
  ],
  failures: [],
}

const PROVIDERS: ConfigurableProviderView[] = [
  { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-openai', settingsPath: [], active: true },
]

const namespaces = new Map<string, SettingsNamespaceView>([
  ['llm-deepseek', {
    ns: 'llm-deepseek',
    schema: {},
    value: { baseURL: 'https://api.deepseek.com' },
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: false }],
    revision: 1,
  }],
])

// ---------------------------------------------------------------------------
// Listener plumbing
// ---------------------------------------------------------------------------

type EventListener = (channel: 'mux' | 'host', frame: unknown) => void
const eventListeners = new Set<EventListener>()
const statusListeners = new Set<(status: HostStatus) => void>()
const commandListeners = new Set<(command: 'newChat' | 'openSettings') => void>()

/** Emit one frame to every event listener, asynchronously (mirrors WS delivery). */
function emit(channel: 'mux' | 'host', frame: MuxFrame | HostFrame, delayMs = 0): void {
  setTimeout(() => {
    for (const cb of eventListeners) cb(channel, frame)
  }, delayMs)
}

// ---------------------------------------------------------------------------
// Scripted live stream for the demo session
// ---------------------------------------------------------------------------

const DEMO_QUESTIONS: AskUserQuestionItem[] = [
  {
    id: 'q-1',
    question: '要把这个改动直接合入 main 吗？',
    header: '合并确认',
    options: [
      { label: '合入 main', description: '直接提交到主分支' },
      { label: '先开 PR', description: '走评审流程' },
    ],
    multiSelect: false,
  },
]

/** Track the pending scripted approval so respondApproval can resolve it. */
let pendingScriptedApproval: { sessionId: SessionId; approvalId: ApprovalRequestId; callId: CallId } | null = null

/** Schedule the scripted frames answering one prompt on the demo session. */
function runDemoStream(sessionId: SessionId, text: string): void {
  const callId = `call-${seq}` as CallId
  emit('mux', { type: 'session/event', sessionId, event: ev('turn/start', { turn: 2 }) }, 100)
  emit('mux', {
    type: 'session/event',
    sessionId,
    event: ev('assistant/message', {
      turn: 2,
      step: 1,
      message: {
        id: nextMessageId(),
        role: 'assistant',
        content: [
          { type: 'reasoning', text: `用户输入：「${text}」。需要跑一次测试验证。` },
          { type: 'text', text: '收到，我先跑一下构建验证当前状态。' },
        ],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
      },
    }),
  }, 300)
  emit('mux', {
    type: 'session/event',
    sessionId,
    event: ev('tool/call', { turn: 2, step: 1, callId, name: 'bash', arguments: '{"command":"npm run build"}' }),
    view: { for: 'call', view: { card: 'terminal', title: 'npm run build', cwd: MOCK_CWD } },
  }, 600)
  const approvalId = `ap-${seq}` as ApprovalRequestId
  pendingScriptedApproval = { sessionId, approvalId, callId }
  emit('mux', { type: 'approval/requested', sessionId, approvalId, toolName: 'bash', callId, reason: '需要执行构建命令 npm run build' }, 900)
}

/** Continue the scripted stream after the approval is answered. */
function finishDemoStream(approved: boolean): void {
  const pending = pendingScriptedApproval
  if (pending === null) return
  pendingScriptedApproval = null
  const { sessionId, approvalId, callId } = pending
  emit('mux', { type: 'approval/resolved', sessionId, approvalId, outcome: approved ? 'allowed-once' : 'rejected' }, 100)
  if (approved) {
    emit('mux', {
      type: 'session/event',
      sessionId,
      event: ev('tool/result', {
        turn: 2,
        step: 1,
        message: {
          id: nextMessageId(),
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'build 成功，无错误。' }] }],
          source: { kind: 'tool', callId },
        },
      }),
      view: { for: 'result', view: { card: 'terminal', title: 'npm run build', output: 'build 成功，无错误。', exitCode: 0 } },
    }, 300)
    emit('mux', { type: 'question/requested', sessionId, questions: DEMO_QUESTIONS }, 600)
  } else {
    emit('mux', {
      type: 'session/event',
      sessionId,
      event: ev('turn/end', { turn: 2, reason: { kind: 'blocked' } }),
    }, 300)
  }
}

// ---------------------------------------------------------------------------
// BridgeClient implementation
// ---------------------------------------------------------------------------

/** Mock waitInit: resolve immediately with the fake session list. */
function waitInit(): Promise<InitPayload> {
  setTimeout(() => {
    for (const cb of statusListeners) cb('ready')
  }, 0)
  return Promise.resolve({ cwd: MOCK_CWD, hostVersion: '0.0.1-mock', sessions: sessions.filter((s) => !archived.has(s.sessionId)) })
}

/** Mock rpc: dispatch on the method name over the fake data above. */
function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  const p = (params ?? {}) as Record<string, unknown>
  const respond = (value: unknown): Promise<T> => Promise.resolve(value as T)
  switch (method) {
    case 'session.list': {
      const items: SessionSummary[] = sessions
        .filter((s) => !archived.has(s.sessionId))
        .map((s) => ({
          sessionId: s.sessionId,
          updatedAt: s.updatedAt,
          running: s.running,
          blank: s.blank,
          parentSessionId: s.parentSessionId,
          origin: s.origin,
          cwd: s.cwd,
          projections: { asOfSeq: seq, values: s.title === null ? {} : { title: s.title } },
        }))
      return respond({ items })
    }
    case 'session.create': {
      const sessionId = `s-new-${Date.now()}` as SessionId
      sessions.unshift({ sessionId, title: null, updatedAt: Date.now(), running: false, blank: true, cwd: MOCK_CWD })
      emit('host', { type: 'host/session-added', sessionId, blank: true, cwd: MOCK_CWD })
      return respond({ sessionId })
    }
    case 'session.history': {
      const events: HistoryEntry[] = p['sessionId'] === DEMO_SESSION_ID ? demoHistory().map((event) => ({ event })) : []
      return respond({ events, hasMore: false, projections: { asOfSeq: seq, values: {} } })
    }
    case 'session.models':
      return respond(MODELS)
    case 'session.selectModel': {
      MODELS.current = { provider: String(p['provider']), model: String(p['model']), reasoningEffort: p['reasoningEffort'] as string | undefined }
      return respond({ selected: MODELS.current })
    }
    case 'session.rename': {
      const row = sessions.find((s) => s.sessionId === p['sessionId'])
      if (row) row.title = String(p['title'])
      return respond({ title: String(p['title']), seq })
    }
    case 'session.fork': {
      const parent = sessions.find((s) => s.sessionId === p['sessionId'])
      const sessionId = `s-fork-${Date.now()}` as SessionId
      sessions.unshift({
        sessionId,
        title: parent?.title ?? null,
        updatedAt: Date.now(),
        running: false,
        blank: false,
        parentSessionId: parent?.sessionId,
        cwd: MOCK_CWD,
      })
      emit('host', { type: 'host/session-added', sessionId, blank: false, parentSessionId: parent?.sessionId, cwd: MOCK_CWD })
      return respond({ sessionId })
    }
    case 'session.prompt': {
      const sessionId = p['sessionId'] as SessionId
      const content = p['content'] as Array<{ type: string; text?: string }>
      const text = content.find((c) => c.type === 'text')?.text ?? ''
      const row = sessions.find((s) => s.sessionId === sessionId)
      if (row) row.updatedAt = Date.now()
      if (sessionId === DEMO_SESSION_ID) runDemoStream(sessionId, text)
      else emit('mux', { type: 'session/event', sessionId, event: ev('turn/start', { turn: 1 }) }, 100)
      return respond({ accepted: true })
    }
    case 'session.updateQueue':
      return respond({ accepted: true })
    case 'session.cancel':
      return respond({ accepted: true })
    case 'workspace.archiveSession': {
      archived.add(p['sessionId'] as SessionId)
      emit('host', { type: 'host/archived-sessions-changed', archivedSessionIds: [...archived] })
      return respond({ archivedSessionIds: [...archived] })
    }
    case 'settings.describe':
      return respond({ writable: true, hasDocument: true, namespaces: [...namespaces.values()] })
    case 'settings.update':
    case 'settings.replace':
    case 'settings.mutate': {
      const ns = namespaces.get(String(p['ns']))
      if (ns) namespaces.set(ns.ns, { ...ns, revision: ns.revision + 1 })
      return respond(namespaces.get(String(p['ns'])))
    }
    case 'llm.providers':
      return respond({ providers: PROVIDERS })
    case 'llm.models':
      return respond({ groups: MODELS.groups, failures: [] })
    case 'credentials.set':
    case 'credentials.unset':
      return respond({})
    default:
      return Promise.reject(new Error(`mock bridge: unhandled rpc method ${method}`))
  }
}

function onEvent(cb: EventListener): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

function onHostStatus(cb: (status: HostStatus) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

function onCommand(cb: (command: 'newChat' | 'openSettings') => void): () => void {
  commandListeners.add(cb)
  return () => commandListeners.delete(cb)
}

/** Mock approval answer: resolves the scripted pending approval and continues the stream. */
function respondApproval(approvalId: ApprovalRequestId, decision: 'allow-once' | 'refuse'): Promise<void> {
  if (pendingScriptedApproval?.approvalId !== approvalId) {
    return Promise.reject(new Error(`mock bridge: unknown approval ${approvalId}`))
  }
  finishDemoStream(decision === 'allow-once')
  return Promise.resolve()
}

/** Mock question answer: emits question/resolved and finishes the scripted turn. */
function respondQuestion(sessionId: SessionId, answers: AskUserQuestionAnswerItem[]): Promise<void> {
  void answers
  emit('mux', { type: 'question/resolved', sessionId, questionRpcId: 'mock-rpc' as never, outcome: 'answered' }, 100)
  emit('mux', {
    type: 'session/event',
    sessionId,
    event: ev('assistant/message', {
      turn: 2,
      step: 2,
      message: {
        id: nextMessageId(),
        role: 'assistant',
        content: [{ type: 'text', text: '好的，按你的选择继续。构建已通过，流程演示结束。' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
      },
      usage: { inputTokens: 900, outputTokens: 48 },
    }),
  }, 300)
  emit('mux', { type: 'session/event', sessionId, event: ev('turn/end', { turn: 2, reason: { kind: 'completed' } }) }, 500)
  return Promise.resolve()
}

/** The assembled mock client, structurally identical to ../api.ts. */
export const mockBridge: BridgeClient = {
  rpc, onEvent, onHostStatus, onCommand, waitInit, respondApproval, respondQuestion,
}
