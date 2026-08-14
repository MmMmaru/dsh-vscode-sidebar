# 架构设计：VSCode DeepSeek Harness Sidebar 插件

本文档定义插件的模块划分与关键函数的输入输出。需求见 `docs/PRD.md`。
审批通过后按 `docs/PLAN.md` 并行实施。

## 1. 总体架构

```
┌───────────────────────── VSCode ─────────────────────────┐
│  Webview (React 前端)                                     │
│    ChatList / Conversation / Composer / Settings          │
│        ↑↓ postMessage (bridge 协议)                       │
│  Extension Host (Node)                                    │
│    extension.ts → bridge.ts → dsh-client.ts               │
│                              → host-manager.ts            │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP RPC: POST /api/<ns>.<method>
                            │ WebSocket: /api/events.mux, /api/events.host
                            ▼
                    dsh web Host (127.0.0.1:<port>)
                    （无实例时由插件自动 spawn）
```

三条设计原则：

1. **后端零重写**：所有业务能力（会话/模型/审批/设置）都通过 dsh Web Host 接口获得。
2. **协议类型 vendored**：从 `deepseek-harness/packages/host/apiproxy/src/api/` 拷贝纯 TS 类型（`rpc-map.ts`、`events.ts` 及相关 schema 类型）到 `src/extension/protocol/`，dsh 升级时重新拷贝对齐。
3. **Webview 无 Node 依赖**：webview 只能通过 bridge 与扩展宿主通信，不直接发 HTTP/WS。

## 2. 目录结构

```
dsh-vscode-sidebar/
├── docs/                         # PRD / 架构 / 大纲
├── package.json                  # VSCode 扩展清单
├── src/
│   ├── extension/                # 扩展宿主侧（Node）
│   │   ├── extension.ts          # 入口：激活、注册 provider 与命令
│   │   ├── host-manager.ts       # dsh host 发现/拉起/健康检查
│   │   ├── dsh-client.ts         # RPC + WS 客户端
│   │   ├── bridge.ts             # webview ↔ host 消息桥
│   │   ├── sidebar-provider.ts   # WebviewViewProvider
│   │   └── protocol/             # vendored 协议类型（只读，勿手改）
│   └── webview/                  # 侧边栏 React 应用
│       ├── main.tsx / App.tsx    # 入口 + 三层布局壳（host-status 横幅 + 设置模态挂载点）
│       ├── api.ts                # 真实 bridge 客户端封装（BridgeClient 接口定义处）
│       ├── bridge.ts             # 门面：按开关选 api.ts 或 mock/bridge.ts
│       ├── mock/bridge.ts        # mock bridge（W2-W6 并行开发的假数据源）
│       ├── store/                # zustand slice 模式：index.ts 合并 + 每工作流一个 slice
│       ├── types.ts              # UI 层视图模型
│       ├── components/
│       │   ├── chat-list/        # 上层栏：会话列表
│       │   ├── conversation/     # 中间层：消息流、审批/提问接管
│       │   ├── composer/         # 下层栏：输入区
│       │   └── settings/         # 设置面板
│       └── styles/               # base.css 壳布局 + 设计 token，消费 --vscode-* 主题变量
├── resources/                    # 图标
└── media/                        # webview 构建产物（vite 输出）
```

## 3. Bridge 协议（扩展宿主 ↔ Webview）

所有消息为 JSON，经 `vscode.postMessage` / `onDidReceiveMessage` 传递。

Webview → Extension：

| type | 载荷 | 说明 |
|---|---|---|
| `ready` | — | webview 挂载完成，请求初始化 |
| `rpc` | `{ id: string, method: string, params?: unknown }` | 透传 dsh RPC，method 如 `session.list` |
| `respond` | `{ kind: 'approval', approvalId, decision }` 或 `{ kind: 'question', sessionId, answers }` | 应答 approval/question 请求帧（修订 2 新增）。请求帧是 server-request，应答须 POST /api/respond 并回显帧的 rpcId；但 MuxFrame 不带 rpcId，webview 用 `approvalId`/`sessionId` 关联，由扩展侧从 DshClient 的 pending 表反查 rpcId。**扩展侧分发（Bridge.handleMessage + DshClient 按 approvalId/sessionId 反查）尚未实现，是 W5/W7 的前置任务。** |

Extension → Webview：

