# 实施大纲：并行任务拆分

依据 `docs/PRD.md` 与 `docs/ARCHITECTURE.md`。目标：尽可能多的任务并行推进。
每个任务给出：产物、依赖、验收标准。任务之间通过**接口契约**（bridge 协议、store 接口、组件 props）解耦——契约已冻结在 ARCHITECTURE.md 第 3/4/5 节，并行开发时不得擅自改契约，改契约必须先改 ARCHITECTURE.md 并同步所有任务。

## 0. 依赖关系总览

```
W0 脚手架（串行，先行）
 └─ W1 宿主侧三连（host-manager / dsh-client / bridge）
     ├─ W2 会话列表 UI          ─┐
     ├─ W3 对话区 UI（消息渲染）  ─┤
     ├─ W4 输入区 UI（composer）  ─┼─ 全部并行（靠 mock 数据驱动）
     ├─ W5 接管面板（审批/提问/Plan）┤
     └─ W6 设置页               ─┘
           └─ W7 集成联调 + VSIX 打包（串行，收尾）
```

- W0、W1 完成后，W2–W6 五个工作流**同时并行**，各自用 mock bridge 数据开发，互不等待。
- W7 等 W2–W6 全部完成后开始。

## W0 脚手架（前置，串行）

**产物**：可运行的空壳插件——侧边栏显示 "hello"，webview 与宿主桥打通。

- 初始化 `package.json`（扩展清单：contributes.viewsContainers / views / commands）、tsconfig、esbuild（宿主侧）+ Vite（webview 侧）双构建脚本
- `extension.ts` + `sidebar-provider.ts` 骨架：注册视图，加载 `media/` 产物
- `bridge.ts` + `api.ts` 骨架：`ready` → `init` 握手跑通
- `src/extension/protocol/`：从 deepseek-harness 拷贝 `rpc-map.ts`、`events.ts` 及依赖类型，标注来源 commit

**验收**：`F5` 调试启动 VSCode，侧边栏出现 dsh 面板，webview 收到 `init` 消息并显示 cwd。

## W1 宿主侧三连（前置，串行，1 个任务包）

**产物**：真实可用的 dsh 连接层。

- `host-manager.ts`：probe / spawn / checkVersion / dispose（按 ARCHITECTURE 4.2 签名）
- `dsh-client.ts`：connect / rpc / onMuxEvent / onHostEvent / resolveApproval / answerQuestion / dispose，WS 断线指数退避重连
- `bridge.ts`：完整消息分发（rpc 透传、事件透传、host-status）
- 单元测试：host-manager 的端口顺延逻辑、client 的 rpc 配对与重连

**验收**：对真实 `dsh web` 实例完成 `session.list` RPC 调用并收到 mux 事件；杀掉 host 后 webview 收到 `host-status: down`。

## W2 会话列表 UI（并行）

**产物**：`components/chat-list/` 全部组件 + store 的 sessions 切片。

- ChatListPanel / ChatListHeader / SessionRow / SessionSearch
- 状态点优先级（等待审批 > 运行中 > 已完成）、相对时间、View all、hover 菜单（重命名/删除/Fork）
- store：`selectSession / newChat / renameSession / deleteSession / forkSession`，cwd 过滤
- mock：构造 30 条会话的 fake bridge

**验收**：按 PRD 3.1；mock 数据下全部交互可用；状态点颜色符合优先级规则。

## W3 对话区 UI（并行）

**产物**：`components/conversation/` 全部组件 + 事件投影器 `applyMuxFrame`。

- MessageBubble / MarkdownBlock（流式两阶段渲染）/ ReasoningRow / ToolCallRow / ToolCard（terminal/diff/read/search/web/generic 六型）/ TurnStatusLine / EmptyHero
- 滚动行为：贴底跟随、上翻解除、回到底部按钮、Load older
- 事件投影器：把 dsh `session/event` 流折叠成 `ConversationNode[]`（纯函数，重单测）
- mock：从 deepseek-harness `apps/web/tests/` 的种子 session.jsonl 提取真实事件序列做回放

**验收**：按 PRD 3.2 消息流渲染节；用真实 session 事件回放，渲染结构与 dsh 网页版快照一致（对照 `apps/web/tests/snapshots/seeded-history`）。

## W4 输入区 UI（并行）

**产物**：`components/composer/` 全部组件。

- ComposerCard / ComposerInput（Enter/Shift+Enter、`/` 技能建议、`@` 引用）/ AttachmentRail（拖拽+粘贴）/ PermissionSelect（Full access 风险确认框）/ ModelSelect（两级菜单）/ ContextMeter / SendStopButton / QueueDock / TodoPanel / GoalBar / StatsLine
- store：`sendPrompt / cancel / selectModel` 与队列操作

**验收**：按 PRD 3.3；键盘行为逐项符合；mock 下权限切换、模型两级菜单、队列编辑/插话可用。

## W5 接管面板（并行）

**产物**：ApprovalPanel / QuestionPanel / PlanReviewPanel + 接管机制。

- ComposerCard 的 overlay 机制：pendingApproval / pendingQuestion / plan review 任一存在时替换输入区
- 审批：理由 + 命令展示 + Refuse / Allow once，点击后禁用等 resolved 帧
- 提问：单选/多选/自定义输入、多题分页、Skip/Submit
- Plan 评审：Markdown 计划 + 三按钮
- store：`resolveApproval / answerQuestion`

**验收**：按 PRD 3.2 审批与提问节；mock 三种接管场景，应答后输入栏恢复。

## W6 设置页（并行）

**产物**：`components/settings/` 全部组件 + store 的 settings 切片。

- SettingsPanel（模态 + 左导航）/ GeneralSection / ModelsSection（provider CRUD + 凭证编辑）/ PluginsSection / PresetsSection
- 对接 RPC：`settings.*`、`credentials.*`、`llm.providers`

**验收**：按 PRD 3.4；改 API key 后真实写入 harness 凭据存储并可被会话使用。

## W7 集成联调 + 打包（收尾，串行）

- 撤掉所有 mock，webview 全量接真实 bridge
- 端到端用例：新建对话 → 发消息 → 工具渲染 → 审批应答 → 中断 → 恢复历史会话 → 改模型 → 改设置
- host 拉起/掉线/版本不匹配三种边界
- `vsce package` 出 VSIX，本地安装验证
- 更新 README（安装与使用说明）

**验收**：在真实 dsh 上跑通 PRD 的 P0 全清单；VSIX 安装即用。

## 执行方式

- 每个 W 任务包派一个开发子代理，在独立 git worktree 中开发（参照 using-git-worktrees 流程），完成后验收再合并。
- 并行期任何契约变更（bridge 消息、store 接口、组件 props）必须先改 ARCHITECTURE.md 并广播给所有在途任务。
- P0 范围 = W0/W1/W2/W3/W4/W5 的核心部分 + W7；P1/P2 项（设置页深化、Goal/Todo/Trajectory 等）按 PRD 第 7 节分期插入后续迭代。
