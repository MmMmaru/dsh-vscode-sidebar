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
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the mock used to deliver two
 * loosely-typed apiproxy frame families (`channel: 'mux' | 'host'`). It now
 * delivers the same four discriminated channels the real bridge does, and every
 * stream is GENERATION-SCOPED: a (re)opened stream sends its full-replacement
 * baseline (`session/control` baseline, `workspace/follow` baseline,
 * `session/follow` snapshot) before any delta, because the consumers replace
 * their state with that opening frame instead of merging into it. The session
 * journal is no longer broadcast either — `followSession` opens it for exactly
 * one address and `unfollowSession` closes it.
 *
 * RPC renames this file had to absorb (retired apiproxy name -> Remote endpoint):
 *
 *   session.list             -> session/list                 (`_request` envelope)
 *   session.history          -> the session/follow stream, plus unary session/page
 *   session.models           -> session/modelCatalog
 *   session.create           -> session/create
 *   session.rename           -> session/rename
 *   session.cancel           -> session/cancel
 *   session.prompt           -> session/prompt
 *   session.selectModel      -> session/selectModel
 *   session.updateQueue      -> session/updateQueue
 *   llm.providers            -> llm/listConfigurableProviders (answers a bare array)
 *   llm.models               -> session/modelCatalog
 *   settings.describe        -> settings/describe
 *   settings.update          -> settings/update
 *   settings.replace         -> settings/replace
 *   settings.mutate          -> settings/mutate
 *   credentials.describe     -> credentials/describe          (answers the bare record)
 *   credentials.set          -> credentials/set               (void value)
 *   credentials.unset        -> credentials/unset             (void value)
 *   agentPreset.list         -> agentPresets/list
 *   goal.create|edit|pause|resume|complete|clear
 *                            -> goals/create|edit|pause|resume|complete|clear
 *   skill.list               -> skills/list
 *   subagent.list            -> subagents/list
 *   subagent.interrupt       -> subagents/interruptByParent
 *   workspace.create         -> workspace/create
 *   workspace.archiveSession -> workspace/archiveSession
 *   host.describe            -> DELETED (no Remote method reports a host version)
 *
 * `session/attachment` was never served by this mock (its demo data holds no
 * image attachments), so there is nothing to rename for it.
 */

import type { CallId, GoalId, JobId, MessageId, SessionId, WorkspaceId } from '../../extension/protocol/brand'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '../../extension/protocol/events'
import type { RpcError } from '../../extension/protocol/rpc'
import type {
  SessionAddress,
  SessionControlBaselineFrame,
  SessionControlFrame,
  SessionEventEntry,
  SessionFollowFrame,
  SessionProjectionBaseline,
  SessionQueuedItem,
  SessionWireEvent,
  SessionWireHeader,
} from '../../extension/protocol/follow'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  SessionStatsProjection,
  TokenUsageProjection,
} from '../../extension/protocol/projections'
import type { SessionEvent } from '../../extension/protocol/session'
import type { HistoryEntry, QueueAction, SessionModels, SessionSummary } from '../../extension/protocol/sessions'
import type { JobView, SkillEntry, WorkspaceView } from '../../extension/protocol/views'
import type { GoalProjection, GoalRef, GoalView } from '../../extension/protocol/goals'
import type { SettingsNamespaceView } from '../../extension/protocol/settings'
import type { ConfigurableProviderView } from '../../extension/protocol/settings'
import type { WorkspaceFollowFrame } from '../../extension/protocol/workspace'
import type {
  HostStatus,
  IdeContentKind,
  IdeContentPayload,
  InitPayload,
  PendingApprovalOverlay,
  PendingOverlayReplay,
  PendingQuestionOverlay,
  RemoteChannelMessage,
  SessionMeta,
} from '../../shared/bridge'
import type { BridgeClient, StreamFailure } from '../api'

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
    // so the green unread dot shows up in mock screenshots.
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
 * figures are chosen so the ContextMeter popup reads
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

/**
 * Mint one durable session event with a fresh seq/time.
 *
 * The value is minted straight into the WIRE envelope ({@link SessionWireEvent})
 * rather than the typed `SessionEvent`, because that is what a `session/follow`
 * frame carries: the two differ only in `surfaceOp`, and the wire is the shape
 * every consumer of this mock is written against.
 * @param type - the event type.
 * @param data - that type's payload.
 * @returns the wire event.
 */
function ev<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionWireEvent {
  seq += 1
  return { type, seq, time: Date.now(), data }
}

let msgSeq = 0
function nextMessageId(): MessageId {
  msgSeq += 1
  return `m-${msgSeq}` as MessageId
}

