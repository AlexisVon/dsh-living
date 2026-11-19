# R16 · 三层记忆：raw / normalized / graph

2026-11-18 · schema v9 · 一个 SQLite，三层表（v8 另加 reports 日报表）。

## 1. 分层

| 层 | 表 | 写入时机 | 说明 |
|---|---|---|---|
| raw | `raw_segments` + `events` | rest / sleep | 半规格化会话快照；events 仍是实时账本 |
| normalized | `episodes` / `facts` + `facets` | 夜睡 | 模型整理；`memory_items` 是两者的统一视图 |
| graph | `memory_edges` | 夜睡 | 条目之间的有向三段式关系 |

`raw_segments.payload` 保存 `{source, messages}`：优先从 session 文件提取 user/assistant/tool，找不到文件时退化为 events。raw 段按 session id 幂等，不重复采集。

## 2. 整理管线

```
rest:  capture raw -> episodes 轻量聚类 -> rotate
sleep: capture raw -> 处理 pending raw（模型）-> facets -> edges -> 降级/人格/日报/rotate
```

- 模型整理走 `living-memory` 专用 preset（无工具、120s 超时），提示词见 `memory-extract.mjs`。
- 输出是固定 JSON：`items` + `edges`；关系词表固定，未知关系回退 `related_to`。
- 每个条目带 `raw_refs` 指回 raw 段；模型重跑不会产生新 raw。
- 模型失败保留 pending，最多尝试 3 次；之后用确定性 fallback（每条 raw 一个 episode）。
- 预算 HOLD 时跳过整理，raw 留到下一次夜睡。
- rest 不做模型整理；白天未整理的 raw 仍在 events / raw 段里。

## 3. 图

```sql
memory_edges(
  from_kind, from_id, relation, to_kind, to_id,
  note, confidence, raw_refs, model, created_at, status
)
```

- `relation` 固定词表：causes / prevents / before / after / supports / contradicts / same_person / same_topic / part_of / resolves / repeats / open_loop / related_to。
- `note` 是一句话解释，不参与主键。
- 边是派生数据，可重建；不是事实源。
- 召回 G1：先按 FTS/刻面选种子，再沿边扩 1 跳，邻居按 `种子分 × 边置信度` 加权进 L0/recall。

## 4. 为什么一个库

raw → normalized → edge 需要同一事务、同一备份、同一写队列；SQLite + FTS5 + recursive CTE 足够。拆三个库会引入跨库指针和恢复问题。

## 5. 已知边界

- raw 采集会同步解压 session 文件；一次 rest/sleep 可能阻塞数百毫秒到数秒。
- rest 仍会生成轻量 event episodes；夜睡有 raw 整理产物时不再跑 events 聚类，只有整理失败/为空时才兜底。
- 模型整理是满上下文调用，token 成本明显；预算 HOLD 会跳过。
- 图的边目前只从夜睡整理产生；不手工编辑，不跨库同步。

## 6. 验收

- schema v9：`raw_segments`、`memory_edges`、`memory_items` 视图、episodes/facts 的 `raw_refs`；v8 reports；v9 persona_docs/journal_entries。
- rest 后有 pending raw；夜睡后 processed 且生成 items/edges。
- 模型失败 3 次后 fallback，raw 仍标记 processed。
- `living_recall` 能通过边带回邻居条目。

## 7. 召回卫生与 journal（2026-11-19）

- 候选池白名单：`message` / `notice` / `agent_mark` / `import`；`round`、`outbound_decision`、`auto_*`、预算/整合事件不进记忆池。L0 的 cue 也只从白名单事件取，审计 JSON 不再成为查询线索。
- journal 是 L5 直接召回条目，只走 R1/R5/R6/R8；有 cue 时归一化的事实/情节排在 journal 前。
- 夜睡把上一整理窗口内的 journal 写成独立 raw（`raw_journal_<entry id>`），模型整理成 episode/fact；归一化条目引用该 raw 后，直接 journal 条目让位，避免同一条内容出现两次。
- 记忆整理提示词明确禁止元记忆（整合时间、items/edges 数、自检线索、预算、网格）与工具审计 JSON。
- 有 cue 时 R3/R4 不能单独让条目浮现；无 cue 的 L0 不变。
