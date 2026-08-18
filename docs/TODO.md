# TODO

> 拆分为「待办」与「已完成」两块；编号全局唯一（讨论时直接说编号）。
> 已完成按发布版本排序（新→旧，与 CHANGELOG 一致）；待办无版本归属，按分类排列。
> 分类与原始备注原样保留；issues 条目带链接。

## 待办（未完成）

### 功能
- [ ] 3. [#1](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/1) 增加自动重启后端功能  
- [ ] 6. [#6](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/6) ide 上下文注入不需要每次都注入  
- [ ] 7. [#7](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/7) proxy 自动加载（环境变量自动注入，见 issue body）
- [ ] 8. subagent管理  
我觉得这个后台运行的时候至少要有个提示，前台的话就无所谓吧。后面再支持一下前台的美观优化。
- [ ] 9. 后端模型真实配置，目前好像不work
同步web端界面，不要显示所有的provider配置，按照目前已经配置的显示+自定义provider按钮+预定义provider按钮
- [ ] 10. 目前session管理栏目里...点击之后选项出现在那一个session，我希望出现在旁边。
同时优化...，现在太小了。
同时删除按钮失效，在session栏里没有实时看到那个会话消失
- [ ] 11. 插件可配置
参考web端设计
- [ ] 12. GIF展示
动态演示
- [ ] 13. 模式动态切换
调研dsh是否支持动态切换？
- [ ] 14. 任务完成提示
session管理内标点提示
支持音频提示
- [ ] 17. 英文切换支持
- [ ] 18. 图片上传预览失败

### bug
- [ ] 24. dsh后端中断后卡住，在bash执行情况下。
- [ ] 25. [#2](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/2) 解决 node use env 的问题（与 #7 proxy 加载相关）
- [ ] 26. [#5](https://github.com/MmMmaru/dsh-vscode-sidebar/issues/5) 对话内依然显示 ide 上下文注入内容
- [ ] 28. 删除候选发送列表部分时候出现无效

### 美化
- [ ] 29. 优化目前悬浮窗口效果  
淡化边框，增加阴影，增加圆角，增加渐入渐出动画
- [ ] 30. 优化markdown解析字体效果，对齐codex style  
- [ ] 31. 优化多session管理并行数字显示，目前不美观。 
- [ ] 32. TODO栏目颜色代表执行与代办
- [ ] 33. 框线淡化，优化前端组件设计
- [ ] 34. ide上下文注入就说：ide上下文注入，后面不需要

### 项目harness
- [ ] 36. 补充使用playwright构建的e2e test。

---

## 已完成（按版本，新→旧）

### 0.0.7（当前版）
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
