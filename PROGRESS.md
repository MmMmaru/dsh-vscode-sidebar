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