| type | 载荷 | 说明 |
|---|---|---|
| `init` | `{ cwd: string, hostVersion: string, sessions: SessionMeta[] }` | 初始化数据 |
| `rpc-result` | `{ id: string, result?: unknown, error?: string }` | RPC 应答 |
| `event` | `{ channel: 'mux' \| 'host', frame: MuxFrame \| HostFrame }` | dsh 事件流透传 |
| `host-status` | `{ status: 'starting' \| 'ready' \| 'down' }` | host 生命周期通知 |
| `command` | `{ command: 'newChat' \| 'openSettings' }` | 工具栏命令转发（W1 新增；store 侧决定行为） |

## 4. 扩展宿主侧模块

### 4.1 `extension.ts` — 入口

```ts
function activate(context: vscode.ExtensionContext): void
```
功能：实例化 HostManager / DshClient / Bridge，注册 SidebarProvider 与命令（`dsh.newChat`、`dsh.openSettings`、`dsh.openFullPanel`）。

```ts
function deactivate(): void
```
功能：断开 WS；若 host 由本插件拉起则按配置决定是否保留。

### 4.2 `host-manager.ts` — dsh host 生命周期

```ts
class HostManager {
  constructor(log: vscode.OutputChannel)

  /** 确保 host 可用：先探测，探测失败则 spawn。返回连接信息。 */
  async ensureHost(): Promise<HostInfo>   // HostInfo = { port: number, pid?: number, spawnedByUs: boolean }

  /** 探测本机候选端口上的 dsh host（GET /api/host.info 类健康检查）。 */
  async probe(port: number): Promise<boolean>

  /** spawn `dsh web --host 127.0.0.1 --port <port>`，等待就绪。 */
  async spawn(port: number): Promise<HostInfo>

  /** 读取 host 版本，与插件声明的兼容范围比较；不匹配返回告警文案。 */
  async checkVersion(info: HostInfo): Promise<string | null>

  async dispose(): Promise<void>
}
```
端口策略：默认 3080，被占用则顺延探测；只连 loopback。

### 4.3 `dsh-client.ts` — RPC + 事件流客户端

```ts
class DshClient {
  constructor()

  /** 建立两条 WS 连接（mux + host），失败重试（指数退避）。 */
  async connect(info: HostInfo): Promise<void>

  /** 发起 RPC：POST /api/<method>，返回 result 或抛错。 */
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T>

  /** 订阅事件。返回取消订阅函数。 */
  onMuxEvent(cb: (frame: MuxFrame) => void): () => void
  onHostEvent(cb: (frame: HostFrame) => void): () => void

  /** 应答审批请求（approval/requested 帧的回应）。 */
  async resolveApproval(requestId: string, decision: 'allow-once' | 'refuse'): Promise<void>

  /** 应答 ask-user 提问。 */
  async answerQuestion(requestId: string, answers: QuestionAnswer[]): Promise<void>

  async dispose(): Promise<void>
}
```
消费的 RPC 方法面（v1）：`session.list / search / create / history / models / selectModel / rename / fork / prompt / attachment / updateQueue / cancel`、`goal.*`、`settings.*`、`credentials.*`、`llm.providers / models`、`skill.list`。

### 4.4 `bridge.ts` — 消息桥

```ts
class Bridge {
  constructor(client: DshClient, host: HostManager)

  /** 绑定一个 webview，接线消息分发。返回 Disposable。 */
  attach(webview: vscode.Webview): vscode.Disposable
}
```
功能：`ready` → 回 `init`；`rpc` → 调 `client.rpc` 后回 `rpc-result`；client 事件 → 推 `event`；host 状态变化 → 推 `host-status`。webview 销毁时清理订阅。

### 4.5 `sidebar-provider.ts` — 视图注册

```ts
class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(context: vscode.ExtensionContext, bridge: Bridge)

  /** VSCode 回调：配置 webview（CSP、本地资源根），注入 media/ 下的构建产物。 */
  resolveWebviewView(view: vscode.WebviewView): void
}
```

## 5. Webview 侧模块

### 5.1 `api.ts` — bridge 客户端

```ts
/** 发起 RPC，内部生成 id 并挂起 Promise，等 rpc-result 配对。 */
function rpc<T = unknown>(method: string, params?: unknown): Promise<T>

/** 订阅事件流 / host 状态。返回取消函数。 */
function onEvent(cb: (channel: 'mux' | 'host', frame: unknown) => void): () => void
function onHostStatus(cb: (s: 'starting' | 'ready' | 'down') => void): () => void

/** 等待 init 消息，返回初始化数据。 */
function waitInit(): Promise<InitPayload>

/** 应答审批 / 提问（经 §3 的 respond 消息；修订 2 新增）。 */
function respondApproval(approvalId: ApprovalRequestId, decision: 'allow-once' | 'refuse'): Promise<void>
function respondQuestion(sessionId: SessionId, answers: AskUserQuestionAnswerItem[]): Promise<void>
```

