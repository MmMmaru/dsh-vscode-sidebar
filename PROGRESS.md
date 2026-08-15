# 进展记录

### 08-15 03:00
- 完成需求对齐与立项文档：`docs/PRD.md`（产品需求）、`docs/ARCHITECTURE.md`（模块划分 + 函数输入输出）、`docs/PLAN.md`（W0–W7 并行实施大纲）。
- 关键决策：后端复用 dsh Web Host（HTTP RPC + mux/host 两条 WS），插件只做界面；无 workspace 概念，按 cwd 归属会话；本地 VSIX 使用。

### 08-15 04:30
- W0+W1：扩展脚手架（esbuild + vite 双构建）+ 宿主侧三连（host-manager 探测/拉起 dsh、dsh-client RPC+WS+断线重连、bridge 消息桥）。协议类型 vendored 自 deepseek-harness@47f9438。对真实 dsh 冒烟通过（host.describe / session.list / 杀 host 重连）。
- webview 契约骨架：types.ts 视图模型、mock bridge（30 假会话 + 脚本化演示流）、zustand 五 slice、App 三层壳。

### 08-15 06:30
- W2–W6 并行开发（4 个子代理 + worktree 隔离）并全部合并：
  - W2 会话列表（状态点/相对时间/View all/搜索/重命名/删除/Fork）
  - W3 对话区（Markdown 两阶段渲染、Think 折叠行、六种工具卡片、滚动跟随、Load older）
  - W4 输入区（键盘仲裁、附件三来源、权限风险确认、两级模型菜单、队列 Dock、Todo、统计行）
  - W5 接管面板（审批/提问/Plan 评审整块替换输入区）+ 扩展宿主侧 respond 应答链路补全
  - W6 设置面板（通用/模型/插件/预设四区块，provider 编辑 + 凭证写入）
- 质量门：15 单测 + verify:mock / verify:w3 / verify:composer / verify:overlay / verify:w6 全绿。
- 截图自验（Playwright headless，375×907）：首页/对话/审批接管/设置四张，结构与参考截图一致；修复审批时输入区未隐藏、空态 emoji 豆腐块两处视觉问题。无 root 环境用 `apt-get download` + `dpkg -x` + `LD_LIBRARY_PATH` 解决 chromium 缺库（.temp/libs/）。
- 端到端真实 DeepSeek 验证通过：自动拉起 dsh host → 建会话 → 发「你好」→ 收到模型完整回复（.temp/e2e-deepseek.ts，E2E OK）。

### 08-15 08:30
- 修复真实环境三连问题（根因均为"无活动会话"状态）：
  - 输入框无会话时禁用 → 改为随时可输入，发送时自动创建会话（Codex 式）
  - 模型选择器无会话时无数据 → 初始化即加载全局 llm.models 目录；无会话时选择先暂存，建会话后自动应用
  - ContextMeter 0% 时只剩一个空心环 → 环旁增加百分比文本
- 打包链路：@vscode/vsce + .vscodeignore，VSIX 从 8.78MB 瘦身到 189KB。
- 回归：15 单测 + verify:mock + verify:composer（新增无会话发送/全局模型目录断言）全绿；截图复验通过。

### 08-15 09:10
- 历史会话改为下拉层交互：时钟按钮/View all 展开带搜索的浮层，点外部或 Esc 收起（原先是常驻展开态）。
- 截图验证：展开/搜索过滤/外部点击收起三态通过；VSIX 重打 189.92KB。

### 08-15 11:37
- StatsLine/ContextMeter 对齐 web 端投影数据源：新增 protocol/projections.ts 四个投影类型；conversation store 安装 history tail 投影基线并消费 session/projection 直播帧；StatsLine 输出完整统计行（turns/steps、LLM/Tool 耗时、TTFT/tok·s、Cache hit、Input/Output），ContextMeter 按 contextWindow 设置计算占用、缺数据不渲染。
- 设置图标换成经典齿轮；历史下拉选中会话自动收起；修复下拉滚动失效（根因：base.css .region-chat-list 的 overflow:hidden 打包后压过 chat-list.css，改用双类选择器提优先级）。
- assistant 消息末尾新增操作行：复制（1.5s 已复制反馈）+ fork（session.fork 带 atSeq 锚点，streaming 时隐藏）。
- 修复设置保存失败：wire 枚举 'danger-full-access' ↔ UI 内部 'full-access' 在 settings.ts 绑定层双向映射。
- 整体字号调大：base.css 基准抬到 max(vscode字号, 14px)，em 相对层级自动等比上调。
- 回归：typecheck + 15 单测 + verify:mock + verify:composer 全绿；真实 DeepSeek e2e 通过；截图复验通过；VSIX 重打 191.76KB。

### 08-15 12:05
- ContextMeter 用量环配色：底轨（未用）浅色 30% 透明，填充弧（已用）主题前景深色。
- 会话列表显隐：仅开始界面（无活动会话）常驻最近 5 条 + View all；进入会话后只留 Chats 头部，历史走时钟下拉。
- 状态点三态规则：绿=执行中，蓝=执行完未读（running→false 且非活动会话时标记，选中即清除），灰=已读；审批等待仍保持琥珀色最高优先级。
- 回归：typecheck + 15 单测 + verify:mock 全绿；截图复验通过；VSIX 重打。

### 08-15 12:25
- 修复未读蓝点不生效：turn/end 与 host/session-status 的未读标记原先排除活动会话，导致"执行完直接变灰"。现在任何会话 turn 结束都标蓝，选中（含重复点击当前会话）即清除为灰。Playwright 探针验证：审批+提问走完后活动会话点变蓝，mock 预置行渲染蓝点。

### 08-15 12:50
- 新增：有后台 session 运行时，历史会话按钮变为旋转圈 + 中心数字（运行中数量），点击仍展开历史下拉。
- 网页端统一：newChat 先调 workspace.create（按插件根目录幂等归属），再 session.create({workspaceId})；老 host 不支持时回退 cwd 创建。插件会话此后在 dsh 网页端归入对应 Workspace 统一管理。真实 host 已验证 workspace.create 可用。
- 排查结论（未改代码）：subagent 停不掉是插件缺实现——harness 有 subagent.interrupt RPC（仅 continuable 模式）且 web 端已接；协议类型插件已 vendored（protocol/subagents.ts），补一个 subagent 列表 + 停止按钮即可。
