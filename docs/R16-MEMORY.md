# R16 · 三层记忆：raw / normalized / graph

2026-11-18 · schema v10 · 一个 SQLite，三层表（v8 reports；v10 memory_vectors）。

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
sleep: capture raw + 本区间 journal raw -> 处理全部 pending raw（模型；journal 6/批，其余 3/批）-> facets -> edges -> 降级/人格/日报/rotate
```

整理单元是“上次整理（sleep/rest）到现在”，不是自然日。单批卡住会跳过并写 `memory_extract_failed`；raw 未清空时不自动演化，写 `persona_evolve_skipped`（raw_pending），等 UI 手动触发。

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
- session 文件缺失/不可读时 raw 退化为 events（没有 assistant 正文、reasoning、tool 结果），并在轨迹写 `raw_fallback` 事件（sessionId / source / messages / reason）；不静默。
- night 一次处理全部 pending raw（journal 6 条/批，session/night 3 条/批）；单批调用超时/异常跳过并写 `memory_extract_failed`，不阻塞其余批次；输出 JSON 解析失败先同轮重试一次（写 `memory_extract_retried`，两次 token 都计入预算），仍失败才留 pending。仍有 pending 只记录失眠，不再跳过 self（D-59）；状态页“手动睡一觉”可重试。
- self 由主会话在睡前自由环节写（D-59）：capture 之后、normalize 之前，`living_write_self` 只暂存一版，环节结束统一提交；不再有 `SELF_EVOLVE_MAX_TOKENS` 子 agent 与注入式 digest。
- 状态页“手动睡一觉”异步启动，进度弹窗显示采集 / 睡前自由环节 / 整理 / 向量补齐 / 宝石更新 / 收尾（向量补齐带进度条）；状态卡显示上次整理成功 / 失眠（raw 剩余 N）/ 自由环节结果；失眠或自由环节失败写 silent `change` 事件（agent 下轮可见，不叫醒），阻塞失败另存 `sleep.lastError`。手动 sleep 可选 `unlimited`（跳过预算闸与自由环节硬顶、仍计 token）。
- rest 仍会生成轻量 event episodes；夜睡有 raw 整理产物时不再跑 events 聚类，只有整理失败/为空时才兜底。
- 模型整理是满上下文调用，token 成本明显；预算 HOLD 会跳过。
- 图的边目前只从夜睡整理产生；不手工编辑，不跨库同步。

## 6. 验收

- schema v10：`memory_vectors`；v9 `raw_segments`、`memory_edges`、`memory_items` 视图、episodes/facts 的 `raw_refs`；v8 reports。
- rest 后有 pending raw；夜睡后 processed 且生成 items/edges。
- 模型失败 3 次后 fallback，raw 仍标记 processed。
- L0/召回能通过关系边带回邻居条目（agent 侧只保留 `living_recollect`）。

## 7. 回想接口（2026-11-19，D-57 倒置）

`living_recollect` 是唯一的慢路径入口，参数只有 `question` / `cue` / `mode` / `detail`，**不收时间范围**。一个只读子 agent 先调 `living_memory_segments({key})` 预测最多 3 个时间区段，再对每个区段用 `living_memory_scan({from,to})` 扫描，必要时 `living_memory_get` 展开单条，最后返回 `summary` + `primary`/`backup` + `scanned`/`gaps`。

- 区段：按 6h 间隔聚类；每段宽度 ≤ `maxSegmentDays`（默认 7），超宽裁到密度最高的窗口；置信度低于 `minConfidence`（默认 0.35）的段不返回，所以可能少于 3 段甚至为空。
- 兜底：embed 不可用、区段为空或段内没证据时，子 agent 扫最近 `fallbackDays` 天（默认 3，可配置）。
- 证据：`detail:'full'` 时 `memory_get` 可经 `rawRefs` 展开 user/assistant/event 原文，不含 reasoning/tool。`ok:false` 是合法结果；没有证据就不给答案。
- 工具面：`living_memory_segments` / `overview` / `scan` / `get`；由 `tools.restrict` 收口，MCP/文件/网页全部拒绝。主 agent 不再注册 `living_recall` 或 `living_memory_*`，只留 `living_recollect`。
- 硬边界：`recollectTimeoutMs` 默认 120s；token 计入当日预算；每次写 `recollect` 事件（ok/tokens/scans/candidates/segments/segmentSource）。

### 7.1 向量索引与配置

`state['embed.config'] = {url, model, fallbackDays, minConfidence, maxSegmentDays, updatedAt}`；`state['embed.index'] = {model, digest, signature, url, dim, updatedAt}` 记录当前向量库属于哪套模型；`signature` 用 Ollama 的模型 `digest`，没有 digest 时退回 `模型名@URL`。默认 URL `http://127.0.0.1:11434`；模型默认取 `/api/tags` 里第一个有 `embedding` 能力的。记忆页配置卡可刷新模型、测试、保存、校验补齐；签名变化即清空 `memory_vectors` 并弹窗询问是否立即重建（带进度条），不立即重建则等 sleep 补齐；URL 变了但 digest 相同则沿用向量。

