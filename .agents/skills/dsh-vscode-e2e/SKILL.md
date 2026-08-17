---
name: dsh-vscode-e2e
description: 为 dsh-vscode-sidebar 插件编写、运行、扩展与调试 Playwright E2E 测试时使用。覆盖本插件 E2E 架构（真实扩展宿主跑在 Node + 真实隔离 dsh host）、harness API、用例写作约定与踩坑清单。当用户要求"补 E2E 测试""跑 E2E""E2E 挂了排查"或需要为插件新功能加浏览器级回归时使用。
---

# dsh-vscode-sidebar Playwright E2E 测试

本插件的浏览器级 E2E 套件：**真实扩展宿主代码跑在 Node，Playwright 页面加载真实构建产物，后端用真实隔离的 dsh host**。目标是在不启动真实 VSCode 的前提下，让扩展宿主（Bridge/DshClient/HostManager/OverlayRetention）与 webview UI 全链路真实执行。

## 1. 架构总览

```
Playwright Chromium 页面（加载真实构建产物 media/main.js）
   │  页面内 acquireVsCodeApi stub（WebSocket ↔ Node，消息队列防 ready 早发）
   ▼
Node 测试宿主（esbuild bundle，alias: vscode → tests/e2e/vscode-stub.ts）
   │  100% 真实代码：Bridge + OverlayRetention + DshClient + HostManager
   ▼
真实 dsh host（DSH_HOME=临时目录[拷贝 ~/.dsh/settings.yaml + .credentials.yaml]，
             自 spawn、自 kill、端口 3200 起探测空闲；永不碰 3080）
```

关键点：

- **vscode stub**（`tests/e2e/vscode-stub.ts`）：只实现被捆绑代码用到的 `vscode` 表面——`window.activeTextEditor`（可编程）、`window.showErrorMessage/showWarningMessage`（记录）、`window.createOutputChannel`、`workspace.workspaceFolders`（可编程）、`Disposable`。注意 `activeTextEditor` 无编辑器时是 `undefined`（不是 null，对齐真实 API）。esbuild alias：`node esbuild.config.mjs --e2e`。
- **测试钩子（接口对齐）**：`DshClient.emitMuxFrame(frame, rpcId?)` / `emitHostFrame(frame)` 走与 WS 帧完全相同的分发路径（`trackPending` 登记待应答表 + 监听器扇出），注入源不同但下游无差别。注入帧的应答会被真实 host 以未知 rpcId 拒绝（`harness.errorNotifications()` 会记录"DSH 应答失败"——这是预期行为）。
- **host 隔离**：`process.env.DSH_HOME = mkdtemp(...)`，拷入用户 settings/credentials 使真实模型调用可用；host 从 3200 起探测空闲端口 spawn，结束只 kill 自己 spawn 的进程并删临时目录。**端口 3080 是 DeepSeek Harness 后端，禁止探测/连接/杀（AGENTS.md）**。

## 2. 文件布局

```
tests/e2e/
  vscode-stub.ts        # vscode 模块 stub（esbuild alias 目标）+ 测试控制入口
  harness.ts            # host 生命周期 + 静态服务 + WS 桥 + 控制 API（--e2e 打包）
  e2e.spec.ts           # 主用例：五条修复回归 + 核心对话闭环 + IDE 自动注入
  switch-repro.spec.ts  # 提问切换/重放/真实应答闭环（含 live 模型用例）
playwright.config.ts    # workers=1、串行、失败截图/trace 到 .temp/e2e-artifacts
esbuild.config.mjs      # --e2e 目标：打包 harness + 生成 harness.d.mts（类型重导出）
```

## 3. 运行

```bash
npm run test:e2e        # 全量：build:webview → esbuild --e2e → playwright test
# 单测/子集（先手动 build + --e2e 再跑）：
npm run build:webview && node esbuild.config.mjs --e2e
LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu npx playwright test -g "提问"
# 失败产物：.temp/e2e-artifacts/<test>/error-context.md + trace.zip + 截图
```

- chromium 依赖库需要 `LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu`（本机无 root 环境，lib 已解包在 .temp/libs）。
- 改了 harness/vscode-stub 后必须 `node esbuild.config.mjs --e2e`；改了产品代码后必须 `npm run build:webview`（页面加载的是构建产物）。

## 4. Harness API（写用例时用）

worker 级 fixture（**必须用第二个泛型参数**，否则类型报 scope 错误）：

```ts
import { test as base, expect } from 'playwright/test'
import { startHarness, type Harness } from '../../.temp/e2e-dist/harness.mjs'

const test = base.extend<{}, { harness: Harness }>({
  harness: [
    async ({}, use) => {
      const h = await startHarness()
      try { await use(h) } finally { await h.stop() }
    },
    { scope: 'worker', auto: true },
  ],
})
```

