# Change Log

本插件所有重要变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号与 `package.json` 的 `version` 保持一致。

## [0.0.13] - 2026-08-19

### 新增

- **session 单条「...」按钮弹窗外部定位优化**：菜单改用 fixed 坐标计算定位，彻底脱离滚动列表容器的 overflow 裁剪；支持点击外部、页面滚动及 Escape 自动关闭。
- **VS Code 插件专用上下文注入**：会话首条消息发送时自动注入 `[DSH_VSCODE_CONTEXT]` 环境指示，要求模型在输出文件与代码引用时使用标准绝对路径（`path:line` 格式），以便前端识别为可点击的代码跳转链接。
- **长文本与 IDE 注入代码折叠卡片化**：IDE 选区与长文本注入封装为 `[DSH_ATTACHED_TEXT]`，在对话气泡中不再全量展开大段代码，解析为 `[📄 文本附件 xxx (N 行) | 展开/收起]` 紧凑卡片，保证对话流清爽。
- **计划栏（TodoPanel）可收起/展开**：任务清单上方增加 Header 统计行 `📋 任务清单 (已完成 N/M 项)` 及切换按钮，可随时折叠隐藏列表项，避免遮挡输入框。
- **右侧上下文指示条（SegmentRail）单块导航化**：将分散的独立 tick 合并为单条实心指示块，鼠标 hover 展开全会话对话导航列表（截取长度提升至 20 字符），点击可直接跳转到指定消息。

### 测试

- 新增 `attached-text.test.ts` 4 例（上下文剥离、文本包裹、用户消息解析与 legacy 兼容）；更新 `segment-rail.test.tsx` 契约；全量单测 101/101 绿。

## [0.0.12] - 2026-08-19

### 新增

- **think/工具调用整轮折叠**：连续的 Think 与工具调用合并为一个可折叠组（一轮一行），收起后对话区只保留用户消息与模型正文输出；进行中的一轮保持展开（实时可见在跑什么），落定后自动收起；展开后组内每行仍可单独拉出完整 think 文本 / 工具卡片。摘要行显示「思考与工具 · N 步 · M 个工具调用 · 工具名」（对齐 dsh web 端 TrajectoryView 摘要风格）
- **think/工具调用图标全面对齐 dsh 设计**：think 灯泡、下拉 chevron、工具类型图标（terminal/read→code、diff→edit、search→search、web→globe、check→checklist、generic→question）全部改用 dsh `ic_ds_*` 内联 SVG，替换原 emoji（💡/❯/📄/✏️/🔍/🌐/🔧/›）；Context injection 行同步换图标与 chevron
- **多会话运行计数**：历史按钮以旋转环 + 数字呈现并发运行数，数字 10px/600、徽标 16px，比会话标题小一档不喧宾夺主

### 修复

- **折叠行对齐与杂点清理**：Think/工具/Context injection 行头 baseline→center，SVG 图标与文字垂直居中、图标列统一 16px 宽；删除 label 与摘要之间的 2px 圆点分隔符（视觉上像多余的「.」）
- **拉起 host 不再弹浏览器**：spawn `dsh web` 增加 `--no-open`（AGENTS.md 约定）——插件拉起后端、e2e 隔离 host 均不再打开默认浏览器的 dsh Web UI（侧边栏本身就是 UI）
- **表格去斑马纹**：markdown 表格删除隔行底色（"整行交替色带"的来源），全表统一底色，表头保留淡底、行间仅 1px 边框
- **markdown 代码块灰色底**：``` 代码块删除边框，整块淡灰底呈现边界（背景对比而非描边；中途透明/深面板两版实验均被否，最终恢复灰底方案）
- **文件跳转 chip 去边框**：`.file-ref` 删除外框，改用淡色背景 + 文字高亮呈现
- **边框/滑动条淡化**：对话区滚动条细轨低对比度、hover 加深；撑开卡片（工具卡/上下文正文）边框改用更淡的 `--dsh-border-soft`，以明暗对比而非粗线分割
- **空会话新建不再创建**：点击“新建对话”时若当前会话仍为空白或对话区无任何内容（无输入），直接复用当前会话，不再新建空会话；有内容时才真正创建

### 测试

- 新增 conversation-rounds 单测 8 例：分组边界/live 判定/标签摘要纯函数 + 分隔点删除、center 对齐、代码块透明的样式契约

## [0.0.11] - 2026-08-19

### 修复

- **markdown 文件链接跳转**：模型输出的 `[文本](路径)` 链接此前被当外部链接一律
  新窗口打开（webview 中无效）。现经 `parseFileHref` 识别为文件引用则渲染为跳转 chip
  （label=链接文本），支持绝对/相对/`~/`/Windows 盘符路径，行号格式覆盖
  `#L32`、`#L18-L40`、`:26`、`:26-29`、`:26:5`，无行号打开第 1 行；
  外链（http/https/mailto）与页内锚保持原行为；流式期间同样识别