`memory_vectors(source, id, ts, text, model, dim, hash, vector)` 保存 events / journal / items 的 800 字头；`model` 存的是签名（digest；没有 digest 时 `模型名@URL`），查询按签名过滤。sleep 做全量补齐：扫描 30 天窗口，按 hash 跳过未变行，每批 16 条落库，完成后删掉窗口外旧向量；首次约 4 分钟（live 约 522 行），之后只处理新增。区段预测在后台重建未跑时每次懒索引最多 8 条。查询只取当前 `embed.index.model` 的向量，用余弦暴力；L0/recall 不走向量。置信度是未校准的绝对分，只用于过滤。

## 8. 召回卫生与 journal（2026-11-19）

- 候选池白名单：`message` / `notice` / `agent_mark` / `import`；`round`、`outbound_decision`、`auto_*`、预算/整合事件不进记忆池。L0 的 cue 也只从白名单事件取，审计 JSON 不再成为查询线索。
- journal 是 L5 直接召回条目，只走 R1/R5/R6/R8；有 cue 时归一化的事实/情节排在 journal 前。
- 夜睡把上一整理窗口内的 journal 写成独立 raw（`raw_journal_<entry id>`），模型整理成 episode/fact；归一化条目引用该 raw 后，直接 journal 条目让位，避免同一条内容出现两次。
- 记忆整理提示词明确禁止元记忆（整合时间、items/edges 数、自检线索、预算、网格）与工具审计 JSON。
- 有 cue 时 R3/R4 不能单独让条目浮现；无 cue 的 L0 不变。

## 9. 召回排序：相关度分级与元记忆降档（2026-11-19，D-58）

- 有 cue：episode `title` / fact `subject` / `target` 命中 = 1.0；正文前 40 字 = 0.75；正文其余（含 facets）= 0.45；多 token 用 idf 加权覆盖，df 在候选池现数（约 600 条，单次 recall 多 ~0.6ms）。
- 相关度按 0.05 分带；sal / rec / rehearsal / confidence / emotion / strength / journal 折价只进带内有界 tie-break（< 0.05），结构上不能跨档。
- 元记忆由强字段判定：episode title / fact subject（`agent_mark` 用正文）命中作者有限词表（元记忆、自检、校准、记忆整合、记忆系统、记忆检索、记忆注入、注入精简、记忆区、抽样查询、recall 排序/检索/捞、memory.items、lastConsolidationAt、raw_pending、persona_evolve）；**只降一档（相关度 −0.05）但保留**，不删除。正文提及不算，避免误伤内容型记忆。G1 关系边不回捞 meta 条目。
- 降一档而不是归零：更正类条目（如“旧结论不再成立”）常常只剩 meta 副本，归零会把它埋掉；降一档后它在高相关时仍能排到 #1，同时同相关度的非 meta 条目仍排在它前面。
- journal 仍只走 R1/R5/R6/R8；0.65 折价只作用于 tie，相关度更高时能排在低相关事实前。
- 无 cue 的 L0 走原加权路径，逐条不变。
- 验收：单 token cue 不再全部并列为 sem=1；9 个真实 cue 的 gold@8 / MRR 相对旧实现无一下降；“米糕”由状态 episode 变为身份事实 + 主人消息 + 家庭介绍 journal 在前。
- 上述数值（meta 降档数、journal 折价、分级/带宽、显著度门槛、topK、半衰期、整理批大小等）可由 Config `memoryParamsJson` 覆盖；volatile，改后即时生效，越界钳制，默认值与 0.3.9 行为一致。结构规则（meta 强字段判定、band 与 tie 的派生、idf/分级算法）不开放。
