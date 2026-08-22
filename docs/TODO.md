# TODO

> 拆分为「待办」与「已完成」两块；编号全局唯一（讨论时直接说编号）。
> 已完成按发布版本排序（新→旧，与 CHANGELOG 一致）；待办无版本归属，按分类排列。
> 分类与原始备注原样保留；issues 条目带链接。

## 待办（未完成）

### 配置界面调整
- [ ] 9. 后端模型真实配置，目前好像不work
同步web端界面，不要显示所有的provider配置，按照目前已经配置的显示+自定义provider按钮+预定义provider按钮
- [ ] 11. 插件可配置
参考web端设计

### 功能
- [ ] 3. [#1](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/1) 增加自动重启后端功能  
- [ ] 6. [#6](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/6) ide 上下文注入不需要每次都注入  
- [ ] 8. subagent管理  
我觉得这个后台运行的时候至少要有个提示，前台的话就无所谓吧。后面再支持一下前台的美观优化。
- [ ] 12. GIF展示
动态演示
- [ ] 13. 模式动态切换
调研dsh是否支持动态切换？
- [ ] 14. 任务完成提示
支持音频提示
- [ ] 18. 图片上传预览失败
- [x] session单条...按钮弹窗优化，目前还是和session管理在一起，拉到最底下的时候看不到session了，优化到一个外部位置的弹窗
- [x] 注入vscode插件专用上下文（使用绝对路径进行代码引用）
- [x] 长文本压缩为txt不显示在对话框内
- [x] 计划栏可收起
- [x] 右侧上下文指示条转换成一块，鼠标放上去之后显示全部对话，显示对话长度变为20字符

### bug
- [ ] 26. [#5](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/5) 对话管理界面依然显示 ide 上下文注入内容

### 美化
- [ ] 32. TODO栏目颜色代表执行与代办
- [ ] 33. 框线淡化，优化前端组件设计
- [] 工具调用、思考等组件优化
- [ ] 34. ide上下文注入就说：ide上下文注入，后面不需要

### 项目harness
- [ ] 36. 补充使用playwright构建的e2e test。

### 低优先

- [ ] 25. [#2](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/2) 解决 node use env 的问题（与 #7 proxy 加载相关）
- [ ] 7. [#7](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/7) proxy 自动加载（环境变量自动注入，见 issue body）
- [ ] 24. dsh后端中断后卡住，在bash执行情况下。
- [ ] 28. 删除候选发送列表部分时候出现无效
- [ ] 17. 英文切换支持
---

## 已完成（按版本，新→旧）

### 0.0.12（当前版）
- [x] think/工具调用缩放：折叠为单行（缩略摘要 + 下拉箭头），模型输出正文全量显示，点击拉出完整 think 文本 / 工具卡片
不是这个折叠，需要一轮全部做折叠，这种情况下只输出模型输出内容
R2: 整轮折叠落地——连续 Think+工具调用合并为一个折叠组（rounds.ts `groupRounds`），收起后只剩用户消息与模型正文；进行中的一轮保持展开、落定自动收起；组内各行仍可单独展开看详情
- [x] think/工具调用图标全面对齐 dsh 设计（think 灯泡、下拉 chevron、工具类型图标全部改用 dsh `ic_ds_*` 内联 SVG，替换 emoji：💡/❯/📄/✏️/🔍/🌐/🔧/›；Context injection 行同步换图标）
继续美化，目前好像位置和文字没有对齐，而且后面有一个.是什么鬼，删掉
R2: 行头 baseline→center 对齐（SVG 图标与文字垂直居中，图标列统一 16px）；label 与摘要间的 2px 圆点分隔符（`.reasoning-sep`）整体删除
- [x] 多会话运行时 session 指示数字优化：并发运行计数加粗加大（9px→12px bold，徽标 18px）
不美观，比session标都大了。
R2: 徽标 18→16px，数字 12px/700→10px/600，比会话标题小一档
- [x] 边框淡化/滑动条淡化/对比色凸显：对话区滚动条细轨低对比；markdown ```代码块删除边框改灰色块（背景对比而非描边）；撑开卡片边框改淡（--dsh-border-soft）
文字还是有暗条，删掉
R2: 实证定位——"整行交替色带"真凶是表格斑马纹（已删，13 种围栏样本经真实 MarkdownBlock 复验均无漏解析）；代码块历经透明/深面板两版实验后按用户定稿恢复原淡灰底（color-mix(fg 6%)，背景对比而非描边）；file-ref chip 补普通色兜底防旧内核露 UA 按钮灰
- [x] 文件跳转边框消除：`.file-ref` 去外框，改淡色背景 + 文字高亮
- [x] 空会话新建不再创建：点击“新建对话”时若当前会话无内容输入（对话区无节点）则复用当前会话，不新建空会话
通过

### 0.0.11
- [x] 5 关联. markdown 文件链接跳转（`[文本](路径)` 识别为 chip：支持绝对/相对/`~`/盘符 + `#L32`/`#L18-L40`/`:26`/`:26-29`/`:26:5` 行号，无行号开第 1 行；外链与页内锚不变；流式同样识别；e2e RJ-1 补 reveal 断言）

### 0.0.10
- [x] 新增. 长文本渲染卡顿治理（参考 codex/VS Code chat 同病 issue #297349：`.conv-node` 加 content-visibility 屏外跳过渲染 + NodeView memo 消除流式期全量重解析）
- [x] 新增. 删除会话菜单不跟随会话位置（根因：`.session-menu` 绝对定位包含块是整个面板——li 无 position；补 `.session-list > li{position:relative}`；e2e DEL-2）
- [x] 新增. 上下滑动组件旁边竖线删除（`.segment-rail` 的 border-left）
- [x] 5 关联. 代码文本跳转无效（根因：真实环境失败只有主窗口通知、webview 零反馈 + existsSync 把目录误判可打开；修：ide-open-file 加回执、chip 失败 3 秒原位红态、流式文本也渲染 chip、改 statSync().isFile()；e2e RJ-1 加强）

### 0.0.9
- [x] 新增. StatsLine 并入 ContextMeter 弹层（点击上下文环弹出上浮卡片：完整统计 + 上下文组成分解逐行展示，外部点击/Esc 关闭；常驻统计行移除）
- [x] 新增. 滚动条整改：对话区禁止横向滚动；SegmentRail 改绝对定位与垂直滚动条同列（rail 容器 pointer-events 穿透，tick 可点不挡滚动条拖动）
- [x] 新增. SegmentRail 加粗（tick 6×1→10×2px，rail 18→22px，常态透明度 0.25→0.4）
- [x] 新增. session 管理旋转条加粗对齐（1.5px→2px，与单会话 .status-spin 一致）
- [x] 新增. session 行 hover 布局抖动消除（⋯ trigger 改绝对定位+透明度切换，时间文本不再 display 切换，hover 前后行盒零变化；e2e HOV-1/HOV-2）

### 0.0.8
- [x] 29. 优化目前悬浮窗口效果  
（统一浮层卡片 token：10px 圆角、淡化边框、双层阴影、fade+上浮+缩放入场；提问选项选中态改左侧 2px 竖条+淡底）
- [x] 10. session ⋯ 菜单出现在旁边（同行左侧浮出）+ 实心三点加大点击区；删除按钮修复（webview 不支持 window.confirm，改 ConfirmModal，删除后列表实时消失）
- [x] 19. SegmentRail 重做为概览模式（删滚动映射，N 条用户消息聚成垂直居中 tick 簇，hover 出 10 码点预览，点击跳转）
- [x] 新增. 会话状态指示器（等待=琥珀呼吸点 / 运行=2px 转圈 / 完成未读=绿点 / 常态无点）；并修复未读点从未显示——base.css 打包顺序压过同优先级修饰类

### 0.0.7
- [] 5. [#4](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/4) 增加代码跳转  
（助手正文 `路径:行号` 渲染为可点击 chip；会话 cwd → workspace 根解析；打开并定位高亮该行/范围；e2e RJ-1）
未通过，点击无效，需要支持绝对路径
- [] 19. 对话框内分点支持，在右侧加入一个bar，展示用户对话开始点。鼠标悬浮展示对话内容
（SegmentRail：每个用户消息一个 `-` 标记，hover 浮现一行缩略预览，点击滚动定位并解除贴底；e2e RJ-2）
参考web端设计
不符合设计方案，参考webui的设计

### 0.0.6（本地安装，未上市场）
- 仅窄宽度断点重标定收尾（对应 27/35 的最终态，无独立 TODO 条目）

### 0.0.4
- [x] 2. /命令支持，对话框内输入斜杠后提示命令输入，参考目前已有的技能名提示  
支持技能名、/goal、/compact、/plan
R2: 将命令和技能分开，使用一个分隔符分割一下
- [x] 16. ecs打断支持
- [x] 27. 缩放问题，再缩放到较小时出现图标变形及消失
优先保留：发送按钮，缩小时选择消除优先级：access选择、模型、ide按钮、+号
- [x] 35. 最下面的信息栏目缩放时完整信息放到第二栏。
（StatsLine 窄宽度（≤480px）自动换行显示完整信息，不再省略号截断）

### 0.0.3
- [x] 1. Goal 条（已接入：进行中/已暂停/已受阻 + 暂停/恢复/编辑/清除）
![alt text](png/image.png)  0.0.4版本changelog说明一下
- [x] 15. ide内容插入
（已完成：① 发送时自动注入——选中代码 / 无选区带当前文件路径；② 注入内容对用户隐藏，对话只显示 `ide：…` 提示行；③ 输入区 `</>` 上下文开关（持久化，默认开）；④ 手动命令 `dsh.insertSelection` / `dsh.insertActiveFile`）
- [x] 20. 放到后台的时候，再切回来发现askuserquestion失效。
（webview 隐藏即被销毁；扩展侧 OverlayRetention 常驻保留待应答帧，init 重放 + 按会话记录 overlay，切回自动选中并恢复接管面板）
成功
- [x] 21. 跨工作区会话混淆了，按照vscode工作区划分会话
（init 时经 workspace.create 取规范路径过滤 session.list；host/session-added 按 cwd 守卫，其他窗口的会话不再混入）
成功
- [x] 22. 在用户在某个会话传入信息之后，会话需要更新到最上面
（sendPrompt 成功即 touchSession 置顶；user/message 事件用 host 时间再确认排序）
成功
- [x] 23. 某个会话出现不计时问题
（进入后台运行中的会话时，由 history 尾页未闭合 turn 的 turn/start 恢复 turnStatus 与计时时钟）
暂定成功

### 0.0.1
- [x] 4. [#3](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/3) 增加 Enter 发送功能  
（已有实现：Enter 发送 / Shift+Enter 换行 / 输入法组合保护 / 长按不连发，issue 已关）