### 测试

- file-refs +4（parseFileHref 全格式/拒收）、markdown-block +3（链接 chip/外链不变/
  流式识别）；RJ-1 新增 `#L18-L40` 链接点击断言 reveal 17-39 行

## [0.0.10] - 2026-08-19

### 新增

- **长会话渲染性能**：会话节点加 `content-visibility: auto` + `contain-intrinsic-size`——
  屏外消息跳过布局与绘制（参考 VS Code chat 同病 microsoft/vscode#297349 的社区通行做法）；
  `NodeView` 改 `memo`，流式 delta 不再触发每个落定消息的 react-markdown 全量重解析与
  ToolCard diff 重算（store 投影复用未变节点引用，按引用 memo 安全）
- **代码跳转失败原位反馈**：chip 点击打开失败时 3 秒红色错误态并显示原因
  （`ide-open-file` 加请求/响应回执，此前真实环境失败只有主窗口右下角通知，webview 零反馈）；
  流式中的文本现在也渲染 `path:line` chip（此前只有落定文本可点）

### 修复

- **会话 ⋯ 菜单不跟随点击行**：`.session-menu` 的绝对定位包含块原本是整个 chat-list
  面板（li 无 position），菜单永远贴面板顶部；补 `.session-list > li { position: relative }`
  后菜单跟随被点击的行（e2e DEL-2）
- **代码跳转打开目录误判**：路径解析从 `existsSync` 改 `statSync().isFile()`，
  目录不再被当作可打开文件
- **SegmentRail 左侧竖线删除**（rail 与对话区之间的 1px 分隔线）

### 测试

- 新增 conversation-perf（content-visibility/memo/竖线删除 4 例）、open-file-message
  （回执契约 3 例）、markdown-block（流式/落定 chip 2 例）；file-refs 补目录拒收；
  RJ-1 加强失败回执断言；DEL-2 菜单跟随行位置

## [0.0.9] - 2026-08-19

### 新增

- **统计信息并入上下文弹层**：composer 下方常驻的 StatsLine 统计行移除；点击上下文占用环
  弹出上浮卡片，展示完整会话统计（turns/steps、LLM/Tool 耗时、TTFT、tok/s、Cache hit、
  Input/Output tok）+ 上下文组成分解（系统提示/工具/对话），外部点击或 Esc 关闭
- **会话行 hover 零重排**：⋯ 触发器改绝对定位 + 透明度淡入（覆盖在时间文本上方），
  hover 前后行的尺寸与标题位置完全不变

### 修复

- **对话区横向滚动移除**：滚动区 `overflow-x: hidden`（代码块/表格自身滚动保留）；
  右侧 SegmentRail 改绝对定位与垂直滚动条同列，不再独占一列；rail 容器事件穿透，
  tick 可点击且不挡滚动条拖动
- **SegmentRail 加粗**：tick 6×1px → 10×2px，rail 宽 18px → 22px，常态透明度 0.25 → 0.4
- **session 管理旋转条加粗**：历史按钮运行徽标 border 1.5px → 2px，与单会话行的
  运行转圈粗细对齐

### 测试

- 新增 `context-meter-stats.test.tsx`（弹层内容/外部点击/Esc 关闭/空数据，5 例）；
  e2e 新增 HOV-1/HOV-2（hover 前后行盒逐像素相等 + 徽标 2px）与 OVL-2（禁横向滚动 +
  rail 同列布局断言）；RJ-2 适配 rail 新布局

## [0.0.8] - 2026-08-19

### 新增

- **弹窗统一美化**（TODO 29）：接管卡片、历史下拉、会话菜单、确认对话框统一"浮层卡片"
  质感——10px 圆角 + 淡化边框（soft border token）+ 双层阴影，入场动画改为
  fade + 上浮 + 轻微缩放（180ms）；提问选项选中态由整行重底色改为左侧 2px accent 竖条 + 淡底
