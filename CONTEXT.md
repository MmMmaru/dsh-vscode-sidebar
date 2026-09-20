# CONTEXT.md — dsh-vscode-sidebar

> 交接文档。只记录源码确认的事实；最近一次全面梳理：0.0.9（2026-08-19）。

## 环境配置

- VS Code 扩展项目（WSL 开发），React + zustand webview + Node 扩展宿主 + 外部 dsh host 进程。
- 构建：`npm run build` = `build:extension`（esbuild → `dist/extension.js`）+ `build:webview`（vite lib 模式 → `media/main.js` + `media/style.css`）。
- 单测：`npm test`（`node esbuild.config.mjs --tests` 打 `.temp/test-dist/*.mjs` 后 `node --test`，**node:test 非 vitest**；组件测试用 react-test-renderer）。
- e2e：`npm run test:e2e`（build:webview + esbuild --e2e + playwright，`workers:1` 串行；需 `LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu`）。架构=真实扩展宿主跑在 Node（vscode 模块 alias 成 stub）+ 真实隔离 dsh host（`DSH_HOME` 临时目录、端口从 3200 起探测）。
- 打包：`npm run package`（vsce）→ VSIX；发布见 `.agents/skills/plugin-publish/SKILL.md`（publisher `XuRongSheng`）。
- **验收规范（AGENTS.md）**：每次验收前先 `code --install-extension dsh-vscode-sidebar-<版本>.vsix --force`，重载窗口生效。
- **红线（AGENTS.md）**：禁止脚本杀掉 3080 端口的 dsh 程序；e2e 只用 3200+ 端口。
- 无 CI（无 `.github/`）。

## 项目架构

```
Webview (React+zustand)  ←postMessage bridge→  Extension Host (Node)  ←HTTP RPC + 双 WS→  dsh web host
```

- **RPC**：webview 发 `rpc` 消息 → `DshClient.rpc()` 透传 `POST /api/<ns>.<method>` → 回 `rpc-result`；审批/提问应答走 `respond` → `POST /api/respond`（webview 看不到 rpcId，扩展侧按 approvalId/sessionId 从 pending 表反查）。
- **事件流**：两条下行 WS——`/api/events.mux`（MuxFrame：session/event、approval/question requested+resolved、queue 快照、projection）与 `/api/events.host`（HostFrame：session 增删/running/agent-error/workspace）。断线指数退避重连。
- **Projection 扇出唯一入口**：store `initialize()`——mux 帧 → `applyMuxFrame`（conversation）/ `applyOverlayFrame` / `applyQueueFrame` / `applyProjectionFrame`（sessions 标题等）；host 帧 → `applyHostFrame`。slice 不自订阅 bridge；mux 帧是否当前会话由各 apply* 自行判定。
- **关键契约**：webview 无 Node 依赖、只经 bridge 通信；`src/extension/protocol/` 是从 deepseek-harness vendored 的纯类型副本（@47f94385，勿手改）；会话按 cwd 跨工作区隔离；VSCode 销毁隐藏的 sidebar webview，OverlayRetention 挂在 Bridge 上（client 级订阅喂入），init 时随 `pendingOverlays` 重放接管态。
- **host 生命周期**：HostManager 从 3080 起扫 10 端口探活（唯一探测端点 `host.describe`，1.5s 超时）；无活 host 则 spawn `dsh web --host 127.0.0.1`；0.0.8 修复：spawn `detached:true` + dispose 杀整个进程组（npx 包装链下 `child.kill()` 只杀壳进程）。
- 详细契约文档：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（bridge 协议消息表、store slice 划分、组件 props；多处"修订"标注，以代码为准）。

## 源码理解

### 当前主要修改文件（0.0.9）

