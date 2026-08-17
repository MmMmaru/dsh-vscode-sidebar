# 进展记录

### 08-17 IDE 注入改为隐藏式 + 开关
- **注入内容不进用户气泡**：模型照收完整 prompt，气泡由 `findIdeBlock` 剥离 `### 选中代码（…）`/`### 文件：…`/`### 当前文件：…` 块，另渲染一条 `ide：…` context-injection 提示行（可展开看路径）。
- **上下文按钮改为开关**：IDE 芯片菜单（插入选中内容/当前文件）移除，变为 `ideContextEnabled` 开关（composer-chip-active 高亮，localStorage `dsh.settings.ideContextEnabled` 持久化——webview 隐藏重建后保留，默认开）；`sendPrompt` 关闭时不注入。`dsh.insertSelection`/`dsh.insertActiveFile` 命令保留（手动插入走 draft，发送后同样被剥离+提示行）。
- 单测 +1（findIdeBlock 三种块剥离/解析）；E2E 改写：芯片插入用例 → 命令路径（harness `emitIdeContent`）+ 新增开关关闭用例；全套 12 用例绿（39.1s）；VSIX 重打并同步已安装扩展目录；skill 同步更新选择器说明。

### 08-17 E2E 技能沉淀
- 新增 `.agents/skills/dsh-vscode-e2e/SKILL.md`：完整沉淀 Playwright E2E 方案——架构（真实扩展宿主 + 真实隔离 host + vscode stub + 接口对齐钩子）、文件布局、运行方式、harness API 表、写作约定与踩坑清单（retention 清理 / radio role / live 用例 skip 策略 / 会话共享计数等）、新增用例步骤与排障路径。

### 08-17 默认携带当前文件路径
- 无选区提问时，`enrichWithIdeContext` 把活动编辑器路径以 `### 当前文件：<path>` 轻量块追加进 prompt（模型可用工具自行读内容，避免整文件撑爆上下文）；有选区仍注入选中代码块；两者互斥且草稿已有 IDE 块时跳过。
- E2E 新增 `asking without a selection attaches the active file path`（空选区 → 只带路径、断言整文件内容未注入）；全套 11 用例绿（33.6s）；VSIX 重打并同步已安装扩展目录。

### 08-17 发送时自动注入 IDE 选中内容 + 真实环境排障
- **自动注入**：提问时若活动编辑器有非空选区，`sendPrompt` 发送前经相关式 `ide-request(id)` 往返（`fetchIdeContent`，2s 超时）取回选中内容，以「### 选中代码（path）+ 语言围栏」块追加进 prompt；草稿已含 IDE 块（芯片插入）时跳过；无选区/无编辑器/超时静默跳过（best-effort）。`IdeContentPayload` 增 `fromSelection`/`id` 字段；芯片手动插入路径不变。
- 排障实录：用户报告「切会话回来提问面板消失 + 置顶需重载 + IDE 内容看不见」，实为 **两个扩展注册同一视图 id `dsh.sidebar`**（`deepseek.dsh-vscode-sidebar-0.0.1` 旧代码 + `xurongsheng.dsh-vscode-sidebar-0.0.2` 新代码）——旧扩展先注册视图，新扩展每次激活抛 `View provider for 'dsh.sidebar' already registered` 崩溃（三次重载日志实锤），侧边栏一直由旧代码提供。已删除冲突的 0.0.1 目录并清理 .obsolete。
- E2E 新增：`asking with an editor selection auto-injects the selected code`（真实 ide-request 往返 + 真实 prompt，断言用户气泡含注入块）；switch-repro.spec 增加注入帧切换、真实提问切换（模型未 ask 则 skip）、真实应答闭环（应答→resolved→agent 继续）三个用例。全套 10 用例绿（26.6s）。
- E2E 排障：全量跑偶发失败根因是**真实提问用例未应答导致 retention 残留**，下一用例 init 重放旧提问并自动选中旧会话、列表被隐藏——真实提问用例结尾须应答清 retention（注入帧用例补发 question/resolved 同理）。
- 回归：typecheck + 37 单测 + build + verify:mock 全绿；VSIX 重打并同步已安装扩展目录（重载窗口即生效）。

