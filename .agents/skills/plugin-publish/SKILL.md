---
name: plugin-publish
description: 使用 vsce 发布 dsh-vscode-sidebar 到 Visual Studio Marketplace（或打本地 VSIX）时使用。覆盖发版前置检查、版本号管理、vsce 命令、登录与 PAT、常见失败与回滚。当用户说"发版""发布""vsce 如何发版"或要出新的 VSIX 时使用。
---

# 用 vsce 发版 dsh-vscode-sidebar

本插件发布链路：`npm run build`（esbuild + vite 产出 `dist/extension.js` 与 `media/*`）→ `vsce package` 打 VSIX → 本地安装 或 `vsce publish` 上 Visual Studio Marketplace（publisher: `XuRongSheng`）。

## 0. 发版前置检查（发布前逐项确认）

- `package.json`：`version` 与 `CHANGELOG.md` 顶部版本号一致；`publisher`、`repository`、`license`（LICENSE 文件存在）、`icon`（resources/icon.png）、`engines.vscode` 均已配置
- `README.md` 存在（Marketplace 页面展示用）；`CHANGELOG.md` 已为本版本写好条目
- `vscode:prepublish` 脚本存在（`npm run build`），`vsce publish` 会自动先执行它，保证发布产物是新鲜构建
- `.vscodeignore` 只排除源码/文档/测试，运行产物（dist、media、resources、LICENSE、README、CHANGELOG）必须保留
- 本地回归通过：`npm run typecheck && npm test`；涉及 UI 的改动再跑 `npm run test:e2e`
- **发布前永远不手动改已安装扩展目录**（`~/.vscode-server/extensions/xurongsheng.dsh-vscode-sidebar-*`）：同 id 高版本 VSIX 安装会自动替换低版本并标记 obsolete；手工拷贝会导致视图冲突（`View provider for 'dsh.sidebar' already registered`）等脏状态

## 1. 打本地 VSIX

```bash
npm run package          # 等价 vsce package，产出 dsh-vscode-sidebar-<version>.vsix
code --install-extension dsh-vscode-sidebar-0.0.3.vsix   # 本地安装
```

## 2. 发布到 Marketplace

### 2.1 首次：创建 PAT 并登录

1. 打开 <https://marketplace.visualstudio.com/manage>（用 Azure DevOps 账号登录，确保是 publisher `XuRongSheng` 的所有者）
2. 新建 Personal Access Token：组织选 `all accessible organizations`，范围勾选 **Marketplace > Acquire / Manage**
3. 登录：

```bash
npx vsce login XuRongSheng     # 粘贴 PAT，token 会存到 ~/.vsce/ 下
```

### 2.2 发布

```bash
# 方式 A：发布当前 package.json 版本（推荐，版本已在本地定好）
npx vsce publish --no-git-tag-version

# 方式 B：让 vsce 自动升版本号（patch → 0.0.4），并打 git tag v0.0.4
npx vsce publish patch

# 发布前先看会打进包的文件（排查 .vscodeignore 漏配）
npx vsce ls
```

`vsce publish` 会：执行 `vscode:prepublish`（即 `npm run build`）→ 按 `.vscodeignore` 打包 → 上传到
Marketplace → 若指定了 `patch/minor/major` 会自动 bump `package.json` 版本并打 git tag。

### 2.3 发布后

- 到 <https://marketplace.visualstudio.com/items?itemName=XuRongSheng.dsh-vscode-sidebar> 检查扩展页
  （首次发布后页面可能需要几分钟生效）
- 回填 `CHANGELOG.md`（若用方式 B 自动 bump，记得同步 changelog 的版本号与日期）

## 3. 常见失败与处理

| 症状 | 原因 / 处理 |
|---|---|
| `Publisher 'XuRongSheng' is not known` | 未登录或 PAT 权限不对；重新 `vsce login` |
| `Error: getaddrinfo ENOENT marketplace.visualstudio.com` | 网络/代理问题；确认能访问 Azure 域 |
| `LICENSE` 缺失报错 | Marketplace 要求许可证文件；仓库根有 `LICENSE`（MIT） |
| 打包体积告警（media/main.js 700KB+） | 只是 warning，可忽略；vsce 提示可配 `extensionKind` 等 |
| 装新 VSIX 后视图还是旧行为 | 扩展窗口未重载：`Developer: Reload Window`；或旧版本目录残留（检查
  `~/.vscode-server/extensions/` 下是否有同名不同 publisher 的旧扩展抢视图 id，删掉） |
| 想要撤销发布 | `npx vsce unpublish XuRongSheng.dsh-vscode-sidebar`（会删除扩展页） |

## 4. 发版清单（快速核对）

1. `package.json` version + `CHANGELOG.md` 顶部一致
2. `npm run typecheck && npm test` 绿；UI 改动跑 `npm run test:e2e`
3. `npm run package` 本地产物可安装、功能冒烟通过
4. `npx vsce ls` 检查包内容
5. `npx vsce publish --no-git-tag-version`（或 `vsce publish patch`）
6. 验证 Marketplace 页面 + 全新安装冒烟