- [src/webview/components/composer/ContextMeter.tsx](src/webview/components/composer/ContextMeter.tsx): 上下文占用环，0.0.9 起可点击——弹出上浮卡片显示完整统计（`statsLineGroups`）+ 上下文组成分解（原 title tooltip 内容移入），外部点击/Esc 关闭，无数据显示「暂无统计数据」。
- [src/webview/components/composer/StatsLine.tsx](src/webview/components/composer/StatsLine.tsx): 0.0.9 起不再是组件，仅余纯 helper——`formatTokens`/`formatDuration`/`formatTokensPerSecond`/`billedInputTokens`/`cacheHitPercent`/`statsLineGroups`（SubagentDock 仍 import `formatDuration`，文件名已名不副实）。
- [src/webview/components/composer/ComposerCard.tsx](src/webview/components/composer/ComposerCard.tsx): composer 唯一装配点；0.0.9 移除常驻 `<StatsLine />`。
- [src/webview/components/composer/composer.css](src/webview/components/composer/composer.css): composer 全部样式；0.0.9 删 `.stats-line`（含 480px 媒体查询）、新增 `.context-meter-pop*` 弹层样式。
- [src/webview/components/conversation/conversation.css](src/webview/components/conversation/conversation.css): 0.0.9 滚动条整改——`.conversation-view` `overflow-x:hidden`；`.conversation-wrap` 单列 `position:relative`；`.segment-rail` 绝对定位覆盖滚动条列（容器 `pointer-events:none` + tick 恢复 auto，padding-right 12px 让开滚动条）；rail 加粗（22px、tick 10×2px 带 `flex:none` 防收缩、opacity 0.4→hover 1）。
- [src/webview/components/chat-list/chat-list.css](src/webview/components/chat-list/chat-list.css): 0.0.9 两项——running 徽标 border 2px；⋯ trigger 改绝对定位+opacity 切换（含 `pointer-events` 防透明态吞点击），删 `.session-row:hover .session-time{display:none}` 改 opacity 淡出保占位，hover 零重排。
- [tests/context-meter-stats.test.tsx](tests/context-meter-stats.test.tsx): 0.0.9 新增——ContextMeter 弹层 5 例（内容/外点/Esc/空数据）。
- [tests/e2e/session-row-hover.spec.ts](tests/e2e/session-row-hover.spec.ts): 0.0.9 新增——HOV-1 hover 前后行盒逐像素相等（注意 Playwright `toBeVisible` 不看 opacity，会假阳性）/ HOV-2 徽标 2px。

### 0.1.5 自定义 host 环境变量（本次新增）

- 语义：VS Code 配置 `dsh.env`（string→string）在 `HostManager.spawn()` 时以 `env: { ...process.env, ...customEnv }` 合并进 host 进程——**posix spawn 传 `env` 会整体替换**，漏了 `...process.env` 就会丢 `PATH` 导致 host 起不来；只作用于**下一次** spawn，运行中的 host 不变（不重启后端）。
- 数据流：设置→通用 `EnvRow` → store `setEnv`（乐观写入+失败回滚）→ bridge `set-env` → `extension/bridge.ts handleSetEnv` 写 `ConfigurationTarget.Global`（整表覆盖，对齐 VS Code `Configuration#update`）→ 回 `env-changed` → store 更新；启动时 `InitPayload.env` 下发（`readConfiguredEnv()`/`normalizeEnv()`）。
- 校验（`normalizeEnv`）：名需匹配 `^[A-Za-z_][A-Za-z0-9_]*$`、值非空字符串，丢弃项计数上报（`N 项无效配置已忽略`）；spawn 日志只打变量**名**（值多为密钥）。
- UI 契约：行增删改就地编辑；名疑似密钥（KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL）默认 `type=password`，眼睛可临时查看（**打码只影响显示，值始终随行携带**）；非法名/重名/空值行标红且 Save 保持禁用，刚添加的空行是占位（`originalName` 必须 `undefined`，否则会被判成「空名已存在行」立刻报错——已修的 bug）；保存提示「重启 host 后生效」。
- 待办关联：这是**手动**注入口子；#7/#25 要的「自动探测系统代理/node 环境」仍未做（见 docs/TODO.md 同条批注）。

### 相关文件

**入口与宿主（src/extension/）**

