# dsh-vscode-sidebar

DeepSeek harness（dsh）的 VSCode 侧边栏插件。插件只做前端界面，后端能力全部复用本机 dsh web host（loopback，无实例时自动拉起）。

设计文档：`docs/PRD.md`（需求）、`docs/ARCHITECTURE.md`（模块与接口契约）、`docs/PLAN.md`（任务拆分）。

## 目录结构

```
src/
  extension/            # 扩展宿主侧（Node，esbuild 打包到 dist/）
    extension.ts        # 入口：注册 provider 与命令
    host-manager.ts     # dsh host 探测/拉起/版本检查
    dsh-client.ts       # RPC + 双 WS 事件流客户端（断线指数退避重连）
    bridge.ts           # webview ↔ host 消息桥
    sidebar-provider.ts # WebviewViewProvider（注入 media/ 产物）
    protocol/           # vendored 协议类型（源自 deepseek-harness，勿手改）
  shared/bridge.ts      # bridge 消息协议（宿主与 webview 共用，契约冻结）
  webview/              # 侧边栏 React 应用（Vite 构建到 media/）
tests/                  # node:test 单测（esbuild 打包后运行）
.temp/                  # 临时文件（不进 git）
```

## 开发

```bash
npm install            # 安装依赖
npm run typecheck      # 双 tsconfig 类型检查（宿主侧 + webview 侧）
npm run build          # 宿主侧 esbuild -> dist/，webview vite -> media/
npm test               # 单测（打包 tests/ 到 .temp/test-dist 后 node --test）
npm run watch          # 宿主侧 watch 构建
```

调试：VSCode 打开本目录按 `F5`（需 `.vscode/launch.json` 指向 dist/extension.js，或用 `code --extensionDevelopmentPath=.`),侧边栏活动栏出现 DeepSeek 图标，打开面板即触发 `ready → init` 握手，页面显示当前工程 cwd 与 host 版本。

## 配置

- `dsh.port`（默认 3080）：host 探测起始端口，被占用顺延（3080..3089）。
- `dsh.keepHostOnExit`（默认 false）：VSCode 退出时是否保留插件拉起的 host。

## 冒烟验证（真实 dsh）

```bash
# 终端 1：拉起真实 host（首次 npx 下载较慢）
npx -y @deepseek-ai/dsh@0.1.0-rc.6 web --host 127.0.0.1 --port 3080

# 终端 2：先放 .temp/smoke.ts，再
npm run smoke
```

smoke 脚本用真实的 HostManager/DshClient 完成 probe → connect → `host.describe` / `session.list` RPC → mux/host WS 帧接收 → 杀 host 验证重连。

## 协议契约（给 W2–W6 的并行开发约定）

- bridge 消息类型见 `src/shared/bridge.ts`（对应 ARCHITECTURE.md 第 3 节）：
  - webview → 宿主：`ready`、`rpc`
  - 宿主 → webview：`init`、`rpc-result`、`event`、`host-status`、`command`（W1 新增，工具栏命令转发）
- webview 侧只用 `src/webview/api.ts` 的 `waitInit / rpc / onEvent / onHostStatus / onCommand` 访问后端，禁止直接 fetch/WS。
- dsh 协议类型以 `src/extension/protocol/` 为准（vendored 自 deepseek-harness commit `47f9438`，文件头有来源标注；升级 dsh 时重新拷贝对齐）。
- wire 格式要点：unary RPC 是 `POST /api/<method>`（ClientRequest 信封，回 ServerResponse）；审批/提问应答是 `POST /api/respond`（ClientResponse 回显帧 rpcId）；事件流是两条下行 WS `/api/events.mux` 与 `/api/events.host`（ServerRequest 信封，payload 为 MuxFrame/HostFrame）。

## 打包

```bash
npm run package        # 需要 npm i -g @vscode/vsce；产出 *.vsix 本地安装
```
