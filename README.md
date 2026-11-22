# dsh-living

[English](README.en.md) | 中文

一个**按设定活着**的 agent 运行时：有自己的作息、记忆和人格，通过 **WorldGem** 接入真实世界。

> 状态：v0.3.13。核心、协议与三颗真实宝石（B站 / 微信 / 小佩喂食器）已实现；宝石从 npm 下载到 living 自己的目录，不占用 DSH 插件列表。

## 它是什么

- **时钟** —— 10–60min 网格 + 热冷时域 + 自己排的日程 + 每天一次夜睡（默认 03:30，可配）
- **记忆** —— 分层 + 三种外观（热区注入 / 温区检索 / 冷区只剩线索）；遗忘是**降维**，不是删除
- **人格** —— `charter`（只读）+ `self`（睡前自由环节重写，life.db 版本化）+ `journal`
- **世界** —— WorldGem：一颗宝石交出**能力**（MCP）、**事件**（ingest / outbox）和一份**教模型怎么用它的说明**（skill）

## 安装

从 DSH 插件市场安装 `dsh-living`（唯一需要装成插件的包）：

```sh
dsh plugin --profile <profile> add dsh-living
```

宝石不在市场里逐个安装。装好 living 后，打开 **Living → 宝石 → 添加宝石**，从内置宝石库选择 B站 / 微信 / 小佩喂食器；living 会从 npm 下载到自己的目录：

```
$DSH_HOME/living/
  data/        # life.db、宝石配置/凭据/媒体
  workspace/   # agent 的工作目录
  gems/        # 宝石代码（可随时重下）
```

安装或卸载宝石后重启宿主生效。卸载宝石只删除代码与 media 缓存，保留配置、凭据和 `life.db` 里的记忆。

## 数据与备份

记忆库是 `$DSH_HOME/living/data/life.db`（默认 `~/.dsh/living/data/life.db`），包含事件、三层记忆、人格、日记、日报与外发记录。旧版的 `charter.md` / `self.md` / `journal/` 会在启动时迁入 `data/legacy/` 并一次性导入。

**Living → 配置 → 数据与备份** 提供：

- **备份记忆**：生成一致快照（`VACUUM INTO`），通过浏览器的保存位置选择器导出 `.db`；文件是明文 SQLite，含人设与记忆，请妥善保存。
- **导入记忆**：选择 `.db` 上传并校验（SQLite 头、`integrity_check`、schema 版本、必需表）。校验通过后暂存，**重启宿主时**先把当前库备份到 `data/backups/pre-import-*`，再替换。只做覆盖恢复，不合并。
- 更高 schema 的库会被大声拒绝，不会静默打开。

卸载 `dsh-living` 插件时 DSH 只移除插件代码；`data/` 与 `workspace/` 不会自动删除。

## 它不是什么

- 不是通用助手，不接管你日常的 coding 会话
- 不替你做决定；公网发声强制过限制层
- 不与第二个记忆插件共存——记忆只有一个所有者

## 仓库结构

```
packages/
  core/          → npm: dsh-living              运行时
  protocol/      → npm: dsh-living-protocol     宝石协议（清单 / 端点 / 失败码）
  gem-example/   → npm: dsh-gem-example         参考宝石
  gem-bili/      → npm: dsh-gem-bili            B站宝石（能力 + 私信 + 历史私信 + 公开互动）
  gem-wechat/    → npm: dsh-gem-wechat          微信宝石（独立 iLink bot，文本/图片/文件私聊）
  gem-petkit/    → npm: dsh-gem-petkit          小佩喂食器（D4H 状态/出粮/记录/看图）
docs/            架构与立项
scripts/          selfcheck / 回测等维护脚本
spikes/          上线前验证脚本
```

一个仓库，多个包。协议独立成包是必须的（宝石作者要依赖它），但不必独立成仓库。

## 文档

- [架构](docs/ARCHITECTURE.md) —— 它**是什么**：时钟、记忆、WorldGem、观测面、失败降级
- [决策记录](docs/DECISIONS.md) —— **为什么不是别的**：47 条决策、被否掉的方案、翻案条件。接手前先读这份
- [工作协定](docs/WORKING-AGREEMENT.md) —— 谁写、谁评审、红线、交接贴什么
- [立项](docs/PROJECT.md) —— 目标、非目标、分期与验收、风险

## 快速了解三个设计原则

1. **自动唤醒按网格配额**：10–60min 网格、30/60s 抽一次；抽中才叫模型，running 期间的点作废
2. **窄口靠结构**：工具面由 preset 决定，不靠提示词嘱咐
3. **账本不许模型写**：观测事实由代码与解析器产出，它自己的日记单独一区

## 许可证

MIT
