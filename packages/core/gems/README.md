# 内置宝石目录

`catalog.json` 是 Living → 宝石 → 添加宝石 的唯一来源。字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 宝石 id，小写字母开头，与 `worldgem.json` 一致 |
| `name` | 是 | 显示名 |
| `package` | 是 | npm 包名；安装时从 registry 下载 |
| `version` | 是 | 最低版本 floor；安装/升级目标 = max(floor, registry `latest`)，永不自动降级 |
| `description` | 否 | 列表里的一行说明 |
| `repository` | 否 | https 仓库链接；市场详情页用 |
| `registry` | 否 | https registry；留空用 pnpm/npm 配置 |
| `capabilities` | 否 | 布尔能力表，UI 原样展示 |

发布检查：

1. 先发布 `packages/gem-*` 的 `package.json` 版本；live 夜间会自动升到 registry `latest`，宝石修复不再需要发 core；
2. 只有 core 确实需要某个最低宝石版本时，才把这里的 `version` 抬到那个 floor；
3. 跑 `node scripts/selfcheck.mjs` 和 `pnpm pack` 确认目录随 core 打包。

目录只允许官方宝石；社区宝石走 `gemDirs` 或以后的远程目录，不在 UI 里搜索任意 npm 包。