- [package.json](package.json): 扩展清单（当前 0.0.9）——activitybar 容器 `dsh`、视图 `dsh.sidebar`、5 命令、`dsh.port`/`dsh.keepHostOnExit`/`dsh.env`（0.1.5 自定义 host 环境变量，见上）配置、`dsh.compatibleVersionPrefixes` 兼容前缀。
- [src/extension/extension.ts](src/extension/extension.ts): activate 装配 HostManager/DshClient/Bridge/SidebarProvider + 注册视图与 5 命令；deactivate 按 keepHostOnExit 决定杀不杀本插件 spawn 的 host。
- [src/extension/host-manager.ts](src/extension/host-manager.ts): host 探测/spawn/进程组杀；坑：npm 的 0.1.0-rc.6 自报版本 "0.0.1"，兼容前缀 `['0.1.0-rc.', '0.0.1']`。
- [src/extension/dsh-client.ts](src/extension/dsh-client.ts): HTTP RPC（30s 超时、`RpcBusinessError`）+ 双 WS 事件流 + `/api/respond` 应答 + `emitMuxFrame`/`emitHostFrame` e2e 注入钩子。
- [src/extension/bridge.ts](src/extension/bridge.ts): 消息桥——ready→init（cwd 经 workspace.create 取 host realpath）、rpc 透传、respond 关联应答、ide-request/ide-open-file。
- [src/extension/overlay-retention.ts](src/extension/overlay-retention.ts): 审批/提问 requested 帧的会话级重放缓冲（resolved 帧清除）。
- [src/extension/sidebar-provider.ts](src/extension/sidebar-provider.ts): 视图注册 + `renderHtml`（注入 media/ 固定产物，严格 CSP，full panel 复用）。
- [src/extension/open-file-resolve.ts](src/extension/open-file-resolve.ts) + [src/extension/open-file.ts](src/extension/open-file.ts): 代码跳转路径解析（绝对直用/`~/` 展开/相对按 会话cwd→workspace 顺序取首个存在）与 vscode 侧打开定位。
- [src/extension/protocol/](src/extension/protocol/): 15 个 type-only vendored 文件——rpc.ts 四象限信封、rpc-map.ts 九域方法表、events.ts MuxFrame/HostFrame 联合、session.ts 11 种事件、projections.ts 四投影、tool-views.ts 渲染意图、brand.ts Branded ID 等。

**webview 数据层（src/webview/store/ 等）**

- [src/webview/main.tsx](src/webview/main.tsx): 入口仅挂载 React 根；**坑：`base.css` 必须最先 import**，否则同优先级修饰类被压（0.0.8 未读点不显示的根因）。
- [src/webview/App.tsx](src/webview/App.tsx): 三层壳（ChatListPanel/ConversationView/ComposerCard）+ host-status 横幅 + SettingsPanel 模态；mount 调一次 `initialize()`。
- [src/webview/store/index.ts](src/webview/store/index.ts): 根 store 合并 6 slice + `initialize()` 唯一帧扇出入口 + init 回放 pendingOverlays。
- [src/webview/store/sessions.ts](src/webview/store/sessions.ts): 会话列表 CRUD；**无真删除，`deleteSession` 走 `workspace.archiveSession`**；跨工作区按 cwd 过滤；running→idle 置 unread。
- [src/webview/store/conversation.ts](src/webview/store/conversation.ts): mux 帧投影成 `ConversationNode[]` + 四项持久投影（sessionStats/tokenUsage/contextPressure/contextBreakdown）+ todos/jobs/subagents；坑：loadHistory 防会话切换后过期页覆盖。
- [src/webview/store/composer.ts](src/webview/store/composer.ts): 发送/打断/队列/模型选择/权限/IDE 注入开关；坑：无会话时 selectModel 暂存 pendingModelSelection；slash 命令不注入 IDE 上下文。
- [src/webview/store/overlay.ts](src/webview/store/overlay.ts): 接管状态按会话存 `overlayBySession`，活跃会话派生 pending*；approval 按 approvalId、question 按 sessionId 应答。
- [src/webview/store/settings.ts](src/webview/store/settings.ts): 设置读写 + UiPrefs（settings 命名空间优先、localStorage 兜底）；密钥只写不回读；`full-access` 线上映射 `danger-full-access`。
- [src/webview/store/goal.ts](src/webview/store/goal.ts): goal 投影（undefined=无能力/null=已清除）+ CAS 变更，状态只信投影帧。
- [src/webview/bridge.ts](src/webview/bridge.ts) / [api.ts](src/webview/api.ts) / [mock/bridge.ts](src/webview/mock/bridge.ts): 门面按 `?mock`/`VITE_DSH_MOCK` 选真假实现；mock 含测试钩子（mockRpcFailures/mockHistoryOverrides 等）。
- [src/webview/types.ts](src/webview/types.ts): UI 视图模型（ConversationNode 判别联合等），派生自 vendored 协议类型。