常用 API：

| API | 说明 |
|---|---|
| `harness.pageUrl` | 页面地址（http 服务 + /ws 桥同端口） |
| `harness.workspacePath` / `foreignPath` | 当前工作区路径 / 外部目录（隔离测试用） |
| `createSession(cwd, title?)` | 真实 RPC 建会话（可改名） |
| `emitMux(frame, rpcId?)` / `emitHost(frame)` | 注入帧（走真实分发路径） |
| `setActiveEditor(editor \| null)` | 设置 stub 活动编辑器（IDE 注入测试） |
| `errorNotifications()` | 扩展宿主经 stub 记录的错误通知 |

页面稳定选择器：`.session-row`、`.composer-input`、`.msg-user-bubble`、`.md-body`、`.turn-stats-row`、`.ovl-card[data-question-session="..."]`、`.chat-list-dropdown .session-row`、IDE 上下文开关按钮（`aria-label="关闭/开启 IDE 上下文注入"`，`composer-chip-active` 表示开）、`.ctx-row`（context-injection 提示行，断言时用 `hasText: 'ide：'` 收敛——host 自己的 system-prompt 上下文行也在）、`.composer-toast`。注入的 IDE 块（`### 选中代码（…）`/`### 当前文件：…`）**只在 prompt 里、不进用户气泡**——气泡由 `findIdeBlock` 剥离，另渲染一条 `ide：…` 提示行。

## 5. 写作约定与踩坑清单（重要）

1. **会话行只在无活动会话时渲染**（activeSessionId === null）；进入会话后要看完整列表必须开历史下拉（`.chat-list-header .icon-btn` 第一个是时钟按钮）。
2. **QuestionPanel 选项是 `role="radio"`**，要用 `getByRole('radio', { name: ... })`，`getByRole('button')` 匹配不到。
3. **retention 清理**：注入提问并用 UI 应答后，真实 host 会拒绝合成 rpcId，`question/resolved` 不会来——必须用同一个 rpcId 补发 `emitMux({ type:'question/resolved', ... })` 清 OverlayRetention，否则下一个用例的 init 会重放旧提问并自动选中旧会话（列表被隐藏，用例连锁失败）。**真实提问用例（live）结束前必须用 UI 应答掉**，同样原因。
4. **live 模型用例**：只做结构断言（有节点/有文本/回合结束），不断言输出内容；模型未在窗口内触发 ask 时用 `testInfo.skip(true, '原因')` 跳过而非失败（自然触发不可控，约定如此）。
5. **用例共享一个 worker/host**：会话会累积，计数断言用相对值（before/after），会话标题用唯一前缀（T1-/T2-/SW-/RL- 等）。
6. **respond 链路断言**：注入帧应答后 `harness.errorNotifications()` 应包含"DSH 应答失败"（真实 host 拒绝合成 rpcId，证明 respond 走完了真实链路）。
7. 页面适配器会把 WS 打开前的消息排队（应用启动即发 `ready`），不要改动该逻辑。
8. `testInfo.skip(condition, description)` 签名是 (boolean, string)。

## 6. 新增一个用例的步骤

1. 确定场景归属：确定性（注入帧/列表/UI 交互）→ `e2e.spec.ts`；live 模型（ask/应答/流式）→ `switch-repro.spec.ts`（或新 spec）。
2. 用 `harness.createSession` 准备会话（需要"外部工作区"帧用 `foreignPath`）。
3. 涉及 IDE 内容用 `harness.setActiveEditor({ document: { getText, uri: { fsPath } }, selection: { isEmpty } })`。
4. 需要确定性帧用 `harness.emitMux(...)`（回答后补发 resolved 清理）。
5. 涉及真实模型：结构断言 + 超时未触发 skip。
6. `npm run build:webview && node esbuild.config.mjs --e2e && LD_LIBRARY_PATH=... npx playwright test -g "用例名"`。
7. 全量 `npm run test:e2e` 确认无 retention 串扰（顺序执行）。

## 7. 排障

- 失败先看 `.temp/e2e-artifacts/<test>/error-context.md`（页面快照 + 调用栈）与截图。
- 用例连锁失败（找不到本用例建的会话行）→ 大概率是上一个用例的 retention 残留，检查 resolved 清理。
- 页面空白/无 init → WS 未通或 `ready` 早发丢失（检查适配器队列）或 build:webview 产物过期。
- 改 harness 后行为没变 → 忘了 `node esbuild.config.mjs --e2e`。