### 08-16 Playwright E2E 套件（真实扩展宿主 + 真实隔离 dsh host）
- 架构（与用户 grill 确认）：真实扩展宿主代码（Bridge/DshClient/HostManager/OverlayRetention，`vscode` 模块经 esbuild alias 替换为 `tests/e2e/vscode-stub.ts`）跑在 Node；Playwright 页面加载真实构建产物 `media/main.js`，页面内 acquireVsCodeApi stub 经 WebSocket 与 Node 宿主桥接（消息队列防 ready 早发）；每运行自 spawn 隔离 dsh host（`$DSH_HOME` 临时目录 + 拷贝 ~/.dsh/settings.yaml 与 .credentials.yaml，端口 3200 起探测，结束自清理并删临时目录；**永不触碰 3080**）。
- 接口对齐的测试钩子：`DshClient.emitMuxFrame(frame, rpcId?)` / `emitHostFrame(frame)` —— 走与 WS 帧完全相同的分发路径（trackPending 登记待应答表 + 监听器扇出），注入源不同但下游无差别；注入帧的应答会被真实 host 以未知 rpcId 拒绝，故测试应答后补发 question/resolved 镜像 host 确认。
- 用例 6 个（串行，`npm run test:e2e`，9.4s 全绿）：① init 只渲染本工作区会话 ② 真实 host/session-added 外部 cwd 帧不入列 ③ IDE 芯片插入（stub 编辑器选中文本 → 格式化块；无编辑器 → toast）④ 提问面板出现→应答→清除 ⑤ **提问后台重放**（关页面→注入 question/requested→重开页面→init.pendingOverlays 自动选中并重现面板→应答）⑥ 真实模型对话闭环（发送置顶 + 流式文本 + turn 尾统计，结构断言）。
- 排除项（按讨论）：审批面板（保持 danger-full-access，模型自然触发不可控）、计时时钟（单测已覆盖 runningSince 推导）。
- 基建：`tests/e2e/{vscode-stub,harness,e2e.spec}.ts`、`playwright.config.ts`（workers=1、失败截图/trace 到 .temp/e2e-artifacts）、esbuild `--e2e` 目标（含 harness.d.mts 声明）、`npm i -D ws @types/ws`。
- 调试记录：注释内反引号截断模板字符串；spec 相对路径层级（tests/e2e → ../../）；fixture worker 作用域需 `base.extend<{}, {harness}>`；QuestionPanel 选项按钮 role=radio 需 getByRole('radio')；stub activeTextEditor 用 undefined 而非 null（对齐 vscode API）；遗留提问 retention 需测试补发 resolved 清理。

### 08-16 五项 TODO 修复（ide 插入 / 提问重放 / 工作区隔离 / 会话置顶 / 计时恢复）
- **ide 内容插入**：bridge 协议新增 `ide-request`/`ide-content` 消息；扩展侧读取活动编辑器（选中内容，空选区回退整文件）经 `dsh.insertSelection` / `dsh.insertActiveFile` 命令或输入区 IDE 芯片触发；webview 侧 `ide-insert.ts` 纯函数格式化（来源文件头 + 按扩展名推断语言标签的代码围栏）追加进 draft，错误走 toast。
- **askuserquestion 后台失效**：根因是侧边栏 webview 隐藏即被 VSCode 销毁、UI 状态全丢，pending 提问帧也不会重发。新增扩展侧 `OverlayRetention`（常驻 client 级订阅记录 approval/question 帧，resolved 帧清除），init payload 携带 `pendingOverlays` 重放；overlay slice 改为按会话记录 `overlayBySession`（后台会话的提问也点亮琥珀等待点），选中会话即派生接管面板，init 重放时自动选中提问会话。
- **跨工作区会话隔离**：init 时先 `workspace.create({path})` 取 host 规范路径（realpath canon）再过滤 `session.list`；`host/session-added` 帧按 cwd 守卫，其他窗口/工作区新建的会话不再注入列表。
- **会话置顶**：`touchSession` 更新 updatedAt 并重排序；sendPrompt 成功即置顶，`user/message` 事件用 host 时间再确认。
- **运行中会话不计时**：`projectPage` 从 history 尾页推导未闭合 turn 的 turn/start（`runningSince`），进入后台运行中会话时恢复 `turnStatus='running'` 与 `turnStartedAt`，计时时钟（TurnStatusLine）恢复走动（停止按钮此前已由会话元数据 running 标志修复）。
- 回归：typecheck + 37 单测（新增 `tests/todo-fixes.test.ts` 10 例 + `tests/overlay-retention.test.ts` 3 例）+ verify:mock + build 全绿；**未跑 smoke**（其 `fuser -k 3080/tcp` 会误杀本环境 3080 上的 harness 后端，详见会话记录）。