以上函数签名聚合为 `BridgeClient` 接口。`bridge.ts` 是门面：按开关（URL query `?mock`、构建常量 `VITE_DSH_MOCK=1` 或 `globalThis.__DSH_MOCK__`）选择真实实现（api.ts）或 `mock/bridge.ts`（30 条假会话 + 演示会话脚本化事件流 + 模型目录）；**store 与组件只 import 门面**。

### 5.2 `store/` — 状态管理（zustand，slice 模式）

每个工作流一个 slice 文件（sessions/conversation/composer/overlay/settings），互不越界写别人的字段；`store/index.ts` 合并 slice 并持有根状态（cwd / hostVersion / hostStatus / initialized）与 `initialize()`。事件路由只在 `initialize()` 一处扇出：mux 帧依次投递给 `applyMuxFrame`（W3 会话投影）/ `applyOverlayFrame`（W5 审批提问）/ `applyQueueFrame`（W4 队列）/ `applyProjectionFrame`（W2 标题投影），host 帧投递给 `applyHostFrame`（W2）；slice 自己不订阅 bridge。

```ts
interface AppStore extends RootSlice, SessionsSlice, ConversationSlice, ComposerSlice, OverlaySlice, SettingsSlice {
  // RootSlice（骨架所有）: cwd, hostVersion, hostStatus, initialized, initialize()
  // SessionsSlice（W2）: sessions, activeSessionId, initSessions, selectSession,
  //   newChat, renameSession, deleteSession, forkSession, applyHostFrame, applyProjectionFrame
  // ConversationSlice（W3）: nodes, hasMoreHistory, turnStatus, turnStartedAt,
  //   todos, stats, loadHistory, applyMuxFrame, appendError, clearConversation
  // ComposerSlice（W4）: queue, models, selectedModel, permissionMode,
  //   sendPrompt, cancel, selectModel, setPermissionMode, loadModels, updateQueueItem, applyQueueFrame
  // OverlaySlice（W5）: pendingApproval, pendingQuestion, planReview,
  //   applyOverlayFrame, resolveApproval, answerQuestion, clearOverlay
  // SettingsSlice（W6）: settingsOpen, namespaces, providers, settingsWritable,
  //   openSettings, closeSettings, loadSettings, updateSettings, setCredential, unsetCredential
}
```

关键签名（与初版表述的差异，以代码为准）：

```ts
selectSession(id: SessionId): Promise<void>          // 拉 history + models；mux 订阅在宿主侧常驻
sendPrompt(text: string, attachments: Attachment[]): Promise<void>
forkSession(id: SessionId, atSeq?: number): Promise<void>   // 协议为 session.fork atSeq（原 messageId 表述更正）
deleteSession(id: SessionId): Promise<void>                 // RPC 面无 delete；经 workspace.archiveSession 实现
selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void>  // 协议需要 provider
cancel(): Promise<void>
resolveApproval(decision: 'allow-once' | 'refuse'): Promise<void>
answerQuestion(answers: AskUserQuestionAnswerItem[]): Promise<void>
```
事件投影器：`applyMuxFrame(frame: MuxFrame): void`（ConversationSlice）—— 把 `session/event` 帧折叠进 `nodes` / `todos` / `stats`（这是 webview 侧最核心的投影函数，单测重点）。`planReview` 由 `pendingQuestion` 中携带 `intent.kind='plan-review'` 的问题派生，批准即回 `approve` 选项标签。

### 5.3 组件划分（props 即输入，无返回值，渲染即输出）

**chat-list/（上层栏）**

| 组件 | Props | 功能 |
|---|---|---|
| `ChatListPanel` | — | 容器：标题栏 + 列表 + View all |
| `ChatListHeader` | `{ onHistory, onSettings, onNewChat }` | 三个图标按钮 |
| `SessionRow` | `{ session: SessionMeta, active: boolean, onSelect, onRename, onDelete, onFork }` | 状态点 + 标题 + 相对时间 + hover 菜单 |
| `SessionSearch` | `{ onSearch(q: string) }` | 防抖搜索框 |

**conversation/（中间层）**