**chat-list（会话列表）**

- [src/webview/components/chat-list/ChatListPanel.tsx](src/webview/components/chat-list/ChatListPanel.tsx): "Chats" 区——`StatusIndicator`（waiting 琥珀>running 转圈>unread 绿点>idle null）+ `SessionRow`（重命名/分叉/删除，删除走 ConfirmModal——webview 无 window.confirm）+ 历史下拉（搜索 250ms 防抖）；常驻最近列表仅 `activeSessionId===null` 时渲染。
- 坑：`.region-chat-list.chat-list` 双类名压过 base.css 的 overflow 裁剪，勿简化；`.status-dot` 修饰类靠导入顺序获胜。

**conversation（消息流）**

- [src/webview/components/conversation/ConversationView.tsx](src/webview/components/conversation/ConversationView.tsx): 滚动容器——底部跟随（24px 阈值钉住）+ 回到底部按钮 + Load older 分页（prepend 后 scrollHeight 差恢复位置）+ NodeView 按 kind 分发。
- [src/webview/components/conversation/SegmentRail.tsx](src/webview/components/conversation/SegmentRail.tsx): 右侧概览 rail（0.0.8 重做为概览模式、0.0.9 加粗+同列覆盖）——N 条用户消息聚成垂直居中 tick 簇（min(N×10,120)px，**非滚动映射**），hover 出 `previewText` 10 码点预览（Array.from 保 emoji），点击跳转；坑：selector 必须取原始 nodes 再 useMemo 过滤，否则 React #185。
- [src/webview/components/conversation/MarkdownBlock.tsx](src/webview/components/conversation/MarkdownBlock.tsx): streaming 纯文本快路径、落定 react-markdown+gfm；代码跳转（TODO 5）：`splitFileRefs` 扫 `path:line` 渲染可点 chip。
- [MessageBubble.tsx](src/webview/components/conversation/MessageBubble.tsx) / [ToolCallRow.tsx](src/webview/components/conversation/ToolCallRow.tsx) / [ToolCard.tsx](src/webview/components/conversation/ToolCard.tsx)（含零依赖 LCS diff）/ [ReasoningRow.tsx](src/webview/components/conversation/ReasoningRow.tsx) / [TurnStatusLine.tsx](src/webview/components/conversation/TurnStatusLine.tsx): 气泡/工具折叠行/工具详情卡/Think 折叠行/turn 状态行。

**composer（输入区）**

- [ComposerInput.tsx](src/webview/components/composer/ComposerInput.tsx): 自动增高 textarea——Enter 发送/Shift+Enter 换行/IME 保护/长按不连发；`/` 斜杠建议（内置命令+skill.list 目录）、`@` 文件引用（**静态 mock，session-file RPC 尚不存在**）。
- [QueueDock.tsx](src/webview/components/composer/QueueDock.tsx) / [SubagentDock.tsx](src/webview/components/composer/SubagentDock.tsx) / [TodoPanel.tsx](src/webview/components/composer/TodoPanel.tsx) / [GoalBar.tsx](src/webview/components/composer/GoalBar.tsx): 卡片上方悬浮条——排队消息（行内编辑/Steer 插话）/ 子代理+后台任务 / todo 清单 / goal 条。
- [ModelSelect.tsx](src/webview/components/composer/ModelSelect.tsx) / [PermissionSelect.tsx](src/webview/components/composer/PermissionSelect.tsx) / [SendStopButton.tsx](src/webview/components/composer/SendStopButton.tsx) / [AttachmentRail.tsx](src/webview/components/composer/AttachmentRail.tsx): 模型两级菜单 / 权限 chip（Full access 有确认框）/ 发送-停止按钮 / 图片附件条。
- 窄宽度机制：工具栏控件标 `data-composer-tool`，media query 按优先级逐级隐藏（permission≤460 → model≤360 → meter≤320 → ide≤280 → attach≤240），发送键与输入框永不隐藏。

**overlay（接管面板）**