### 08-16 Goal 指示条
- 参照 deepseek-harness 的 `ui-goal` GoalBar 与 `goal` 域语义，整体重做 Goal 指示条：新增 vendored `protocol/goals.ts`（GoalPhase/GoalRef/GoalSnapshot/GoalProjection）与独立 `store/goal.ts` slice；`views.ts` 的 GoalRef 移到 `goals.ts` 并重导出。
- 状态只来自 `goal` 投影（history 基线 + mux `session/projection` whole value，带 active-session guard），mutation（edit/pause/resume/clear）只发 RPC、不回填本地状态，错误由 GoalBar 组件级 error 槽显示；修正旧版乐观更新、method 无关 single-flight、goalError 双份、mock 单一 demoGoal 等问题。
- Composer 上方接入紧凑 GoalBar（进行中/已暂停/已受阻 + 暂停/恢复/编辑/清除 + 行内编辑），图标用内联 SVG 规避 emoji 豆腐块。
- mock 按会话隔离 goal（Map），支持 create/edit/pause/resume/complete/clear 与 whole-value 投影帧；`session.history` 基线携带 `goal`。
- 新增 `tests/goal.test.ts`（8 例：投影隔离、CAS 载荷、无乐观更新、失败可见、loadHistory 集成、GoalBar SSR 与编辑交互）+ `react-test-renderer.d.ts`；tsconfig 增 DOM/jsx/vite-client，esbuild 测试 external react-test-renderer。
- 回归：typecheck + 23 单测 + build（extension 29KB / webview 742KB）全绿。

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

### 08-15 13:10
- 修复默认权限不同步：composer 权限芯片原先硬编码初始 workspace-write，且 loadSettings 只在打开设置页时才跑。新增 settings slice 的 syncPermissionDefault（启动时 settings.describe 只取 permission 命名空间 → 同步 uiPrefs 与芯片状态，设置面不可写时回退 localStorage）；setUiPref('permissionMode') 同步芯片；newChat 时芯片重置为已保存的默认权限。真实 host 验证：permission.defaultPreset 已是 danger-full-access，重装后新会话芯片显示 Full access。

### 08-15 13:40
- 模型自动选型：web 端的"记住上次模型"本就在 host 端（session.selectModel 会把选择存为部署级默认 agent-default-model，新会话 session.models.current 直接带回）。插件补的是无会话首页：启动时调 host.describe 取回默认 provider/model 预选到模型芯片（已选/待定选择不覆盖），发送时沿用既有 pendingModelSelection 链路。mock 补 host.describe 处理器。真实 host 验证新会话 current 即上次模型（deepseek-v4-flash）。

### 08-15 14:05
- 新建对话去重：当前会话仍为空（blank）时点新建不再生成新空会话，直接复用当前；补上了 blank 标志的翻转——live 事件流首帧到达即把该会话 blank 置 false（原先 blank 只在 session-added 时写入，发完消息仍残留 true）。Playwright 探针验证：空白会话连点两次新建只多一行；发过消息后再点新建才真的建新会话。

### 08-15 15:50
- subagent 可停止：新增 SubagentDock 停靠条（QueueDock 旁），列出当前会话的子代理——continuable 且运行中的显示"停止"按钮（subagent.interrupt，回包后刷新目录）；one-shot/已结束只读。后台任务（session/jobs 帧，原先被丢弃）渲染只读状态行（协议不支持手动停止，停止权属模型侧 job_kill，title 已注明）。
- store：conversation slice 新增 activeJobs/activeSubagents + loadSubagents/stopSubagent；selectSession 触发目录加载。mock 补 subagent.list/interrupt 与 session/jobs 帧。
- 验证：typecheck + 15 单测 + 全部 verify 脚本 + 新增 verify-subagent 全绿；Playwright 截图确认停止按钮点击后状态翻转。
- 插件图标对齐 DeepSeek 鲸鱼品牌（resources/icon.svg 换鲸鱼 currentColor 版供 activity bar；新增 256px PNG 供 marketplace，package.json icon 字段已配）。

### 08-15 16:20
- 修复"返回运行中的会话找不到停止按钮"：ComposerCard 的 running 原先只看事件驱动的 turnStatus，而 loadHistory 无条件重置为 idle。现在 running = turnStatus==='running' || 会话元数据的 running 标志（host/session-status 推送，重装/切换后仍准确）。Playwright 验证：进入运行中会话主按钮显示"停止生成"。