| 组件 | Props | 功能 |
|---|---|---|
| `ConversationView` | `{ sessionId: string }` | 消息流容器：贴底跟随、Load older、回到底部按钮 |
| `MessageBubble` | `{ node: UserMessageNode }` | 用户气泡 + 复制 + 时间戳 |
| `MarkdownBlock` | `{ text: string, streaming: boolean }` | assistant Markdown；流式期代码/公式按纯文本，settle 后完整渲染 |
| `ReasoningRow` | `{ node: ReasoningNode }` | Think 折叠行，流式摘要跟随末尾 |
| `ToolCallRow` | `{ node: ToolCallNode }` | 单行折叠工具行；展开按 kind 出卡片 |
| `ToolCard` | `{ kind: 'terminal' \| 'diff' \| 'read' \| 'search' \| 'web' \| 'generic', payload: ToolPayload }` | 工具详情卡片（限高内滚） |
| `ApprovalPanel` | `{ request: ApprovalRequest, onResolve }` | 接管 composer：Refuse / Allow once |
| `QuestionPanel` | `{ request: QuestionRequest, onAnswer }` | 接管 composer：选项 + 分页 + Skip/Submit |
| `PlanReviewPanel` | `{ plan: string, onApprove, onRefuse, onChat }` | 接管 composer：计划评审 |
| `TurnStatusLine` | `{ startedAt: number }` | "Deep diving..." + 超 15s 显示时长 |
| `EmptyHero` | `{ onNewChat }` | 空态（按截图中央占位图形） |

**composer/（下层栏）**

| 组件 | Props | 功能 |
|---|---|---|
| `ComposerCard` | — | 圆角卡片容器；pending 时被接管面板替换 |
| `ComposerInput` | `{ value, onChange, onSend, running }` | 多行自适应 textarea，Enter/Shift+Enter，`/` 与 `@` 触发建议 |
| `AttachmentRail` | `{ items: Attachment[], onRemove(id) }` | 缩略图 rail（拖拽/粘贴入口在此） |
| `PermissionSelect` | `{ value: PermissionMode, onChange }` | Read Only / Workspace Write / Full access（后者弹风险确认） |
| `ModelSelect` | `{ models, selected, onSelect(model, effort) }` | 两级菜单：模型（按 provider 分组）+ effort 档 |
| `ContextMeter` | `{ usedPct: number }` | 上下文用量环 + tooltip |
| `SendStopButton` | `{ running, canSend, onSend, onStop }` | 主按钮发送/停止翻转 |
| `QueueDock` | `{ queue, onEdit, onRemove, onSteer }` | 排队消息列表 |
| `TodoPanel` | `{ todos: TodoItem[] }` | todo 清单（输入框上方） |
| `GoalBar` | `{ goal: GoalState, onPause, onEdit, onClear }` | 目标状态条 |
| `StatsLine` | `{ stats: TurnStats }` | 输入卡下方统计小字 |

**settings/（设置面板）**

| 组件 | Props | 功能 |
|---|---|---|
| `SettingsPanel` | `{ onClose }` | 模态容器 + 左侧导航 |
| `GeneralSection` | — | 语言 / 外观 / Enter 行为 / 默认权限 / Agent 预设 |
| `ModelsSection` | — | provider 列表 + 编辑卡（API key、base URL）+ 增删 |
| `PluginsSection` | — | 可配置插件 + 插件清单 |
| `PresetsSection` | — | Agent 预设管理 |

### 5.4 `types.ts` — 视图模型

由协议事件投影而来的 UI 层类型：`ConversationNode`（discriminated union，判别字段为 `kind`：`user-message / assistant-text / reasoning / tool-call / context-injection / compaction / retry / error`，其中 compaction/retry 为 W3 预留节点种类）、`SessionMeta`（桥契约复用 `src/shared/bridge.ts`）、`ApprovalRequest`、`QuestionRequest`、`PlanReviewState`（由 plan-review 提问派生）、`QueuedMessage`、`TodoItem`、`GoalState`、`TurnStats`、`ModelInfo`（provider 分组扁平化）、`Attachment`、`PermissionMode`（UI 自有概念）。协议概念全部从 vendored 类型派生，不自定义后端概念。

## 6. 构建与打包

- 扩展宿主：esbuild 打包 `src/extension` → `dist/extension.js`
- webview：Vite 构建 `src/webview` → `media/`（单 html + js + css，CSP 只允许自身）
- `vsce package` 产出 VSIX，本地安装
- 主题：CSS 变量优先消费 `--vscode-*`，保证与 VSCode 主题一致；组件结构对齐 dsh 网页版设计

## 7. 版本兼容策略

- `package.json` 声明兼容的 dsh 版本范围
- 启动时 `checkVersion` 比对，不匹配弹告警（不阻断，提示升级 dsh）
- `src/extension/protocol/` 内文件标注来源 commit，升级 dsh 时重新拷贝
