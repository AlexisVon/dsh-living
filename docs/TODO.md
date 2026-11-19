# TODO

## 0.2.0（2026-11-19）

- [x] 召回卫生、journal 记忆源、夜间去重、版本与文档同步
- [ ] npm 发布 0.2.0（需 2FA；顺序 protocol → gem-bili / gem-wechat / gem-example → dsh-living）
- [ ] live 宝石库从 npm 0.2.0 重装（当前是 0.1.0 副本 + 手工补丁）
- [ ] 公开镜像 main + `v0.2.0`

## 0.1.0

发布 0.1.0 前的剩余项：

- [x] 补 `repository` / `homepage` / `bugs` / `author` 元数据（`AlexisVon/dsh-living`）
- [x] 已推送 `AlexisVon/dsh-living`：全新初始历史、`v0.1.0`、`dsh-plugin` topic、GitHub Actions CI 通过
- [x] 已发布 npm 0.1.0：protocol / gem-bili / gem-wechat / gem-example / dsh-living（staged publishing + 硬件 2FA 批准）
- [ ] 在 awesome-dsh-plugin 提 PR 收录 `dsh-living`（仓库需满 1 天：2026-11-19 18:15 之后）
- [x] 浏览器 UI 冒烟：Living 面板、宝石库、安装确认、数据与备份卡片均渲染正常（headless Chromium）
- [x] 真实 DSH host（隔离 home）验证：从 npm 安装 B站/微信到 `gems/`，重启后 MCP ready、通道启动、未登录时按预期退避
- [x] live host 迁移验证：`life.db`、宝石数据、凭据、通道与主会话均正常（迁移前备份保留）
- [x] live 已切到宝石库：移除本地 `gemDirs` → 重启 → 从 UI 安装 B站/微信 → 再重启；凭据与通道正常
- [ ] 清理内网/个人路径的历史文档（R4–R17、M6/GEM 验收、DEPLOY-RUNBOOK）
- [ ] 为宝石库补自动化 npm 安装集成测试（当前单测仍用 stub 包管理器）
- [ ] 评估面板“更新宝石”与“彻底删除宝石数据”
