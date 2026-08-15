/**
 * Mock bridge client (implements the BridgeClient surface of ../api.ts).
 * Lets W2-W6 develop without a dsh host: 30 fake sessions, one demo session
 * with a scripted history (reasoning + tool call + todos), a four-key
 * projection baseline (sessionStats/tokenUsage/contextPressure/contextBreakdown)
 * and a scripted live stream (prompt -> text -> tool call -> approval ->
 * question -> done), plus a two-provider model catalog and the
 * settings/credentials/agentPreset surface (namespaces, custom providers,
 * credential states, preset roster).
 * Selection: bridge.ts picks this module for `?mock` / VITE_DSH_MOCK=1.
 */

import type { ApprovalRequestId, CallId, JobId, MessageId, SessionId, WorkspaceId } from '../../extension/protocol/brand'
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  HostFrame,
  MuxFrame,
  QueuedInboxItem,
} from '../../extension/protocol/events'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  SessionStatsProjection,
  TokenUsageProjection,
} from '../../extension/protocol/projections'
import type { SessionEvent } from '../../extension/protocol/session'
import type { HistoryEntry, QueueAction, SessionModels, SessionSummary } from '../../extension/protocol/sessions'
import type { JobView, SkillEntry } from '../../extension/protocol/views'
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
    // `unread` is a webview-local field (webview/types.ts); one row is preset
    // so the blue unread dot shows up in mock screenshots.
    const row: SessionMeta & { unread?: boolean } = {
      sessionId: `s-${String(i + 1).padStart(2, '0')}` as SessionId,
      title: SESSION_TITLES[i] ?? `会话 ${i + 1}`,
      updatedAt: now - (i + 1) * (DAY_MS / 3) - i * 17 * 60_000,
      running: i === 2,
      blank: i % 9 === 8,
      cwd: MOCK_CWD,
      ...(i === 5 ? { parentSessionId: DEMO_SESSION_ID } : {}),
    }
    if (i === 4) row.unread = true
    metas.push(row)
  }
  return metas
}

const sessions: SessionMeta[] = buildSessions()
const archived = new Set<SessionId>()

/**
 * Projection baseline served with the demo session's history tail page. The
 * figures are chosen so StatsLine reads
 * `1 turns · 17 steps | LLM 2m24s · Tool call 0.3s | TTFT avg 2.2s · 112 tok/s
 * | Cache hit 92% | Input 509K tok · Output 12K tok` and ContextMeter sits at
 * 45% of a 128K window.
 */
const DEMO_PROJECTIONS: {
  sessionStats: SessionStatsProjection
  tokenUsage: TokenUsageProjection
  contextPressure: ContextPressureProjection
  contextBreakdown: ContextBreakdownProjection
} = {
  sessionStats: {
    turns: 1,
    steps: 17,
    llmMs: 144_000,
    toolMs: 300,
    ttftMs: 2_200,
    ttftSteps: 1,
    decodeMs: 10_000,
    decodeTokens: 1_120,
  },
  tokenUsage: {
    uncachedInputTokens: 24_720,
    outputTokens: 12_000,
    cacheReadTokens: 468_280,
    cacheWriteTokens: 16_000,
  },
  contextPressure: { pressureTokens: 57_600, projectedTokens: 57_600, contextWindow: 128_000 },
  contextBreakdown: { systemTokens: 12_800, toolsTokens: 8_600, messageTokens: 36_200 },
}

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

// ---------------------------------------------------------------------------
// Settings / credentials / agent-preset fake data (W6)
// ---------------------------------------------------------------------------

