# PROGRESS

### 08-15 03:40
- Webview 契约骨架（W2-W6 并行基座）完成：`types.ts` 视图模型全集（ConversationNode 八种 kind + SessionMeta/ApprovalRequest/QuestionRequest/PlanReviewState/QueuedMessage/ModelInfo/Attachment/GoalState/TurnStats/PermissionMode）、`mock/bridge.ts`（30 条假会话 + demo 会话脚本化事件流：历史含 reasoning/tool-call/todo，prompt 触发 文本→tool/call→审批→提问→收尾）、`bridge.ts` 门面（`?mock` / `VITE_DSH_MOCK=1` / `globalThis.__DSH_MOCK__` 三开关）、zustand slice 模式 store（index + sessions/conversation/composer/overlay/settings 六文件）、App.tsx 三层布局壳 + host-status 横幅 + SettingsPanel 模态、四个占位组件（props 契约按 ARCHITECTURE 5.3）、styles/base.css（三层高度分配 + --vscode-* token）。
- 契约修订（已同步 ARCHITECTURE.md）：①§3 新增 `respond` 消息（approval/question 应答；MuxFrame 不带 rpcId，webview 用 approvalId/sessionId 关联，**扩展侧 dispatch 未实现，W5/W7 前置**）；②§5.2 改 slice 模式、事件路由集中在 initialize() 扇出；③forkSession 参数 messageId→atSeq、deleteSession 经 workspace.archiveSession、selectModel 补 provider。
- api.ts 改动：acquireVsCodeApi/window 监听加守卫（mock/node 环境安全）、新增 BridgeClient 接口与 respondApproval/respondQuestion。
- 验证：typecheck 双 tsconfig 零错误；npm run build 全绿；新增 `npm run verify:mock`（.temp/verify-mock.tsx，node 直跑 store+mock 全链路断言 + SSR 壳渲染）通过。注意：zustand v5 SSR 快照走 getInitialState()，SSR 只验结构，数据断言在 store 层。

### 08-15 02:30
- W0+W1 完成：VSCode 扩展脚手架（esbuild 宿主侧 + Vite webview 侧）、vendored 协议类型（deepseek-harness commit 47f9438）、HostManager/DshClient/Bridge/SidebarProvider 全实现。
- 单测 10 个全过（node:test，fake host 覆盖端口顺延、rpc id 配对、错误传播、审批/提问应答、断线重连）。
- 真实 dsh 冒烟通过（.temp/smoke.ts）：host.describe / session.list / session.create 成功，收到 host/session-added 与 mux session/projection 帧；杀 host 后客户端报 down，HostManager spawn 重启后指数退避重连恢复 ready。
- 关键发现：npm 发布的 @deepseek-ai/dsh@0.1.0-rc.6 的 host.describe 自报版本为 "0.0.1"（非包版本），checkVersion 兼容前缀设为 ['0.1.0-rc.', '0.0.1']。
- WS 事件流真实路径为 /api/events.mux 与 /api/events.host（点分式），已修正 ARCHITECTURE.md 第 1 节。
- bridge 契约新增 command 消息（宿主→webview，工具栏命令转发），已同步 ARCHITECTURE.md 第 3 节。
- npx 冷启动拉起 dsh 约 4.5 分钟，spawn 就绪超时设为 600s。