- **会话状态指示器重做**：等待应答=琥珀呼吸点（优先级最高）、运行中=2px 旋转圈、
  完成未读=绿点、常态不再渲染占位灰点（标题自然左对齐）
- **SegmentRail 概览化重做**（TODO 19）：删除滚动 1:1 映射（measureMarkers + scroll 监听 +
  ResizeObserver + rAF 节流全部移除），N 条用户消息渲染为垂直居中的 tick 簇
  （簇高 min(N×10, 120)px）；tick 收窄为 6px×1px，rail 常态半透明、hover 恢复；
  hover tick 浮出该消息前 10 码点预览（emoji 按码点截断不断裂），点击仍滚动定位并解除贴底

### 修复

- **会话删除从未生效**（TODO 10）：删除确认原来用 `window.confirm`（VS Code webview 不支持、
  恒返回 false），改为复用 ConfirmModal（归档说明 + 失败原因弹窗内显示 + busy 态）；
  确认后列表实时移除；`deleteSession` RPC 失败时保留列表并抛出原因
- **未读状态点从未显示**：根因是 main.tsx 先引 App 再引 base.css，打包后 base.css 的
  `.status-dot` 灰底压过 chat-list.css 同优先级的颜色修饰类；调整为 base.css 最先引入
- ⋯ 触发器三点由 1.4 描边细线改实心圆点、点击区加大到 22px；菜单由行下方改为与 ⋯ 同行
  向左侧浮出，不再遮挡下方相邻会话行

### 测试

- 单测新增 `tests/status-indicator.test.tsx`（7 例：四态渲染 + store 行为契约 + CSS 引入顺序回归）、
  `tests/segment-rail.test.tsx`（6 例：previewText 截断含 emoji + tick 计数/簇高上限）；
  todo-fixes 增 deleteSession 失败路径（共 68 例）
- E2E 新增 `tests/e2e/overlay-style.spec.ts`（OVL-1：卡片/菜单 token 的 computed style 断言）与
  `tests/e2e/session-delete.spec.ts`（DEL-1：⋯ 菜单 → ConfirmModal → 列表实时消失）；
  RJ-2 断言适配概览版 rail；harness 补 `DSH_HOME/storages` 目录（workspace 域 RPC 需要）

## [0.0.7] - 2026-08-18

### 新增

- **代码跳转**（issue #4）：助手正文 Markdown 中的 `路径:行号`（含 `:行:列` 与 `行-行` 范围）自动渲染为
  可点击 chip（保守识别：拒绝 URL / 时钟 / 无扩展名片段，支持 Windows 盘符与 `~` 路径）。
  点击经 `ide-open-file` 桥消息交给扩展宿主，按**会话 cwd → workspace 根**顺序解析相对路径，
  在编辑器中打开并定位高亮目标行/范围（`revealRange InCenter` + 选中）；文件不存在时提示错误。
  纯识别/解析逻辑可单测（`src/shared/file-refs.ts`、`src/extension/open-file-resolve.ts`）
- **对话分点栏（SegmentRail）**（TODO 19）：对话区右侧窄 rail，每个用户消息一个 `-` 时间轴标记；
  鼠标悬停标记浮现该消息一行缩略预览（移开即隐），点击滚动定位到该消息并解除贴底。
  位置实时测量（滚动 rAF 节流 + 内容 ResizeObserver），工具卡片展开 / 流式增长不产生漂移；
  滚出视野的标记由 rail 裁剪保留（时间轴语义），预览浮层 fixed 定位不被裁切

### 测试

- 单测新增 `tests/file-refs.test.ts`（9 例）：`path:line` 识别（相对/Win/绝对/`~`/范围/列号、拒绝 URL
  与时钟、去重与倒序范围）与路径解析（cwd 优先、root 回退、绝对直通、home 展开、缺失返回 null）
- E2E 新增 `tests/e2e/code-jump-segments.spec.ts`（2 例，共 18）：RJ-1 代码跳转全链路（chip 渲染 →
  `ide-open-file` → 扩展解析打开定位；缺失文件报错）；RJ-2 分点栏（标记计数 / hover 预览 / 点击滚动
  定位 + 解除贴底）。vscode-stub 补齐 `openTextDocument` / `showTextDocument` / `Range` 等面

### 修复

- 分点栏 zustand selector 每次渲染返回新数组导致无限更新（React #185，曾使整条 E2E 联动失败），
  改 `useMemo` 稳定引用

## [0.0.6] - 2026-08-17（本地安装，未上市场）

### 修复

- 窄宽度断点按实测重标定：全部显示仅需 460px