/** Scripted history of the demo session (finished turn: reasoning + tool call + todos). */
function demoHistory(): SessionWireEvent[] {
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

/**
 * Model catalog backing the mock (its `current` route is what
 * `session/modelCatalog` reports as the host default).
 */
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

/** Skill catalog served by skills/list (drives the composer `/` suggestions). */
const SKILLS: SkillEntry[] = [
  { name: 'review', description: '审查当前改动并给出意见', modelInvocable: true },
  { name: 'test', description: '为指定代码补测试', modelInvocable: true },
  { name: 'refactor', description: '重构选中模块', whenToUse: '代码结构明显腐化时', modelInvocable: true },
  { name: 'commit', description: '整理工作区并生成提交', modelInvocable: false },
]

/** Pending inbox snapshots per session (control `queue` frames), mutated by session/updateQueue. */
const queueStore = new Map<SessionId, SessionQueuedItem[]>()

/** Sessions whose scripted turn is in flight; prompts to them enqueue instead of streaming. */
const turnActive = new Set<SessionId>()

/** Demo continuable subagent of the demo session (served by subagents/list). */
const DEMO_SUBAGENT_ID = 's-sub-demo' as SessionId
/** True once subagents/interruptByParent was admitted for the demo subagent. */
let demoSubagentStopped = false
/** The scripted background job emitted with the demo live stream. */
let demoJob: JobView | null = null

/** Demo goal served with the demo session's follow snapshot. */
const DEMO_GOAL: GoalProjection = {
  goal: {
    id: 'goal-demo' as GoalId,
    revision: 1,
    objective: '完成侧边栏 Goal 条联调',
    phase: 'active',
    maxGoalRounds: 4,
  },
  roundsStarted: 1,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 10_000,
}

/** Per-session goal projection store (the real host owns one goal per session). */
const goalStore = new Map<SessionId, GoalProjection | null>([[DEMO_SESSION_ID, DEMO_GOAL]])

/**
 * Test hook: substitute the scripted journal of a session (e.g. a session
 * with an open turn, to verify running-turn resume). Consumed by the
 * `session/follow` opening snapshot (and by `session/page`) before the
 * demo-scripted fallback.
 */
export const mockHistoryOverrides = new Map<SessionId, HistoryEntry[]>()

/** Test hook: rpc methods in this set reject (failure-path tests). */
export const mockRpcFailures = new Set<string>()

/**
 * Test hook: records a `session/page` answer should carry, keyed by session.
 *
 * The mock journal is not windowed — a `session/follow` snapshot always carries
 * it whole — so the derived head page is empty and `loadOlderHistory` cannot be
 * exercised against it. An entry here is answered verbatim in place of the
 * derived slice (a scripted older window); `hasMore` stays false.
 */
export const mockPageOverrides = new Map<SessionId, SessionEventEntry[]>()

/** Test hook: `setEnv` rejects while set (rollback-path tests). */
export const mockEnvFailures = { enabled: false }

/** Test hook: custom host environment the mock init payload reports. */
export const mockInitEnv: { env: Record<string, string> } = { env: {} }

/**
 * Test hook: stream scopes whose next generation must NOT open, so a scripted
 * scenario can ask for a dead stream (the host can kill one stream while the
 * carrier stays up). Add `session/control`, `workspace/follow`, or
 * `session/follow` to exercise the `onStreamError` path: the scope reports a
 * failure instead of its baseline, and no frames of that generation follow.
 */
export const mockStreamFailures = new Set<string>()

/** Read one session's current goal projection, `null` when none exists. */
function currentGoal(sessionId: SessionId): GoalProjection | null {
  return goalStore.get(sessionId) ?? null
}

/** Flatten one goal projection into the `GoalView` every mutating goals/* answers. */
function goalViewOf(projection: GoalProjection): GoalView {
  return {
    ...projection.goal,
    roundsStarted: projection.roundsStarted,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    activation: 'disarmed',
  }
}

/**
 * The complete projection cut for one session. The control baseline and the
 * follow snapshot carry the SAME shape, because a generation boundary is a
 * full replacement of every projection value: a key omitted here means the
 * unit is absent, which is why `title` (nullable) is always stated.
 * @param sessionId - the session whose values are cut.
 * @returns the projection values at the mock's current seq.
 */
function projectionValues(sessionId: SessionId): Record<string, unknown> {
  const row = sessions.find((s) => s.sessionId === sessionId)
  return {
    ...(sessionId === DEMO_SESSION_ID ? DEMO_PROJECTIONS : {}),
    goal: currentGoal(sessionId),
    title: row?.title ?? null,
    sessionListMetadata: { blank: row?.blank ?? false, lastPromptAt: null },
    modelSelection: { lastUsed: MODELS.current, next: MODELS.current },
  }
}

/** The mock's one workspace row (idempotent `workspace/create` answers it). */
function mockWorkspace(): WorkspaceView {
  return {
    workspaceId: 'ws-mock' as WorkspaceId,
    path: MOCK_CWD,
    title: 'mock-workspace',
    sessionIds: sessions.map((s) => s.sessionId),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** One `session/list` row (the old inline title now rides the projections). */
function sessionSummaryOf(row: SessionMeta): SessionSummary {
  return {
    sessionId: row.sessionId,
    updatedAt: row.updatedAt,
    running: row.running,
    blank: row.blank,
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.origin === undefined ? {} : { origin: row.origin }),
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    projections: { asOfSeq: seq, values: projectionValues(row.sessionId) },
  }
}

/** The journal one session would serve: a test override, the demo script, or empty. */
function sessionRecords(sessionId: SessionId): SessionEventEntry[] {
  const override = mockHistoryOverrides.get(sessionId)
  if (override !== undefined) {
    // `mockHistoryOverrides` predates the wire envelope and holds typed events;
    // the wire form is the same payload in the log-position envelope.
    return override.map((entry) => ({ type: 'event', event: entry.event as unknown as SessionWireEvent }))
  }
  if (sessionId !== DEMO_SESSION_ID) return []
  return demoHistory().map((event) => ({ type: 'event', event }))
}

/**
 * Read the journal identity out of a wire session address (either arm).
 * @param address - the address as it crossed the wire.
 * @returns the session id, or null when the value is not an address.
 */
function addressSessionId(address: unknown): SessionId | null {
  if (typeof address !== 'object' || address === null) return null
  const record = address as { kind?: unknown; sessionId?: unknown; childSessionId?: unknown }
  if (record.kind === 'subagent' && typeof record.childSessionId === 'string') return record.childSessionId as SessionId
  if (typeof record.sessionId === 'string') return record.sessionId as SessionId
  return null
}

/** Whether the mock knows this session (a root session or the demo subagent). */
function isKnownSession(sessionId: SessionId): boolean {
  return sessionId === DEMO_SUBAGENT_ID || sessions.some((s) => s.sessionId === sessionId)
}

/** Credential state store; refs follow the `<ROUTE>_API_KEY` convention. */
const credentialStore = new Map<string, { configured: boolean; source?: string }>([
  ['DEEPSEEK_OFFICIAL_API_KEY', { configured: true, source: 'file' }],
])

/** Wire view of one preset row served by agentPresets/list. */
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
 * Deep-merge a settings/update patch into a plain section object.
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

/** One hand-declared pi-ai provider plus the settings path it lives at. */
interface DeclaredProvider {
  id: string
  profile: { displayName?: unknown }
  /** Path inside the `llm-pi-ai` section; `['providers', id]` for the host layout. */
  path: string[]
}

/**
 * Read the hand-declared custom providers out of the pi-ai section.
 *
 * The host's CustomProviderCard writes them under the section's `providers` map
 * keyed by route id (`{op:'set', path:['providers', route]}`), which is the
 * layout `settingsPath` must mirror. Root-level keys are still read as a
 * fallback so a section seeded in the older flat shape keeps resolving.
 * @returns one entry per declared route.
 */
function declaredProviders(): DeclaredProvider[] {
  const declared: DeclaredProvider[] = []
  const nested = piAiSection['providers']
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    for (const [id, profile] of Object.entries(nested)) {
      declared.push({
        id,
        profile: (typeof profile === 'object' && profile !== null ? profile : {}) as { displayName?: unknown },
        path: ['providers', id],
      })
    }
  }
  for (const [id, profile] of Object.entries(piAiSection)) {
    if (id === 'providers') continue
    declared.push({
      id,
      profile: (typeof profile === 'object' && profile !== null ? profile : {}) as { displayName?: unknown },
      path: [id],
    })
  }
  return declared
}

/** Configurable provider directory: shipped routes plus pi-ai declarations. */
function llmProviders(): ConfigurableProviderView[] {
  const declared = declaredProviders().map((entry) => {
    const { id, profile, path } = entry
    return {
      provider: id,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : id,
      settingsNs: 'llm-pi-ai',
      settingsPath: path,
      active: credentialStore.get(`${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)?.configured === true,
      declared: true as const,
    }
  })
  return [...BASE_PROVIDERS, ...declared]
}

/** Settings/credentials/agentPreset call log, for .temp verification scripts. */
export const mockSettingsRpcLog: Array<{ method: string; params: Record<string, unknown> }> = []
/** Goal RPC calls captured by durable store tests (no credentials involved). */
export const mockGoalRpcLog: Array<{ method: string; params: Record<string, unknown> }> = []

// ---------------------------------------------------------------------------
// Listener plumbing (the four Remote channels)
// ---------------------------------------------------------------------------

/** One subscriber consuming forwarded channel messages. */
type ChannelListener = (message: RemoteChannelMessage) => void

const eventListeners = new Set<ChannelListener>()
const streamErrorListeners = new Set<(failure: StreamFailure) => void>()
const statusListeners = new Set<(status: HostStatus) => void>()
const commandListeners = new Set<(command: 'newChat' | 'openSettings') => void>()
const ideContentListeners = new Set<(content: IdeContentPayload) => void>()

/**
 * Deliver one channel message to every subscriber, asynchronously (mirrors the
 * round trip through the extension host).
 * @param message - the discriminated channel message.
 * @param delayMs - scheduling delay standing in for carrier latency.
 */
function post(message: RemoteChannelMessage, delayMs = 0): void {
  setTimeout(() => {
    for (const cb of eventListeners) cb(message)
  }, delayMs)
}

/**
 * Deliver one Host-wide `session/control` frame (queue, jobs, projection).
 * @param frame - the control frame.
 * @param delayMs - scheduling delay.
 */
function emitControl(frame: SessionControlFrame, delayMs = 0): void {
  post({ channel: 'control', frame }, delayMs)
}

/**
 * Deliver one `workspace/follow` frame (its baseline, then ordered increments).
 * @param frame - the workspace frame.
 * @param delayMs - scheduling delay.
 */
function emitWorkspace(frame: WorkspaceFollowFrame, delayMs = 0): void {
  post({ channel: 'workspace', frame }, delayMs)
}

/**
 * Deliver one sparse broadcast host event with its positional arguments.
 * @param event - the `$events` name (`approval/request`, `api-session/added`, …).
 * @param args - the event's positional arguments.
 * @param delayMs - scheduling delay.
 */
function emitRemote(event: string, args: unknown[], delayMs = 0): void {
  post({ channel: 'remote', event, args }, delayMs)
}

/**
 * Report one logically dead stream. A dead stream does not drop the carrier, so
 * this is the only way a consumer can see the failure.
 * @param scope - the stream that died (`session/control`, `session/follow`, …).
 * @param error - the host-side error.
 * @param delayMs - scheduling delay.
 */
function emitStreamError(scope: string, error: RpcError, delayMs = 0): void {
  setTimeout(() => {
    for (const cb of streamErrorListeners) cb({ scope, error })
  }, delayMs)
}

/** The error one scripted dead stream reports. */
function deadStreamError(scope: string): RpcError {
  return { code: 'internal', message: `mock bridge: scripted dead ${scope} stream`, details: {} }
}

/** Test/verification hook: deliver an `ide-content` payload exactly like the
 * real extension host would after an `ide-request`. */
export function mockEmitIdeContent(content: IdeContentPayload): void {
  for (const cb of ideContentListeners) cb(content)
}

/**
 * Test/verification hook: deliver one sparse `remote`-channel event exactly as
 * the extension forwards an `$events` broadcast (`approval/request`,
 * `user-questions/request`, `request/cancelled`, `api-session/*`, …).
 * @param event - the `$events` name.
 * @param args - the event's positional arguments.
 */
export function mockEmitRemote(event: string, args: unknown[]): void {
  emitRemote(event, args)
}

/**
 * Test/verification hook: deliver one Host-wide `session/control` frame
 * (`baseline` / `queue` / `jobs` / `projection`) like the real stream would.
 * @param frame - the control frame.
 */
export function mockEmitControl(frame: SessionControlFrame): void {
  emitControl(frame)
}

// ---------------------------------------------------------------------------
// Stream generations (baseline first, deltas after)
// ---------------------------------------------------------------------------

/**
 * The session whose journal the consumer currently follows, or null. The
 * `session` channel is per-subscription, so the mock tracks it here exactly
 * like the extension tracks its `session/follow` stream.
 */
let followedSessionId: SessionId | null = null

/** Whether this session's journal is the one currently followed. */
function isFollowed(sessionId: SessionId): boolean {
  return followedSessionId !== null && followedSessionId === sessionId
}

/**
 * One complete control-stream cut: every known session's transient queue, its
 * background jobs, and its projection values. It is the opening frame of every
 * `session/control` generation, so a consumer REPLACES its mirrors with it.
 * @returns the baseline frame.
 */
function controlBaseline(): SessionControlBaselineFrame {
  const queues: Record<string, SessionQueuedItem[]> = {}
  for (const [sessionId, items] of queueStore) queues[sessionId] = [...items]
  const projections: Record<string, SessionProjectionBaseline> = {}
  for (const row of sessions) projections[row.sessionId] = { asOfSeq: seq, values: projectionValues(row.sessionId) }
  return {
    type: 'baseline',
    value: {
      queues,
      jobs: demoJob === null ? {} : { [DEMO_SESSION_ID]: [demoJob] },
      projections,
    },
  }
}

/** Open one `session/control` generation (baseline first, deltas after). */
function openControlGeneration(): void {
  if (mockStreamFailures.has('session/control')) {
    emitStreamError('session/control', deadStreamError('session/control'))
    return
  }
  emitControl(controlBaseline())
}

/** Open one `workspace/follow` generation (baseline first, deltas after). */
function openWorkspaceGeneration(): void {
  if (mockStreamFailures.has('workspace/follow')) {
    emitStreamError('workspace/follow', deadStreamError('workspace/follow'))
    return
  }
  emitWorkspace({ type: 'baseline', value: { items: [mockWorkspace()], archivedSessionIds: [...archived] } })
}

/**
 * Open a new generation of the two Host-wide streams. Both send their complete
 * baselines first: a consumer that merged deltas into a previous generation's
 * state would keep rows and queue items the host has already dropped.
 */
function openGenerations(): void {
  openControlGeneration()
  openWorkspaceGeneration()
}

/** Push one `session/control` projection frame for a goal value. */
function emitGoal(sessionId: SessionId): void {
  emitControl({ type: 'projection', sessionId, key: 'goal', value: currentGoal(sessionId), seq })
}

/** Push the authoritative `session/control` queue snapshot for one session. */
function emitQueue(sessionId: SessionId): void {
  emitControl({ type: 'queue', sessionId, items: [...(queueStore.get(sessionId) ?? [])] })
}

/**
 * Push one `session`-channel delta of the FOLLOWED journal. The wire's `event`
 * frames carry no session id, so a frame for any other session is dropped: it
 * would otherwise be folded into whichever transcript the consumer displays.
 * @param sessionId - the session the event belongs to.
 * @param event - the settled durable event.
 * @param delayMs - scheduling delay.
 */
function emitSessionEvent(sessionId: SessionId, event: SessionWireEvent, delayMs = 0): void {
  setTimeout(() => {
    if (!isFollowed(sessionId)) return
    for (const cb of eventListeners) cb({ channel: 'session', frame: { type: 'event', event } })
  }, delayMs)
}

/** Broadcast one session's running flip (the list's stop button / unread dot). */
function emitSessionStatus(sessionId: SessionId, running: boolean, delayMs = 0): void {
  emitRemote('api-session/status', [sessionId, running], delayMs)
}

/**
 * Subscribe to one session journal, replacing any previous subscription. The
 * subscription opens a fresh generation whose FIRST frame is a `snapshot`
 * carrying the whole opening window, so the consumer rebuilds the transcript
 * from it instead of appending.
 * @param address - the session (or addressed direct-subagent) to follow.
 */
function followSession(address: SessionAddress): void {
  const sessionId = addressSessionId(address)
  if (sessionId === null) {
    followedSessionId = null
    emitStreamError('session/follow', {
      code: 'bad-request',
      message: 'mock bridge: malformed session address',
      details: { issues: [address] },
    })
    return
  }
  followedSessionId = sessionId
  if (mockStreamFailures.has('session/follow')) {
    emitStreamError('session/follow', deadStreamError('session/follow'))
    return
  }
  if (!isKnownSession(sessionId)) {
    emitStreamError('session/follow', {
      code: 'session-not-found',
      message: `mock bridge: unknown session ${sessionId}`,
      details: { sessionId },
    })
    return
  }
  emitSessionSnapshot(address, sessionId)
}

/** Deliver one follow generation's opening snapshot. */
function emitSessionSnapshot(address: SessionAddress, sessionId: SessionId): void {
  const row = sessions.find((s) => s.sessionId === sessionId)
  const parentSession = address.kind === 'subagent' ? address.parentSessionId : row?.parentSessionId
  const origin = address.kind === 'subagent' ? 'subagent' : row?.origin
  const header: SessionWireHeader = {
    version: 1,
    id: sessionId,
    createdAt: row?.updatedAt ?? Date.now(),
    isSeeded: false,
    ...(row?.cwd === undefined ? {} : { cwd: row.cwd }),
    ...(parentSession === undefined ? {} : { parentSession }),
    ...(origin === undefined ? {} : { origin }),
    ...(address.kind === 'subagent' ? { delegationDepth: 1 } : {}),
  }
  const frame: SessionFollowFrame = {
    type: 'snapshot',
    header,
    cursor: seq,
    records: sessionRecords(sessionId),
    hasMore: false,
    projections: { asOfSeq: seq, values: projectionValues(sessionId) },
  }
  post({ channel: 'session', frame })
}

/** Drop the current session-journal subscription. */
function unfollowSession(): void {
  followedSessionId = null
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
let pendingScriptedApproval: { sessionId: SessionId; eventId: string; callId: CallId } | null = null

/** Track the pending scripted question batch so respondQuestion can resolve it. */
let pendingScriptedQuestion: { sessionId: SessionId; eventId: string } | null = null

/** The flat approval overlay the `approval/request` broadcast carries. */
function approvalOverlay(eventId: string, agentId: SessionId, callId: CallId): PendingApprovalOverlay {
  return {
    kind: 'approval',
    eventId,
    agentId,
    toolName: 'bash',
    callId,
    reason: '需要执行构建命令 npm run build',
  }
}

/** Schedule the scripted frames answering one prompt on the demo session. */
function runDemoStream(sessionId: SessionId, text: string): void {
  turnActive.add(sessionId)
  const callId = `call-${seq}` as CallId
  emitSessionStatus(sessionId, true)
  emitSessionEvent(sessionId, ev('turn/start', { turn: 2 }), 100)
  emitSessionEvent(sessionId, ev('assistant/message', {
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
  }), 300)
  emitSessionEvent(sessionId, ev('tool/call', { turn: 2, step: 1, callId, name: 'bash', arguments: '{"command":"npm run build"}' }), 600)
  // Live control projection: context pressure grows as the turn proceeds.
  emitControl({
    type: 'projection',
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
  const job: JobView = { id: 'bash-1' as JobId, kind: 'bash', label: 'npm run build', status: 'running', startedAt: Date.now() }
  demoJob = job
  emitControl({ type: 'jobs', sessionId, jobs: [job] }, 650)
  const eventId = `ap-${seq}`
  pendingScriptedApproval = { sessionId, eventId, callId }
  emitRemote('approval/request', [approvalOverlay(eventId, sessionId, callId)], 900)
}

/** Continue the scripted stream after the approval is answered. */
function finishDemoStream(approved: boolean): void {
  const pending = pendingScriptedApproval
  if (pending === null) return
  pendingScriptedApproval = null
  const { sessionId, eventId, callId } = pending
  // The overlay is keyed by its request event id; the retraction confirms the
  // answer the UI already applied optimistically.
  emitRemote('request/cancelled', [eventId], 100)
  if (approved) {
    emitSessionEvent(sessionId, ev('tool/result', {
      turn: 2,
      step: 1,
      message: {
        id: nextMessageId(),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'build 成功，无错误。' }] }],
        source: { kind: 'tool', callId },
      },
    }), 300)
    const question: PendingQuestionOverlay = {
      kind: 'question',
      eventId: `q-${seq}`,
      agentId: sessionId,
      questions: DEMO_QUESTIONS,
    }
    pendingScriptedQuestion = { sessionId, eventId: question.eventId }
    emitRemote('user-questions/request', [question], 600)
  } else {
    turnActive.delete(sessionId)
    emitSessionEvent(sessionId, ev('turn/end', { turn: 2, reason: { kind: 'blocked' } }), 300)
    emitSessionStatus(sessionId, false, 300)
  }
}

// ---------------------------------------------------------------------------
// BridgeClient implementation
// ---------------------------------------------------------------------------

/**
 * Mock waitInit: resolve immediately with the fake session list plus the
 * workspace cut the `workspace/follow` baseline would carry. The retired
 * `hostVersion` field is gone (nothing reports a host version any more).
 * @returns the init payload.
 */
function waitInit(): Promise<InitPayload> {
  setTimeout(() => {
    for (const cb of statusListeners) cb('ready')
  }, 0)
  return Promise.resolve({
    cwd: MOCK_CWD,
    port: 3080,
    env: mockInitEnv.env,
    sessions: sessions.filter((s) => !archived.has(s.sessionId)),
    workspaces: [mockWorkspace()],
    archivedSessionIds: [...archived],
  })
}

/**
 * Read the `request` envelope one Remote method takes.
 * @param params - the method's `args` object.
 * @returns the request object, or `{}` when the caller sent none.
 */
function readRequest(params: Record<string, unknown>): Record<string, unknown> {
  const request = params['request']
  return typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {}
}

/** Mock rpc: dispatch on the Remote endpoint name over the fake data above. */
function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  const p = (params ?? {}) as Record<string, unknown>
  const respond = (value: unknown): Promise<T> => Promise.resolve(value as T)
  // Test hook: forced transport-level failures (see mockRpcFailures).
  if (mockRpcFailures.has(method)) return Promise.reject(new Error(`mock bridge: forced failure for ${method}`))
  if (/^(settings|credentials|agentPresets)\//.test(method)) {
    mockSettingsRpcLog.push({ method, params: p })
  }
  if (method.startsWith('goals/')) mockGoalRpcLog.push({ method, params: { ...p } })
  switch (method) {
    case 'session/list': {
      // The one method whose wire parameter is not named `request`.
      const items: SessionSummary[] = sessions
        .filter((s) => !archived.has(s.sessionId))
        .map(sessionSummaryOf)
      return respond({ items })
    }
    case 'workspace/create': {
      // Idempotent per-path workspace resolution; the mock owns one workspace.
      return respond({ workspace: mockWorkspace(), created: false })
    }
    case 'session/create': {
      const request = readRequest(p) as { request?: never; cwd?: string; sessionId?: SessionId; agentPreset?: string }
      const sessionId = request.sessionId ?? (`s-new-${Date.now()}` as SessionId)
      const row: SessionMeta = {
        sessionId,
        title: null,
        updatedAt: Date.now(),
        running: false,
        blank: true,
        cwd: request.cwd ?? MOCK_CWD,
      }
      sessions.unshift(row)
      // Session additions are a sparse broadcast; the row also carries its
      // title projection, which is what the list renders.
      emitRemote('api-session/added', [sessionSummaryOf(row)])
      return respond({
        sessionId,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      })
    }
    case 'session/page': {
      const request = readRequest(p)
      const sessionId = addressSessionId(request['address'])
      if (sessionId === null) {
        return Promise.reject(new Error('mock bridge: session/page without a session address'))
      }
      const beforeSeq = request['beforeSeq']
      const override = mockPageOverrides.get(sessionId)
      const records = override
        ?? sessionRecords(sessionId)
          .filter((entry) => typeof beforeSeq !== 'number' || entry.event.seq < beforeSeq)
      return respond({ records, hasMore: false })
    }
    case 'goals/create': {
      const agentId = p['agentId'] as SessionId
      const request = readRequest(p)
      const now = Date.now()
      const goal: GoalProjection = {
        goal: {
          id: `goal-${now}` as GoalId,
          revision: 1,
          objective: String(request['objective'] ?? ''),
          phase: 'active',
          maxGoalRounds: Number(request['maxGoalRounds'] ?? 4),
        },
        roundsStarted: 0,
        createdAt: now,
        updatedAt: now,
      }
      goalStore.set(agentId, goal)
      emitGoal(agentId)
      return respond({ ref: { id: goal.goal.id, revision: goal.goal.revision } satisfies GoalRef })
    }
    case 'goals/edit':
    case 'goals/pause':
    case 'goals/resume':
    case 'goals/complete':
    case 'goals/clear': {
      const agentId = p['agentId'] as SessionId
      const ref = p['ref'] as GoalRef
      const current = currentGoal(agentId)
      if (current === null || current.goal.id !== ref.id || current.goal.revision !== ref.revision) {
        return Promise.reject(new Error('mock goal revision conflict'))
      }
      if (method === 'goals/clear') {
        goalStore.set(agentId, null)
        emitGoal(agentId)
        return respond({ id: ref.id, revision: ref.revision } satisfies GoalRef)
      }
      const phase = method === 'goals/pause' ? 'paused'
        : method === 'goals/resume' ? 'active'
          : method === 'goals/complete' ? 'complete'
            : current.goal.phase
      const objective = method === 'goals/edit'
        ? String(readRequest(p)['objective'] ?? current.goal.objective)
        : current.goal.objective
      const nextRef: GoalRef = { id: current.goal.id, revision: current.goal.revision + 1 }
      const next: GoalProjection = {
        ...current,
        updatedAt: Date.now(),
        goal: { ...current.goal, ...nextRef, phase, objective },
      }
      goalStore.set(agentId, next)
      emitGoal(agentId)
      return respond(goalViewOf(next))
    }
    case 'session/modelCatalog':
      // Host-wide catalog: replaces both the retired session.models and llm.models.
      return respond({
        default: MODELS.current,
        routableProviders: MODELS.groups.map((group) => group.id),
        groups: MODELS.groups,
        failures: MODELS.failures,
      })
    case 'session/selectModel': {
      const request = readRequest(p)
      const reasoningEffort = request['reasoningEffort']
      MODELS.current = {
        provider: String(request['provider']),
        model: String(request['model']),
        ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
      }
      const sessionId = request['sessionId'] as SessionId
      if (sessionId !== undefined) {
        emitControl({
          type: 'projection',
          sessionId,
          key: 'modelSelection',
          value: { lastUsed: MODELS.current, next: MODELS.current },
          seq,
        })
      }
      return respond({ selected: MODELS.current })
    }
    case 'session/rename': {
      const request = readRequest(p)
      const row = sessions.find((s) => s.sessionId === request['sessionId'])
      if (row) row.title = String(request['title'])
      if (row !== undefined) {
        emitControl({ type: 'projection', sessionId: row.sessionId, key: 'title', value: row.title, seq })
      }
      return respond({ title: String(request['title']), seq })
    }
    case 'session/fork': {
      const request = readRequest(p)
      const parent = sessions.find((s) => s.sessionId === request['sessionId'])
      const row: SessionMeta = {
        sessionId: `s-fork-${Date.now()}` as SessionId,
        title: parent?.title ?? null,
        updatedAt: Date.now(),
        running: false,
        blank: false,
        parentSessionId: parent?.sessionId,
        cwd: MOCK_CWD,
      }
      sessions.unshift(row)
      emitRemote('api-session/added', [sessionSummaryOf(row)])
      return respond({ sessionId: row.sessionId })
    }
    case 'session/prompt': {
      const request = readRequest(p)
      const sessionId = request['sessionId'] as SessionId
      const content = (request['content'] ?? []) as Array<{ type: string; text?: string }>
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
            content: content
              .filter((block) => block.type === 'text')
              .map((block) => ({ type: 'text' as const, text: block.text ?? '' })),
          },
        })
        queueStore.set(sessionId, items)
        emitQueue(sessionId)
        return respond({ accepted: true })
      }
      const text = content.find((block) => block.type === 'text')?.text ?? ''
      if (sessionId === DEMO_SESSION_ID) runDemoStream(sessionId, text)
      else emitSessionEvent(sessionId, ev('turn/start', { turn: 1 }), 100)
      return respond({ accepted: true })
    }
    case 'session/updateQueue': {
      const request = readRequest(p)
      const sessionId = request['sessionId'] as SessionId
      const ok = applyQueueAction(sessionId, request['itemId'] as MessageId, request['action'] as QueueAction)
      return ok ? respond({ accepted: true }) : Promise.reject(new Error(`mock bridge: unknown queue item ${String(request['itemId'])}`))
    }
    case 'skills/list':
      return respond({ skills: SKILLS })
    case 'session/cancel':
      return respond({ accepted: true })
    case 'subagents/list': {
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
    case 'subagents/interruptByParent': {
      if (p['childSessionId'] !== DEMO_SUBAGENT_ID) {
        return Promise.reject(new Error(`mock bridge: unknown subagent ${String(p['childSessionId'])}`))
      }
      demoSubagentStopped = true
      emitSessionStatus(DEMO_SUBAGENT_ID, false)
      return respond({ accepted: true })
    }
    case 'workspace/archiveSession': {
      const sessionId = readRequest(p)['sessionId'] as SessionId
      archived.add(sessionId)
      // The workspace stream's archived set is a full replacement, not a delta.
      emitWorkspace({ type: 'archived', archivedSessionIds: [...archived] })
      return respond({ archivedSessionIds: [...archived] })
    }
    case 'settings/describe':
      return respond({ writable: true, hasDocument: true, namespaces: [...namespaces.values()] })
    case 'settings/update': {
      const ns = namespaces.get(String(p['ns']))
      if (!ns) return Promise.reject(new Error(`mock bridge: unknown settings ns ${String(p['ns'])}`))
      const value = structuredClone(ns.value ?? {}) as Record<string, unknown>
      mergePatch(value, (p['patch'] ?? {}) as Record<string, unknown>)
      const updated: SettingsNamespaceView = { ...ns, value, user: value, revision: ns.revision + 1 }
      namespaces.set(ns.ns, updated)
      return respond(updated)
    }
    case 'settings/replace': {
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
    case 'settings/mutate': {
      const ns = namespaces.get(String(p['ns']))
      if (!ns) return Promise.reject(new Error(`mock bridge: unknown settings ns ${String(p['ns'])}`))
      const value = structuredClone(ns.value ?? {}) as Record<string, unknown>
      for (const op of (p['ops'] ?? []) as Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) {
        pathApply(value, op)
      }
      // The pi-ai section object is the declaration registry; mutate it too so
      // llm/listConfigurableProviders reflects added/removed custom providers.
      if (ns.ns === 'llm-pi-ai') {
        for (const key of Object.keys(piAiSection)) delete piAiSection[key]
        Object.assign(piAiSection, value)
      }
      const updated: SettingsNamespaceView = { ...ns, value, user: value, revision: ns.revision + 1 }
      namespaces.set(ns.ns, updated)
      return respond(updated)
    }
    case 'llm/listConfigurableProviders':
      // Bare array: the old `{providers: [...]}` wrapper is gone.
      return respond(llmProviders())
    case 'credentials/describe': {
      const refs = (p['refs'] ?? []) as string[]
      const credentials: Record<string, { configured: boolean; source?: string; writable: boolean }> = {}
      for (const ref of refs) {
        const state = credentialStore.get(ref)
        credentials[ref] = { configured: state?.configured === true, ...(state?.source === undefined ? {} : { source: state.source }), writable: true }
      }
      // The record rides the value slot directly (no `{credentials}` wrapper).
      return respond(credentials)
    }
    case 'credentials/set': {
      credentialStore.set(String(p['ref']), { configured: true, source: 'file' })
      // `void` value: a successful response omits the value key entirely.
      return respond(undefined)
    }
    case 'credentials/unset': {
      credentialStore.delete(String(p['ref']))
      return respond(undefined)
    }
    case 'agentPresets/list': {
      const defaultId = pathGet(namespaces.get('agent-presets')?.value, ['default'])
      return respond({
        presets: PRESETS.map((preset) => ({ ...preset, isDefault: preset.id === defaultId })),
        authorable: true,
      })
    }
    case 'commands/execute': {
      const line = String(p['line'] ?? '')
      if (line.startsWith('/compact')) {
        return respond({ commandId: 'cmd-compact', result: { kind: 'success', text: 'Compacted' } })
      }
      if (line.startsWith('/plan')) {
        return respond({ commandId: 'cmd-plan', result: { kind: 'success' } })
      }
      // No registered command claimed the line: the composer falls through and
      // submits it as an ordinary prompt.
      return respond(undefined)
    }
    default:
      return Promise.reject(new Error(`mock bridge: unhandled rpc method ${method}`))
  }
}

/** Apply one queue mutation to the mock inbox and re-emit the snapshot. */
function applyQueueAction(sessionId: SessionId, itemId: MessageId, action: QueueAction): boolean {
  const items = queueStore.get(sessionId) ?? []
  const item = items.find((i) => i.id === itemId)
  if (item === undefined) return false
  if (action.kind === 'edit') {
    queueStore.set(sessionId, items.map((i) => (
      i.id === itemId ? { ...i, message: { ...i.message, content: action.content } } : i
    )))
  } else {
    // remove + steer both drop the row (steer is claimed by the running turn).
    queueStore.set(sessionId, items.filter((i) => i.id !== itemId))
  }
  emitQueue(sessionId)
  return true
}

/**
 * Subscribe to the four Remote channels.
 * @param cb - receives one discriminated message per forwarded channel frame.
 * @returns unsubscribe function.
 */
function onEvent(cb: ChannelListener): () => void {
  const first = eventListeners.size === 0
  eventListeners.add(cb)
  // A generation opens with its baselines and only a subscriber can receive
  // them, so the first listener arms the two Host-wide streams.
  if (first) openGenerations()
  return () => eventListeners.delete(cb)
}

/**
 * Subscribe to logically-dead stream reports (the carrier stays up).
 * @param cb - receives the failing scope and the host error.
 * @returns unsubscribe function.
 */
function onStreamError(cb: (failure: StreamFailure) => void): () => void {
  streamErrorListeners.add(cb)
  return () => streamErrorListeners.delete(cb)
}

/**
 * Subscribe to host lifecycle notifications.
 * @param cb - receives the new status on every flip.
 * @returns unsubscribe function.
 */
function onHostStatus(cb: (status: HostStatus) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

/**
 * Subscribe to toolbar commands forwarded by the extension.
 * @param cb - receives the command identifier.
 * @returns unsubscribe function.
 */
function onCommand(cb: (command: 'newChat' | 'openSettings') => void): () => void {
  commandListeners.add(cb)
  return () => commandListeners.delete(cb)
}

/** Mock ide-content subscription (deliveries come via mockEmitIdeContent). */
function onIdeContent(cb: (content: IdeContentPayload) => void): () => void {
  ideContentListeners.add(cb)
  return () => ideContentListeners.delete(cb)
}

/** Mock ide-request: no host side in mock mode, so nothing is emitted. */
function requestIdeContent(_kind: IdeContentKind): void {
  // Intentionally empty: tests use mockEmitIdeContent to simulate the host.
}

/** Mock correlated ide-request: no editor in mock mode, so auto-injection is
 * skipped (the send path treats the error payload as "nothing to inject"). */
function fetchIdeContent(kind: IdeContentKind): Promise<IdeContentPayload> {
  return Promise.resolve({ kind, text: '', error: 'mock: 无编辑器' })
}

/** Last `openFileInIde` target, for tests and e2e assertions. */
export let lastMockOpenFile: { path: string; line?: number } | null = null

/** Mock code jump: records the target and resolves immediately (no editor in
 * mock mode, so the receipt is an unconditional success). */
function openFileInIde(target: { path: string; line?: number; endLine?: number; col?: number; cwd?: string }): Promise<void> {
  lastMockOpenFile = { path: target.path, ...(target.line === undefined ? {} : { line: target.line }) }
  return Promise.resolve()
}

/** Mock approval answer, keyed by the request's own `eventId`. */
function respondApproval(eventId: string, decision: 'allow-once' | 'refuse'): Promise<void> {
  if (pendingScriptedApproval?.eventId !== eventId) {
    return Promise.reject(new Error(`mock bridge: unknown approval ${eventId}`))
  }
  finishDemoStream(decision === 'allow-once')
  return Promise.resolve()
}

/** Mock question answer, keyed by the batch's own `eventId`. */
function respondQuestion(eventId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
  if (pendingScriptedQuestion?.eventId !== eventId) {
    return Promise.reject(new Error(`mock bridge: unknown question ${eventId}`))
  }
  const { sessionId } = pendingScriptedQuestion
  pendingScriptedQuestion = null
  void answers
  turnActive.delete(sessionId)
  emitRemote('request/cancelled', [eventId], 100)
  emitSessionEvent(sessionId, ev('assistant/message', {
    turn: 2,
    step: 2,
    message: {
      id: nextMessageId(),
      role: 'assistant',
      content: [{ type: 'text', text: '好的，按你的选择继续。构建已通过，流程演示结束。' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
    },
    usage: { inputTokens: 900, outputTokens: 48 },
  }), 300)
  // Live control projection: the durable token-usage total absorbs the turn.
  emitControl({
    type: 'projection',
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
  emitSessionEvent(sessionId, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }), 500)
  emitSessionStatus(sessionId, false, 500)
  // The scripted job settles with the turn.
  if (demoJob !== null) {
    const settled: JobView = { ...demoJob, status: 'completed', finishedAt: Date.now() }
    demoJob = null
    emitControl({ type: 'jobs', sessionId, jobs: [settled] }, 600)
  }
  return Promise.resolve()
}

/** Mock port update: mock mode spawns no host, so nothing is persisted. */
export function setPort(_port: number): Promise<void> {
  return Promise.resolve()
}

/**
 * Simulate a host restart: a restart tears down every extension-side
 * subscription, so both Host-wide streams reopen with a fresh generation and
 * the consumer re-follows its journal (the `ready` status does that).
 * @returns resolves once the restart was simulated.
 */
export function restartHost(): Promise<void> {
  openGenerations()
  for (const cb of statusListeners) cb('ready')
  return Promise.resolve()
}

/** Mock host-environment update (see mockEnvFailures for the failure path). */
export function setEnv(_env: Record<string, string>): Promise<void> {
  if (mockEnvFailures.enabled) return Promise.reject(new Error('mock bridge: forced setEnv failure'))
  return Promise.resolve()
}

/** Mock env-changed subscription: the mock never emits an env change. */
export function onEnvChanged(_cb: (env: Record<string, string>) => void): () => void {
  return () => undefined
}

/** Mock port-changed subscription: the mock never emits a port change. */
export function onPortChanged(_cb: (port: number) => void): () => void {
  return () => undefined
}

/** Mock Settings tab opener: mock mode has no extension host to ask. */
export function openSettingsTab(): void {
  // mock no-op
}

/** The assembled mock client, structurally identical to ../api.ts. */
export const mockBridge: BridgeClient = {
  rpc,
  onEvent,
  onHostStatus,
  onCommand,
  waitInit,
  followSession,
  unfollowSession,
  onStreamError,
  respondApproval,
  respondQuestion,
  onIdeContent,
  requestIdeContent,
  fetchIdeContent,
  openFileInIde,
  setPort,
  restartHost,
  onPortChanged,
  setEnv,
  onEnvChanged,
  openSettingsTab,
}
