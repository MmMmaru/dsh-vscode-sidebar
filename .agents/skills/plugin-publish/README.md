# plugin-publish

本技能负责 dsh-vscode-sidebar 的发版（vsce）。完整说明见 [SKILL.md](./SKILL.md)：

- 发版前置检查（版本/CHANGELOG/构建/回归）
- 打本地 VSIX：`npm run package`
- 发布 Marketplace：`vsce login XuRongSheng` → `vsce publish`
- 常见失败排查与发版清单
