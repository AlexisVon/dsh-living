# R17 · 记忆目录、轨迹时间轴、日报日历

2026-11-18 · UI 观测层。

## 1. 日报：日历 + Markdown

- 日报存 `life.db` 的 `reports` 表：`date / generated_at / live / json / markdown / html`。
- UI 日报页是月历：存在归档日报的日期有实心点；今天没有归档时显示空心点（实时）。
- 默认选中最新一份归档日报；没有归档时选中今天并实时计算。
- 选中日期下方直接渲染 Markdown（含概览、轨迹、作息、行动、成本、异常）。
- 夜睡写前一天归档；`report` RPC 对缺失日期现场生成，不写库。

## 2. 轨迹：统一时间轴

`timeline` RPC 合并：

- 轮次 anchors（startup/event/schedule/auto/night）
- events：消息、`auto_grid`/`auto_hit`、`agent_mark`、睡眠/整理/人格/预算/外发决策
- `raw_segments`（pending/processed）
- `outbox`（sent/pending/review/failed）

UI：

- 24h SVG 轴，按类别分泳道；网格窗口是半透明色带，命中是圆点，自写节点是星形。
- 类别筛选：网格 / 消息 / 轮次 / 记忆 / 人格 / 睡眠 / 系统 / 外发 / 自写。
- 下方事件列表按时间倒序；点开详情。
- 外发不再有独立 tab；待审外发在轨迹详情里放行/拒绝。

## 3. 记忆目录

`memoryBrowse` RPC 支持四个视图：

- `items`：episode/fact，显示描述、重要度、置信度、raw 指针
- `raw`：原始段，显示 session/状态/attempts/错误
- `edges`：`from → relation → to` + note/confidence
- `cold`：冷区关键词与 20 字锚

默认列最近 100 条，不需要先搜索；点条目进入详情（facets、关联边、原始 JSON）。

## 4. Agent 自写节点

新增 `living_mark({text, tag?})`：

- 写 `agent_mark` 事件，时间 = now
- 轨迹里以星形显示，category=`agent`
- 与 journal 分离：journal 是长文本，mark 是时间轴锚点