- [src/webview/components/overlay/OverlayHost.tsx](src/webview/components/overlay/OverlayHost.tsx): 优先级路由 approval > plan review > question，同时只渲染一个；key=请求标识防 busy 锁泄漏。
- [ApprovalPanel.tsx](src/webview/components/overlay/ApprovalPanel.tsx) / [QuestionPanel.tsx](src/webview/components/overlay/QuestionPanel.tsx)（推荐 badge 剥离、分页、IME 检测）/ [PlanReviewPanel.tsx](src/webview/components/overlay/PlanReviewPanel.tsx)（Chat 与 Refuse 同为 decline 语义）。
- [overlay.css](src/webview/components/overlay/overlay.css): `ovl-*` 全套；`.ovl-mask` 纯视觉 `pointer-events:none`；入场动画 `ovl-enter` 定义在 base.css。

**settings / common / 全局样式**

- [src/webview/components/settings/SettingsPanel.tsx](src/webview/components/settings/SettingsPanel.tsx) + GeneralSection/ModelsSection/ProviderEditorCard/CustomProviderCard/PluginsSection/PresetsSection: 设置弹窗（左导航 + 内容列；PluginsSection 编辑能力 W6 遗留未做）；[SettingsPage.tsx](src/webview/components/settings/SettingsPage.tsx) 是 0.1.4 起在编辑器标签页里复用的整页外壳（`__DSH_VIEW_MODE__==='settings'`），GeneralSection 内的 `EnvRow` 即 0.1.5 环境变量编辑器。
- [src/webview/components/common/ConfirmModal.tsx](src/webview/components/common/ConfirmModal.tsx): 破坏性操作确认框（0.0.8 从 settings 提升共用）；类名仍 `settings-confirm*`，样式在 settings.css 全局生效。
- [src/webview/styles/base.css](src/webview/styles/base.css): 全局 token（0.0.8 新增 `--dsh-radius-lg`/`--dsh-border-soft`/`--dsh-shadow-card` + `@keyframes ovl-enter`）+ 三层 shell 布局 + `.status-dot` 基类。

**测试（tests/）**

- 单测：composer-input / dsh-client / file-refs / goal / host-manager / overlay-retention / respond-mapping / todo-fixes / segment-rail / status-indicator / context-meter-stats + [fake-host.ts](tests/fake-host.ts)（进程内假 host）。
- e2e：[harness.ts](tests/e2e/harness.ts)（真实扩展宿主 + 隔离 host，DSH_HOME 必须手动 mkdir `storages`；`startHarness({config})` 预置桩配置、`harness.configuration()` 回读）+ [page-adapter.js](tests/e2e/page-adapter.js)（页面侧 `acquireVsCodeApi` 适配器，端口/视图模式经 `<body data-ws-port|data-view-mode>` 传入）+ e2e/switch-repro/goal/composer-commands/code-jump-segments/overlay-style/session-delete/session-row-hover/env-setting spec。
- e2e 四大坑（详见 `.agents/skills/dsh-vscode-e2e/SKILL.md`）：① 注入提问必须同 rpcId 补发 `question/resolved` 清 retention，否则下用例连锁失败；② 改产品代码必须重跑 build:webview（页面加载构建产物），改 harness/stub 必须重跑 esbuild --e2e；③ 用例共享一个 worker/host，计数断言用相对值、会话标题用唯一前缀；④ 页面适配器必须是独立文件 `tests/e2e/page-adapter.js`——内联 `<script>` 版本在本机 Chromium 下从未执行（现象：`acquireVsCodeApi` 未注入、页面回退 mock bridge、真实 RPC 用例全超时）。

**工程化**

- [esbuild.config.mjs](esbuild.config.mjs): 四目标（默认/--watch/--tests/--e2e）。
- 文档惯例：CHANGELOG（与 package.json 版本严格一致）/ docs/TODO.md（编号全局唯一，分待办与已完成按版本）/ PROGRESS.md（`### MM-DD hh:mm` 追加）。
- 版本脉络：0.0.1 首发 → 0.0.2 接管面板视觉 → 0.0.3 IDE 注入+工作区隔离+E2E 体系 → 0.0.4 Goal条/斜杠/Esc/窄宽度 → 0.0.6 断点重标定 → 0.0.7 代码跳转+SegmentRail → 0.0.8 弹窗美化/状态指示器/删除修复/rail 概览化 → 0.0.9 统计并入上下文弹层/滚动条同列/rail 加粗/徽标加粗/hover 零重排 → 0.1.x 设置独立标签页/斜杠命令真实执行/长文本附件 → 0.1.5 自定义 host 环境变量（设置→通用）+ e2e 页面适配器改独立文件。