/** One catalog route known to the mock adapter (shipped, not user-declared). */
const BASE_PROVIDERS: ConfigurableProviderView[] = [
  { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-openai', settingsPath: [], active: true },
]

/** Skill catalog served by skill.list (drives the composer `/` suggestions). */
const SKILLS: SkillEntry[] = [
  { name: 'review', description: '审查当前改动并给出意见', modelInvocable: true },
  { name: 'test', description: '为指定代码补测试', modelInvocable: true },
  { name: 'refactor', description: '重构选中模块', whenToUse: '代码结构明显腐化时', modelInvocable: true },
  { name: 'commit', description: '整理工作区并生成提交', modelInvocable: false },
]

/** Pending inbox snapshots per session (session/queue frames), mutated by session.updateQueue. */
const queueStore = new Map<SessionId, QueuedInboxItem[]>()

/** Sessions whose scripted turn is in flight; prompts to them enqueue instead of streaming. */
const turnActive = new Set<SessionId>()

/** Demo continuable subagent of the demo session (served by subagent.list). */
const DEMO_SUBAGENT_ID = 's-sub-demo' as SessionId
/** True once subagent.interrupt was admitted for the demo subagent. */
let demoSubagentStopped = false
/** The scripted background job emitted with the demo live stream. */
let demoJob: JobView | null = null

/** Push the authoritative session/queue snapshot for one session. */
function emitQueue(sessionId: SessionId): void {
  emit('mux', { type: 'session/queue', sessionId, items: queueStore.get(sessionId) ?? [] })
}

/** Apply one queue mutation to the mock inbox and re-emit the snapshot. */
function applyQueueAction(sessionId: SessionId, itemId: MessageId, action: QueueAction): boolean {
  const items = queueStore.get(sessionId) ?? []
  const item = items.find((i) => i.id === itemId)
  if (item === undefined) return false
  if (action.kind === 'edit') {
    item.message = { ...item.message, content: action.content }
  } else {
    // remove + steer both drop the row (steer is claimed by the running turn).
    queueStore.set(sessionId, items.filter((i) => i.id !== itemId))
  }
  emitQueue(sessionId)
  return true
}

/** Credential state store; refs follow the `<ROUTE>_API_KEY` convention. */
const credentialStore = new Map<string, { configured: boolean; source?: string }>([
  ['DEEPSEEK_OFFICIAL_API_KEY', { configured: true, source: 'file' }],
])

/** Wire view of one preset row served by agentPreset.list. */
export interface MockAgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

const PRESETS: MockAgentPresetEntry[] = [
  { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '通用编码助手，默认启用全部核心插件。' },
  { id: 'read-only', trust: 'system', isDefault: false, name: '只读分析', description: '不带写工具的代码阅读与问答预设。' },
  { id: 'my-lab', trust: 'user', isDefault: false, description: '本地实验预设。', broken: '引用了未安装的插件 lab-tools' },
]

/**
 * Deep-merge a settings.update patch into a plain section object.
 * @param target - section object mutated in place.
 * @param patch - patch object; nested plain objects merge recursively.
 */
function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const prev = target[key]
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof prev === 'object' && prev !== null && !Array.isArray(prev)
    ) {
      mergePatch(prev as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = value
    }
  }
}

