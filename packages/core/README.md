# dsh-living

`dsh-living` 的核心包：一个按设定活着的 agent 运行时。

**状态**：v0.3.13。

## 它做什么

| 部件 | 职责 |
|---|---|
| 时钟 | 10–60min 网格 · 热冷时域 · 30/60s 逐点抽奖 · 日程表 · rest/夜睡 |
| 记忆 | raw → episodes/facts+facets → 关系图三层 · 夜睡模型整理 · G1 图召回 · 降维遗忘 |
| 人格 | `charter`（只读）· `self`（每晚重写，life.db 版本化）· `journal` |
| 预算与审计 | 日预算 + 上下文保险 · 外发审计 · 公网发声强制过限制层 |
| 观测 | 锚点（8 列）· 解析器 · 每日报表（存入 life.db） |
| WorldGem | 从 living 自己的目录加载宝石 → 挂 MCP / 绑事件端点 / 注入 skill 段 |

## 安装

```sh
dsh plugin --profile <name> add dsh-living
```

安装后在 **Living → 宝石 → 添加宝石** 从内置宝石库安装 B站 / 微信 / 小佩喂食器。宝石是普通 npm 包，下载到 `$DSH_HOME/living/gems`，不进入 DSH 的插件列表。

## 目录

```
$DSH_HOME/living/
  data/life.db          # 记忆、人设、日报、外发
  data/gems/<id>/       # 宝石配置、凭据、media
  data/backups/         # 备份与导入前快照
  workspace/            # agent cwd
  gems/                 # 宝石代码（可重下）
```

**配置 → 数据与备份** 可导出/导入记忆库；导入在下次宿主启动时替换，替换前自动备份当前库。

## 文档

- [架构](https://github.com/AlexisVon/dsh-living/blob/main/docs/ARCHITECTURE.md) — 它是什么
- [部署](https://github.com/AlexisVon/dsh-living/blob/main/docs/DEPLOY.md) — 怎么跑
- [决策记录](https://github.com/AlexisVon/dsh-living/blob/main/docs/DECISIONS.md) — 为什么不是别的

## 依赖

- `dsh-living-protocol` —— 宝石协议（清单结构、channel 端点、失败码）
- 可选：`dsh-mcp-client`（宿主已内置）用于挂载宝石的 MCP
- 运行环境以 DSH 0.2.2 为准：Node >= 24.9（包内 `engines.node` 仅为兼容声明）

## 它不做什么

不接管你日常的 coding 会话、不替你做决定、不与第二个记忆插件共存。
