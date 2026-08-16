# Change Log

本插件所有重要变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号与 `package.json` 的 `version` 保持一致。

## [0.0.2] - 2026-08-16

### 变更

- 审批 / 提问 / Plan 评审接管面板视觉升级：对话区加半透明模糊遮罩（纯视觉、不拦截点击），
  卡片抬升并带阴影与圆角，入场淡入 + 轻微上浮动效，标题与详情行高优化，按钮悬停过渡

## [0.0.1] - 2026-08-15

首个发布版本。DeepSeek Harness（dsh）的 VSCode 侧边栏客户端：插件只做前端界面，
后端能力全部复用本机 dsh Web Host（loopback，无实例时自动拉起）。

### 新增

- **会话管理**：按当前 VSCode 工程目录（cwd）过滤的会话列表；状态点三态（绿=运行中、
  蓝=执行完未读、灰=已读，审批等待琥珀色优先）；重命名 / 删除 / Fork；历史下拉浮层
  （搜索、外部点击或 Esc 收起）；后台运行计数转圈；空会话复用（不产生重复空会话）
- **对话区**：Markdown 两阶段渲染（流式期间代码块/公式按纯文本，回合结束后完整渲染，
  代码块带复制按钮）；Think 推理块折叠行；六类工具调用卡片（Bash 终端 / Edit·Write diff /
  Read 行号文件 / Grep·Glob 搜索 / Web 搜索引用，subagent 递归缩进）；特殊行（上下文注入、
  历史压缩标记、模型重试、回合错误、token 上限提示、Deep diving 运行状态）；消息复制与
  fork 分支；历史分页 "Load older" 与滚动跟随（上翻解除、回到底部按钮）
- **输入区**：多行自动增高（Enter 发送 / Shift+Enter 换行，随时可输入、无会话时发送自动建会话）；
  附件三来源（按钮 / 拖拽 / 粘贴图片，缩略图 rail 预览与移除，超限整批拒绝）；权限芯片
  （Read Only / Workspace Write / Full access，选 Full access 弹风险确认）；两级模型选择器
  （按 provider 分组 + reasoning effort，无会话时选择暂存、建会话后自动应用）；上下文用量环；
  统计行（turns/steps、LLM/Tool 耗时、TTFT、tok/s、缓存命中、Input/Output token）；
  消息队列（编辑 / 删除 / 立即插话 Steer）；Todo 面板；运行中主按钮变 Stop
- **审批与提问**：审批浮层（模型理由 + 待执行命令 + Refuse / Allow once）、ask-user 提问
  （单选/多选/自定义输入/分页 + Skip / Submit）、Plan 评审（完整 Markdown + Chat about it /
  Refuse / Approve），均整块接管输入区
- **SubagentDock**：continuable 子代理停止按钮（subagent.interrupt）；one-shot / 已结束子代理
  只读展示；后台任务只读状态行
- **设置页**：通用（Agent 预设、新会话默认权限、语言、外观跟随 VSCode、繁忙时 Enter 行为）；
  模型（provider 列表含已配置/未配置状态、编辑卡输入 API key 与 Base URL、增删提供方，
  凭据写入 harness 凭据存储）；插件（插件设置与清单）；Agent 预设列表管理
- **后端接入**：本机 dsh Web Host 自动拉起与探测；HTTP RPC + mux / host 两条 WebSocket，
  断线自动重连；新会话经 workspace.create 归入当前工程 Workspace（老 host 回退 cwd 创建）；
  协议类型 vendored 自 deepseek-harness
- **品牌与打包**：DeepSeek 鲸鱼品牌图标（activity bar SVG + marketplace PNG）；VSIX 瘦身
  （.vscodeignore 排除源码与文档，约 8.78MB → 200KB）

### 修复

- 无会话时输入框被禁用 → 改为随时可输入、发送自动建会话
- 模型选择器无会话时无数据 → 启动即加载全局 `llm.models` 目录
- ContextMeter 0% 时只剩空心环 → 环旁增加百分比文本
- 审批/提问接管时输入区未隐藏
- 空态图标豆腐块（emoji 缺字）
- 未读蓝点不生效 → 任何会话 turn 结束即标蓝，选中清除为灰
- 历史下拉滚动失效（`overflow: hidden` 样式优先级冲突）
- 设置保存失败 → wire 枚举 `danger-full-access` ↔ UI `full-access` 双向映射
- 返回运行中的会话时停止按钮不恢复（running 状态改从会话元数据推导）

### 已知限制

- 仅连接本机 dsh Web Host（loopback），不支持远程 harness
- 仅适配 dsh 0.1.0-rc 系版本，版本不匹配时提示升级