/** Read the value at a dot-free path inside a plain object. */
function pathGet(source: unknown, path: string[]): unknown {
  let node = source
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Set or unset a path inside a plain object, creating/removing as needed. */
function pathApply(source: Record<string, unknown>, op: { op: 'set' | 'unset'; path: string[]; value?: unknown }): void {
  if (op.path.length === 0) return
  let node: Record<string, unknown> = source
  for (const key of op.path.slice(0, -1)) {
    const next = node[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      if (op.op === 'unset') return
      node[key] = {}
    }
    node = node[key] as Record<string, unknown>
  }
  const leaf = op.path[op.path.length - 1] as string
  if (op.op === 'set') node[leaf] = op.value
  else delete node[leaf]
}

/** The pi-ai custom-provider section: keys are hand-declared route ids. */
const piAiSection: Record<string, unknown> = {}

const namespaces = new Map<string, SettingsNamespaceView>([
  ['llm-deepseek', {
    ns: 'llm-deepseek',
    schema: { type: 'object', meta: { description: 'DeepSeek 官方端点配置' } },
    value: { baseURL: 'https://api.deepseek.com' },
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: true }],
    revision: 1,
  }],
  ['llm-openai', {
    ns: 'llm-openai',
    schema: { type: 'object', meta: { description: 'OpenAI 端点配置' } },
    value: {},
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: false }],
    revision: 1,
  }],
  ['llm-pi-ai', {
    ns: 'llm-pi-ai',
    schema: { type: 'object', meta: { description: 'OpenAI 兼容端点（自定义提供方）' } },
    value: piAiSection,
    applies: 'live',
    secrets: [],
    revision: 1,
  }],
  ['ui-theme', {
    ns: 'ui-theme',
    schema: { type: 'object', meta: { description: '外观偏好' } },
    value: { preference: 'system' },
    applies: 'live',
    secrets: [],
    revision: 1,
  }],
  ['locale', {
    ns: 'locale',
    schema: { type: 'object', meta: { description: '语言偏好' } },
    value: { preference: 'zh' },
    applies: 'live',
    secrets: [],
    revision: 1,
  }],
  ['ui-conversation', {
    ns: 'ui-conversation',
    schema: { type: 'object', meta: { description: '对话输入偏好' } },
    value: { busyEnter: 'queue' },
    applies: 'live',
    secrets: [],
    revision: 1,
  }],
  ['permission', {
    ns: 'permission',
    schema: { type: 'object', meta: { description: '权限预设' } },
    value: { defaultPreset: 'workspace-write' },
    applies: 'live',
    secrets: [],
    revision: 1,
  }],
  ['agent-presets', {
    ns: 'agent-presets',
    schema: { type: 'object', meta: { description: 'Agent 预设默认值' } },
    value: { default: 'standard' },
    applies: 'live',
    secrets: [],
    revision: 1,
  }],
  ['plugin-web-search', {
    ns: 'plugin-web-search',
    schema: { type: 'object', meta: { description: '网页搜索插件：引擎、结果数与超时。' } },
    value: { engine: 'bing', maxResults: 5 },
    applies: 'restart',
    secrets: [{ path: ['apiKey'], set: false }],
    revision: 1,
  }],
])

