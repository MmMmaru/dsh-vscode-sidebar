# PROGRESS

### 08-15 02:30
- W0+W1 完成：VSCode 扩展脚手架（esbuild 宿主侧 + Vite webview 侧）、vendored 协议类型（deepseek-harness commit 47f9438）、HostManager/DshClient/Bridge/SidebarProvider 全实现。
- 单测 10 个全过（node:test，fake host 覆盖端口顺延、rpc id 配对、错误传播、审批/提问应答、断线重连）。
- 真实 dsh 冒烟通过（.temp/smoke.ts）：host.describe / session.list / session.create 成功，收到 host/session-added 与 mux session/projection 帧；杀 host 后客户端报 down，HostManager spawn 重启后指数退避重连恢复 ready。
- 关键发现：npm 发布的 @deepseek-ai/dsh@0.1.0-rc.6 的 host.describe 自报版本为 "0.0.1"（非包版本），checkVersion 兼容前缀设为 ['0.1.0-rc.', '0.0.1']。
- WS 事件流真实路径为 /api/events.mux 与 /api/events.host（点分式），已修正 ARCHITECTURE.md 第 1 节。
- bridge 契约新增 command 消息（宿主→webview，工具栏命令转发），已同步 ARCHITECTURE.md 第 3 节。
- npx 冷启动拉起 dsh 约 4.5 分钟，spawn 就绪超时设为 600s。