### 测试

- E2E 支持 goal 用例（`.temp` 目标）；发布技能文档补充中断回退指引

## [0.0.4] - 2026-08-17

### 新增

- **Goal 条（本轮补记，功能随 0.0.3 已交付）**：输入卡片上方紧凑目标指示条——
  进行中 / 已暂停 / 已受阻三种状态 + 暂停 / 恢复 / 编辑 / 清除四个动作 + 行内编辑；
  状态只来自 host 的 `goal` 投影（history 基线 + 直播帧），mutation 只发 RPC 不回填本地状态
- **斜杠命令提示**：输入区键入 `/` 弹出命令建议——内置宿主命令 `/goal`（设置/查看目标，
  `clear|edit|pause|resume`）、`/compact`（压缩历史）、`/plan`（进入/退出计划模式）优先，
  其后跟随会话技能名（skill.list）；输入中实时过滤，Enter/Tab 选中，Esc 关闭。
  发送 `/`-开头的单行消息即斜杠命令：宿主命令注册表支持时由宿主直接执行（不发给模型），
  旧版宿主则作为普通消息交给模型
- **Esc 打断**：回合运行中按 Esc 中断（与停止按钮同动作，宿主 `session.cancel`）；
  建议弹层打开时 Esc 优先关闭弹层；模型/权限菜单、风险确认对话框、输入框内的 Esc 保持原有语义
- **窄宽度自适应**：面板变窄（缩放/拖动）时工具栏按优先级逐级隐藏——
  权限选择 → 模型选择 → 上下文环 → IDE 开关 → 附件按钮；发送按钮与输入框永远保留；
  工具栏图标固定尺寸不再被 flex 挤压变形；最下方统计行在窄面板下自动换行展示完整信息。
  断点按真实内容宽度标定（实测 Full access + 模型名 + 上下文环 ≈ 440px）：**全部显示
  只需 460px 宽**（比初版 560px 收窄 18%），chip 内边距与间距同步压缩，窄面板下
  上下文环只留图标（百分比移入 title 提示），保证 460px 起零裁切显示

### 测试

- E2E 新增 2 用例（共 16）：斜杠命令弹出/过滤/选中/发送链路（真实宿主）、
  Esc 打断真实生成回合（live，模型未响应时自动跳过）

## [0.0.3] - 2026-08-17

### 新增

- **IDE 上下文注入（核心）**
  - 发送时自动注入：编辑器有非空选区 → 选中代码随 prompt 一起发给模型；无选区 → 自动带上当前
    文件路径（轻量上下文，模型可用工具自行读取内容）
  - **注入内容对用户隐藏**：模型照收完整 prompt，对话里只显示你输入的问题，注入内容折叠为一条
    `Context injection · ide：…` 提示行（展开可见来源路径），对话不被大段代码刷屏
  - **上下文开关**：输入区 `</>` 按钮一键开启/关闭注入（高亮=开），状态本地持久化
    （webview 重建后保留，默认开启）
  - 手动插入命令：`DSH: 插入选中内容到对话` / `DSH: 插入当前文件到对话`（插入草稿，发送后同样
    隐藏内容并显示提示行）
- **会话按工作区隔离**：init 时经 `workspace.create` 解析 host 规范路径（realpath canon）过滤
  `session.list`；其他窗口 / 工作区新建的会话（`host/session-added` 帧）不再混入当前列表
- **会话实时置顶**：在某个会话发送消息后，该会话立即更新到列表最顶部
  （`user/message` 事件用 host 时间再确认）
- **提问/审批接管增强**：pending 接管按会话记录——后台会话的提问也点亮琥珀等待点，
  切走再切回原会话面板不丢
- **测试体系**：Playwright 浏览器 E2E 套件（真实扩展宿主代码跑在 Node + 真实隔离 dsh host，
  14 用例覆盖全部回归（含 Goal 条真实 host 域）+ 真实模型对话闭环）；详见 `.agents/skills/dsh-vscode-e2e`

### 修复

- 侧边栏切到后台再切回后 askuserquestion 失效：扩展侧常驻保留待应答帧（OverlayRetention），
  重新打开时经 init 重放并自动选中提问会话
- 跨工作区会话混淆（会话列表混入其他工作区的会话）
- 会话置顶不实时（此前需重载窗口才生效）
- 进入后台运行中的会话不计时：由 history 尾页未闭合 turn 的 turn/start 恢复运行状态与计时时钟

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