/** Configurable provider directory: shipped routes plus pi-ai declarations. */
function llmProviders(): ConfigurableProviderView[] {
  const declared = Object.keys(piAiSection).map((id) => {
    const profile = piAiSection[id] as { displayName?: unknown }
    return {
      provider: id,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : id,
      settingsNs: 'llm-pi-ai',
      settingsPath: [id],
      active: credentialStore.get(`${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)?.configured === true,
      declared: true as const,
    }
  })
  return [...BASE_PROVIDERS, ...declared]
}

/** Settings/credentials/agentPreset call log, for .temp verification scripts. */
export const mockSettingsRpcLog: Array<{ method: string; params: Record<string, unknown> }> = []

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
  turnActive.add(sessionId)
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
  // Live projection frame: context pressure grows as the turn proceeds.
  emit('mux', {
    type: 'session/projection',
    sessionId,
    key: 'contextPressure',
    value: {
      pressureTokens: 64_500,
      projectedTokens: 64_500,
      contextWindow: 128_000,
    } satisfies ContextPressureProjection,
    seq,
  }, 700)
  // Background-job snapshot: one running job appears alongside the turn.
  demoJob = { id: 'bash-1' as JobId, kind: 'bash', label: 'npm run build', status: 'running', startedAt: Date.now() }
  emit('mux', { type: 'session/jobs', sessionId, jobs: [demoJob] }, 650)
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
    turnActive.delete(sessionId)
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
  if (/^(settings|credentials|agentPreset)\./.test(method)) {
    mockSettingsRpcLog.push({ method, params: p })
  }
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
    case 'workspace.create': {
      // Idempotent per-path workspace resolution; the mock owns one workspace.
      const workspace = {
        workspaceId: 'ws-mock' as WorkspaceId,
        path: MOCK_CWD,
        title: 'mock-workspace',
        sessionIds: sessions.map((s) => s.sessionId),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      return respond({ workspace, created: false })
    }
    case 'session.create': {
      const sessionId = `s-new-${Date.now()}` as SessionId
      sessions.unshift({ sessionId, title: null, updatedAt: Date.now(), running: false, blank: true, cwd: MOCK_CWD })
      emit('host', { type: 'host/session-added', sessionId, blank: true, cwd: MOCK_CWD })
      return respond({ sessionId })
    }
    case 'session.history': {
      const isDemo = p['sessionId'] === DEMO_SESSION_ID
      const events: HistoryEntry[] = isDemo ? demoHistory().map((event) => ({ event })) : []
      return respond({
        events,
        hasMore: false,
        projections: { asOfSeq: seq, values: isDemo ? { ...DEMO_PROJECTIONS } : {} },
      })
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
      const content = p['content'] as Array<{ type: string; text?: string; name?: string }>
      const row = sessions.find((s) => s.sessionId === sessionId)
      if (row) row.updatedAt = Date.now()
      if (turnActive.has(sessionId)) {
        // A turn is in flight: the prompt lands in the pending inbox.
        const items = queueStore.get(sessionId) ?? []
        const id = nextMessageId()
        items.push({
          id,
          placement: 'queued',
          message: {
            id,
            role: 'user',
            content: content
              .map((c) => (c.type === 'text' ? { type: 'text' as const, text: c.text ?? '' } : null))
              .filter((c): c is { type: 'text'; text: string } => c !== null),
            source: { kind: 'user' },
          },
        })
        queueStore.set(sessionId, items)
        emitQueue(sessionId)
        return respond({ accepted: true })
      }
      const text = content.find((c) => c.type === 'text')?.text ?? ''
      if (sessionId === DEMO_SESSION_ID) runDemoStream(sessionId, text)
      else emit('mux', { type: 'session/event', sessionId, event: ev('turn/start', { turn: 1 }) }, 100)
      return respond({ accepted: true })
    }
    case 'session.updateQueue': {
      const sessionId = p['sessionId'] as SessionId
      const ok = applyQueueAction(sessionId, p['itemId'] as MessageId, p['action'] as QueueAction)
      return ok ? respond({ accepted: true }) : Promise.reject(new Error(`mock bridge: unknown queue item ${String(p['itemId'])}`))
    }
    case 'skill.list':
      return respond({ skills: SKILLS })
    case 'session.cancel':
      return respond({ accepted: true })
    case 'subagent.list': {
      // The demo session has one continuable running child until interrupted.
      const isDemo = p['parentSessionId'] === DEMO_SESSION_ID
      return respond({
        entries: isDemo
          ? [{
            kind: 'child',
            id: DEMO_SUBAGENT_ID,
            activity: demoSubagentStopped ? 'inactive' : 'running',
            hasChildren: false,
            mode: 'continuable',
            label: '调研 store 切片划分',
          }]
          : [],
        parentAvailable: true,
      })
    }
    case 'subagent.interrupt': {
      if (p['childSessionId'] !== DEMO_SUBAGENT_ID) {
        return Promise.reject(new Error(`mock bridge: unknown subagent ${String(p['childSessionId'])}`))
      }
      demoSubagentStopped = true
      emit('host', { type: 'host/session-status', sessionId: DEMO_SUBAGENT_ID, running: false })
      return respond({ accepted: true })
    }
    case 'workspace.archiveSession': {
      archived.add(p['sessionId'] as SessionId)
      emit('host', { type: 'host/archived-sessions-changed', archivedSessionIds: [...archived] })
      return respond({ archivedSessionIds: [...archived] })
    }
    case 'settings.describe':
      return respond({ writable: true, hasDocument: true, namespaces: [...namespaces.values()] })
    case 'settings.update': {
      const ns = namespaces.get(String(p['ns']))
      if (!ns) return Promise.reject(new Error(`mock bridge: unknown settings ns ${String(p['ns'])}`))
      const value = structuredClone(ns.value ?? {}) as Record<string, unknown>
      mergePatch(value, (p['patch'] ?? {}) as Record<string, unknown>)
      const updated: SettingsNamespaceView = { ...ns, value, user: value, revision: ns.revision + 1 }
      namespaces.set(ns.ns, updated)
      return respond(updated)
    }
    case 'settings.replace': {
      const ns = namespaces.get(String(p['ns']))
      if (!ns) return Promise.reject(new Error(`mock bridge: unknown settings ns ${String(p['ns'])}`))
      const updated: SettingsNamespaceView = {
        ...ns,
        value: structuredClone(p['section'] ?? {}),
        user: structuredClone(p['section'] ?? {}),
        revision: ns.revision + 1,
      }
      namespaces.set(ns.ns, updated)
      return respond(updated)
    }
    case 'settings.mutate': {
      const ns = namespaces.get(String(p['ns']))
      if (!ns) return Promise.reject(new Error(`mock bridge: unknown settings ns ${String(p['ns'])}`))
      const value = structuredClone(ns.value ?? {}) as Record<string, unknown>
      for (const op of (p['ops'] ?? []) as Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) {
        pathApply(value, op)
      }
      // The pi-ai section object is the declaration registry; mutate it too so
      // llm.providers reflects added/removed custom providers.
      if (ns.ns === 'llm-pi-ai') {
        for (const key of Object.keys(piAiSection)) delete piAiSection[key]
        Object.assign(piAiSection, value)
      }
      const updated: SettingsNamespaceView = { ...ns, value, user: value, revision: ns.revision + 1 }
      namespaces.set(ns.ns, updated)
      return respond(updated)
    }
    case 'llm.providers':
      return respond({ providers: llmProviders() })
    case 'llm.models':
      return respond({ groups: MODELS.groups, failures: [] })
    case 'host.describe':
      // Echo the saved default so the composer chip preselects the last model.
      return respond({
        version: '0.0.1-mock',
        cwd: MOCK_CWD,
        provider: MODELS.current.provider,
        model: MODELS.current.model,
        attachedSessions: 1,
        canOpenPath: false,
      })
    case 'credentials.describe': {
      const refs = (p['refs'] ?? []) as string[]
      const credentials: Record<string, { configured: boolean; source?: string; writable: boolean }> = {}
      for (const ref of refs) {
        const state = credentialStore.get(ref)
        credentials[ref] = { configured: state?.configured === true, ...(state?.source === undefined ? {} : { source: state.source }), writable: true }
      }
      return respond({ credentials })
    }
    case 'credentials.set': {
      const ref = String(p['ref'])
      credentialStore.set(ref, { configured: true, source: 'file' })
      return respond({})
    }
    case 'credentials.unset': {
      credentialStore.delete(String(p['ref']))
      return respond({})
    }
    case 'agentPreset.list': {
      const defaultId = pathGet(namespaces.get('agent-presets')?.value, ['default'])
      return respond({
        presets: PRESETS.map((preset) => ({ ...preset, isDefault: preset.id === defaultId })),
        authorable: true,
        hasDocument: false,
      })
    }
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
  turnActive.delete(sessionId)
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
  // Live projection frame: the durable token-usage total absorbs the turn.
  emit('mux', {
    type: 'session/projection',
    sessionId,
    key: 'tokenUsage',
    value: {
      uncachedInputTokens: 25_620,
      outputTokens: 12_048,
      cacheReadTokens: 468_280,
      cacheWriteTokens: 16_000,
    } satisfies TokenUsageProjection,
    seq,
  }, 400)
  emit('mux', { type: 'session/event', sessionId, event: ev('turn/end', { turn: 2, reason: { kind: 'completed' } }) }, 500)
  // The scripted job settles with the turn.
  if (demoJob !== null) {
    emit('mux', {
      type: 'session/jobs',
      sessionId,
      jobs: [{ ...demoJob, status: 'completed', finishedAt: Date.now() }],
    }, 600)
    demoJob = null
  }
  return Promise.resolve()
}

/** The assembled mock client, structurally identical to ../api.ts. */
export const mockBridge: BridgeClient = {
  rpc, onEvent, onHostStatus, onCommand, waitInit, respondApproval, respondQuestion,
}
