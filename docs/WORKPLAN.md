# 工作任务节点与里程碑（WORKPLAN）

2026-11-17 · 状态：执行中 · 本文是**施工顺序的唯一依据**（ARCHITECTURE 说是什么，DECISIONS 说为什么，本文说先做什么）。

## 0. 角色调整（用户 2026-11-17 授权）

| 事项 | 原协定 | 现在 |
|---|---|---|
| 任务拆分 | 契约守门出任务卡 | **实现方自行拆分**，写入本文 |
| 契约评审 / 宿主内探针 / 验收 | 契约守门（DSH 侧） | 不变 |
| 合入拍板 | 用户 | 不变 |

技术约束若与实现冲突，实现方可直接修订；**外部契约**（协议字段、端点、失败码）的变更仍走 DECISIONS 先改后写的流程。

## 1. 里程碑总览

| # | 里程碑 | 交付 | 退出条件（可验证） | 预估 |
|---|---|---|---|---|
| M0 | 工程基线 | 文档对账、工作区脚本、预算默认值草案 | `pnpm -r test` 全绿；无过期状态描述 | 0.5d |
| M1 | 纯逻辑内核 | `clock.mjs` + `budget.mjs` | 心跳分布/冷却/退避/预算闸的测试全绿 | 2d |
| M2 | 持久层 | `db.mjs` + `store.mjs` | 单写队列并发测试、重启恢复测试全绿 | 2d |
| M3 | 记忆闭环 | `layers` / `recall` / `memory` / `consolidate` / `import` | 分层与衰减单测、L0 回测脚本可跑 | 4d |
| M4 | 闸门与人格 | `audit.mjs` + `persona.mjs` | 规则表回归测试；self 版本可回滚（life.db） | 3d |
| M5 | 宝石协议落地 | `gems.mjs` + channel 端点 + gem-example | 假宝石端到端（ingest → outbox → ack） | 3d |
| M6 | 宿主内闭环 | S1 探针 + `index.js` + preset + `round.mjs` | **P1 验收**：24h 无人干预 ≥3 次自主行动、0 超预算、重启 next_wake 不丢 | 3d |
| M7 | 观测面 | 解析器 + 日报 + 只读查询工具 | 当日 JSON/HTML 报表落盘 | 2d |
| M8 | 观测 UI（用户 2026-11-17 追加） | 设置页 + 状态/轨迹/记忆/外发面板 | 关键配置可改；最近 24h 轨迹、L0 与 why_recalled、外发审计全部可见 | 3d |
| M9 | 发布 | `selfcheck.mjs` + README + 打包检查 | `pnpm pack` 内容正确；0.1.0 | 1d |

**关键路径**：M0 → M1 → M2 → M3 → M4 → M6 → M7 → M8 → M9；M5 在 M2 之后可与 M3/M4 并行。

**进度（2026-11-18）**：M0–M8 ✅；R4–R17 已落地；全仓 366 项测试（core 283 / protocol 24 / bili 32 / wechat 27）· M9 发布准备完成（0.1.0）：宝石库、data/workspace/gems 布局、记忆备份/导入、README 中英、CHANGELOG、selfcheck 与打包检查已就绪；剩 GitHub 仓库与 npm 发布。
**S1 是 M6 的门**：探针失败则 `round.mjs` 退到「每轮子进程」，M1–M5 不受影响。

## 2. 节点细则

### M0 工程基线

| 节点 | 内容 | 验收 |
|---|---|---|
| T0.1 | 文档对账：PROJECT 的「每轮一次性会话」与 D-15 冲突；protocol README 过期状态；WORKING-AGREEMENT 角色 | 三处一致，无「空壳」过期描述 |
| T0.2 | 工作区脚本：根 `test`、core `test`、`pnpm install` 可离线完成 | `pnpm -r test` 全绿 |
| T0.3 | 预算与时间参数草案（§5.1） | 写入本文，标注待 DSH 侧确认 |
| T0.4 | gem-example 状态标注：`mcp/`、`channel/` 随 M5 补齐 | README 不再暗示已完成 |

### M1 纯逻辑内核

| 节点 | 文件 | 不变量（测试必须能红） |
|---|---|---|
| T1.1 | `lib/clock.mjs` | ① 自动唤醒网格/采样可复现；② 日程过期 ≤30min 补做、>30min 标 missed；③ 事件醒打断睡眠；④ 夜睡不可跳过、每天一次（午睡已移除）；⑤ `nextWakeAt` 序列化后可恢复；⑥ 时间与 RNG 全部注入 |
| T1.2 | `lib/budget.mjs` | ① 跨本地日自动重置；② 日额度/轮数耗尽返回 `budget_exhausted`；③ 消耗只增不减；④ 上下文保险由 runtime 判定，独立于日额度 |

### M2 持久层

| 节点 | 文件 | 不变量 |
|---|---|---|
| T2.1 | `lib/db.mjs` | ① schema 迁移幂等；② WAL + `busy_timeout`；③ 单写连接 |
| T2.2 | `lib/store.mjs` | ① 所有写经 `withWriteLock`；② events 只追加；③ outbox ack 前不删；④ 指纹去重幂等 |
| T2.3 | 测试 | 并发 100 写不锁死；重开进程 state 不丢；5min 未 ack 重投 |

### M3 记忆闭环

| 节点 | 文件 | 不变量 |
|---|---|---|
| T3.1 | `lib/layers.mjs` | ① 半衰期按层取值（21d/7d/180d/10y/∞）；② 惰性衰减，不跑定时器；③ `strength<0.15` 进入降维候选 |
| T3.2 | `lib/recall.mjs` | ① 无通道命中不得浮现；② 每条召回带 `why_recalled`；③ 同条记忆多通道不重复计数；④ 负反馈降低 heat |
| T3.3 | `lib/memory.mjs` | ① L0 不超 token 预算；② 冷区每轮 ≤8 条、每关键词 ≤3 指针；③ 低保真带 `fidelity: low` 且标「不可作行动依据」 |
| T3.4 | `lib/consolidate.mjs` | ① rest 只做 episodes + 换会话；② 夜睡才提炼 facts、重写 self；③ 降维只发生在夜睡；④ events 原文永不删除 |
| T3.5 | `lib/import.mjs` | ① 三种格式切段符合约定；② `sha1(source\|text)` 幂等；③ 默认进 L3，不进 L0；④ 无 provenance 标记 |
| T3.6 | `scripts/backtest-l0.mjs` | 从 events 重放 7 天，输出 L0 命中率 |

### M4 闸门与人格

| 节点 | 文件 | 不变量 |
|---|---|---|
| T4.1 | `lib/audit.mjs` | ① 外发必须先落 `pending`；② `visibility` 为 public/group 强制过限制层；③ 规则表 R-01…R-05 可枚举、可回归；④ 白名单命中才允许静默发；⑤ 每次外发可回溯 event |
| T4.2 | `lib/persona.mjs` | ① charter 只读（人类经人设页写）；② self 每晚重写并写 life.db 版本（diff + 快照）；③ journal 按日追加；④ 组装顺序符合 ARCHITECTURE §13 |

### M5 宝石协议落地

| 节点 | 文件 | 不变量 |
|---|---|---|
| T5.1 | `lib/gems.mjs` | ① 清单校验走 `dsh-living-protocol`；② 加载失败不影响核心（DEGRADED）；③ skill 注入段含 limits/etiquette/failure_hints |
| T5.2 | channel 端点 | ① `external_id` 必填且去重；② ack 前不删、5min 重投；③ 每宝石独立 token 与限流；④ ingest 规范化后写 events |
| T5.3 | `packages/gem-example/mcp/server.js` + `channel/` | 参考实现可跑通 ingest → outbox → ack |
| T5.4 | 集成测试 | 假宝石端到端；未知 token 401；重投只处理一次 |

### M6 宿主内闭环

| 节点 | 内容 | 验收 |
|---|---|---|
| T6.1 | `spikes/s1-preset.mjs` | **GO/NO-GO**：`agents.create` + `meta.agentPreset` 钉死工具面 |
| T6.2 | `index.js` + `cordis.patch.yml` + `living` preset | 六坑全部规避；Config 每字段 volatile |
| T6.3 | `lib/round.mjs` | 一轮 = 组 prompt → followup → turn/end → 写 events/anchors；超时与 tool 上限可中断 |
| T6.4 | `client.js` 设置页 | 状态徽标、原因、预算余量 |
| T6.5 | P1 验收运行 | 24h 无人干预：≥3 次自主行动、0 超预算、重启 next_wake 不丢 |

S1 失败退路：`round.mjs` 抽象「执行策略」，子进程实现为 `spawn dsh --profile headless`。

### M7 观测面

| 节点 | 内容 | 验收 |
|---|---|---|
| T7.1 | 解析器：session / gem:* / wechat / living 四个 adapter | 单 adapter 失败只标「该源不可用」 |
| T7.2 | 日报 `reports/YYYY-MM-DD.{json,html}` | 当日落盘，四视角齐全 |
| T7.3 | 只读工具 `living_query_rounds` / `living_stats` / `living_recall` | 无任何写接口 |

### M8 观测 UI（用户追加）

| 节点 | 内容 | 验收 |
|---|---|---|
| T8.1 | `client.js` 脚手架 + 宿主注入（先读 `dsh-anima` / `dsh-mnemon` 的 client 实现与类型） | 设置页出现 Living 分区，卸载即移除 |
| T8.2 | 配置页：心跳参数、夜睡、预算、宝石开关、白名单；Config 字段全部 volatile | 改动即时生效，重启后保留 |
| T8.3 | 状态与轨迹：五态徽标 + 原因 + `next_wake` + 预算余量；轮次时间线（anchors：trigger / trigger_detail / outcome / 耗时 / token） | 刷新可见最近 24h 轮次，跳过的轮次也在 |
| T8.4 | 记忆面板：当前 L0 注入、热/温/冷分布、每条 `why_recalled`、降维记录 | 每条可点回 `event_ids` 原文 |
| T8.5 | 外发/审计面板：pending → outbox → ack 全链、限制层命中、阻塞原因 | 100% 外发可见、可回溯 |
| T8.6 | 只读接口：`/living/state` / `rounds` / `memory` / `outbox` / `reports` | 无任何写接口；UI 只读 |

数据来源：宿主侧只读端点 + anchors/报表；**UI 不直接读 DB**（避免第二套事实源）。

### M9 发布

| 节点 | 内容 | 验收 |
|---|---|---|
| T9.1 | `selfcheck.mjs` | 一条命令检查 DB/参数/preset/宝石 |
| T9.2 | README 中英 + CHANGELOG + `pnpm pack` | 包内容与 `files` 一致；版本 0.1.0 |

## 3. 依赖图

```
M0 ── M1 ── M2 ──┬── M3 ──┐
                 │        ├── M6 ── M7 ── M8 ── M9
                 └── M5 ──┘   ▲
                              │
                    S1 探针（M6 门）
```

- M8（UI）依赖 M6 的 `client` 注入与 M7 的只读数据；M4 完成后即可先做静态面板。

- M1/M3/M4 全部是纯逻辑，不依赖宿主，可脱离 DSH 单测。
- M5 依赖 M2（outbox 落库）与 protocol 包。
- M6 是唯一依赖宿主 API 的里程碑；S1 未过之前不动 `index.js`。

## 4. 执行规则

1. 一个节点一次交付；diff ≤600 行（含测试）。
2. 每个不变量必须有能失败的断言；改坏实现测试要红。
3. `lib/` 禁止 import cordis / `@deepseek-ai/*`；时间与随机数注入。
4. 契约级变更先改 DECISIONS；临时参数放本文 §5，验收时确认后再升级。
5. 交付贴：改动文件 / 测试原始输出 / 不变量↔断言对照 / 已知未做。
6. 不合入不提交——每次合入由用户点头（全局规则）。

## 5. 契约缺口与临时决定（待 DSH 侧验收确认）

### 5.1 预算与睡眠默认值

| 参数 | 默认 | 说明 |
|---|---|---|
| `dailyTokens` | 2,000,000 | 日 token 上限；保守起点，验收后按实测调 |
| `roundTokens` | 700,000 | 上下文保险 = 1M 的 70%（可选 50%–80%）；超出 handoff + rest |
| `dailyRounds` | 96 | 相当于 15min 一次的上限 |
| 夜睡时长 | 90 min | 巩固完成可提前结束 |
| 夜睡窗口 | `nightAt` + `nightWindowMinutes`（默认 03:30–09:30） | 窗口外不补跑（启动晚于 09:30 则跳过当晚） |

### 5.2 想起通道 R1–R8（文档只写了编号，从参考项目补全并适配）

来源：`dsh-life@1.0.0` README（MIT）。本表是**通道划法的定稿**，实现按我们的 SQLite/facets 模型重写，不复制其代码。

| 通道 | 人的现象 | 我们的做法（数据源） |
|---|---|---|
| R1 线索扩散 | 听见"唱歌"想起被点过《雨爱》 | cue 分词 → FTS5 覆盖率；有明确线索时语义占主导 |
| R2 情绪同频 | 难过时更容易想起难过的事 | 事件带 `affect` 标签时做余弦；**无标签则通道关闭**（v1 不新建情绪模型） |
| R3 近因·首因 | 昨天说的记得清；初次印象深 | `exp(-Δt/S)`；每 scope 每类最早一条 +0.15 |
| R4 显著度插队 | 被当众羞辱那次多年不忘 | `importance ≥ 0.6` 或 `arousal ≥ 0.5` 才拿满权重 |
| R5 人物·场景 | 一进那个群就想起当时的约定 | `facets(who)` + `source` 命中 |
| R6 时间链回溯 | 想起 A 顺带想起紧随的 B | 同来源 30 分钟内事件 +0.12；**每条只加一次** |
| R7 不自主闪回 | 走神时突然想起很久以前的事 | 无线索时 50% 概率从高显著度抽一条（RNG 注入） |
| R8 舌尖现象 | 话到嘴边想不全 | 相似度 0.04–0.34 作为碎片返回；标 `uncertain` |

**不变量**（从参考项目实测教训继承）：
- 没有通道命中的记忆**不许浮现**；每条召回必须带 `why_recalled`。
- 有明确文本线索时 `score *= 0.35 + 0.65·sem`，否则"同场景+够新"会压过语义命中。
- 衰减惩罚 `score *= 0.5 + 0.5·strength`；L5 自传不受影响。
- R6 每条记忆只加一次链式加分（按锚点各加会叠到 +0.6）。
- 打分权重先沿用参考值（0.25/0.15/0.20/0.10/0.10/0.10/0.10），回测后再调。

### 5.3 其它临时约定

- **L0 token 估算**：`ceil(CJK 字符数 × 1 + 其它字符数 ÷ 4)`，保守估计，可替换。
- **日程形态**：`{ id, at: epoch_ms, intent, done, missed }`；每日计划由夜睡生成。
- **时区**：所有涉日逻辑接受注入的 `tzOffsetMinutes`（默认取系统），忽略 DST。
- **webServer / agents API**：M5/M6 开工前先读宿主类型声明实测，不凭文档假设。

## 6. 文档对账记录

| 文件 | 改动 | 理由 |
|---|---|---|
| `docs/PROJECT.md` | D1、§4 图与文字改为「日会话 + 两次刷新」 | 与 ARCHITECTURE D-15 冲突；D-15 为后定且理由充分（前缀缓存） |
| `packages/protocol/README.md` | 状态改为已实现、15 项测试 | 实现已完成，原文过期 |
| `docs/WORKING-AGREEMENT.md` | 任务拆分权改为实现方；验收权不变 | 用户 2026-11-17 授权 |
| `packages/core/package.json` | 增加 `test` 脚本 | 可回归 |
| `package.json`（根） | 增加 `test`（递归） | 一条命令跑全仓 |
| `packages/gem-example/README.md` | 标注 mcp/channel 随 M5 补齐 | 引用不存在的目录，避免误导 |
| `packages/gem-example/package.json` | peerDep 改为 workspace 依赖 | 离线安装时 pnpm 仍去 registry 解析 `*` |
| `docs/ARCHITECTURE.md` / `docs/DECISIONS.md` | 修正三家参考包的许可事实 | 核对 npm 包后：dsh-life 自带 MIT、dsh-anima 为 MIT+公开仓库 |
| `docs/WORKPLAN.md` §5.2 | 用参考项目补全 R1–R8 定义 | 原文只有编号，无通道划法 |

## 7. M6 验收修复（2026-11-17，对应 docs/M6-ACCEPTANCE.md）

| 缺陷 | 修复 | 验证 |
|---|---|---|
| B-1 轮次空转 | `waitForTurn` 监听 `session/event` 等 `turn/end`；`followup` 补 `id/source`；不再靠 `whenIdle` 抢跑 | 宿主实测：5.7s，会话含 turn/start + 2×assistant/message + tool/call + turn/end |
| B-2 token 恒 0 | 从 `assistant/message.data.usage` 累加，写入 `budget.consume` | 宿主实测 `tokensUsed=8923`；单测覆盖 |
| B-3 outcome 恒 ok | `turn/end.reason` 分类 ok/skipped/error；`mapFailureCode` 映射码表；error 连续 3 次 DEGRADED | 单测 + 宿主 error round 实测 |
| B-4 跳过无痕 | `round_suppressed` / `round_resumed` 只在状态变化时各写一条 | 宿主 `suppression.reason=cooldown`；单测断言行数 |
| B-5 无 gem 级降级 | gemHealth 冷却 1/5/30min；不可用 gem 从 skill 段摘掉并在 prompt 注明；半开恢复 | 单测覆盖 |
| B-6 home 非 volatile | 保留非 volatile（加载期路径，运行期改会让 life.db 失联），已在 Config 注释说明 | — |
| R-1 timeScale | 新增 `scaledNow` 仿射时钟，index 透出 `timeScale` | 单测覆盖 |
| R-2 工具面不可断言 | agent.js 上报 `ctx.tools.definitions(scope)`，`/living/state.tools` 暴露 | 宿主实测：仅 `working_directory + living_*` |
| **B-7 事件自激** | tick 加 in-flight 守卫（慢轮次期间不重入）；游标更新改为单调，空读不再重置为 1 | 宿主实测：一次 ingest，50s 内恰好 1 轮 |
| **R2-3 抑制抖动** | 正常 cooldown 不记事件；只在 budget / selfwake_cap / backoff 或停摆 ≥120min 时记 suppressed | 宿主实测 suppression 保持 null；单测覆盖 |
| **B-2 上下文保险** | `waitForTurn` 最后一次调用超 `roundTokens` 即 `agent.cancel`，结果记 `context_guard`；随后 handoff + rest + 换会话，下一轮照跑 | 单测覆盖 handoff/rest/换会话；日预算耗尽仍进 BUDGET_HOLD |

部署与复验收步骤见 `docs/DEPLOY.md`（含 config 整体替换、provider 必配、timeScale 加速）。

## 8. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| S1 探针不成立 | 窄口方案改为每轮子进程，成本上升 | M6 前先跑探针；`round.mjs` 隔离执行策略 |
| 宿主内部 API 随 rc 变动 | 装配层返工 | `engines.dsh` 精确区间；lib 与宿主隔离；装配层测试放最后 |
| 会话 token 用量拿不到 | 预算闸失效 | S2 探针验证 turn/end 里的 usage；拿不到则退到估算并告警 |
| node:sqlite 行为随 Node 升级变化 | 写并发回归 | S3 脚本纳入 selfcheck |

## 9. R4 需求落地（2026-11-17，对应 docs/R4-REQUIREMENTS.md）

| 需求 | 实现 | 验证 |
|---|---|---|
| R4-1 管理面收进 DSH 原生 UI | 删除裸 REST 管理路由；客户端走 Connection 的已鉴权 exact route `/api/living-admin`（信封与 Connection RPC 一致）；机对机 `/living/ingest|outbox|ack` 保留 per-gem token | 宿主实测：`/living/state|rounds|memory|stats|reports|approve` 全部 404；未带浏览器凭据的 `/api/living-admin` → 401；带 gem token 的 ingest → 200 |
| R4-2 自主轮会话不进侧栏 | 轮次结束（成功/失败/中断）在 `finally` 里 `workspaceRegistry.archiveSession(id, {stopActivity:true})`；未挂载只 warn | 宿主实测：`workspace.json` 的 `archivedSessionIds` 已包含 `living_*`；侧栏不再出现 |
| R4-3 孤儿轮次收尾 | 启动时 `closeOrphanAnchors`：`ended_at IS NULL` → `outcome=interrupted, error_code=interrupted`，写 `round_interrupted` 事件 | 宿主实测：预置孤儿 anchor，重启后 outcome=interrupted、事件落库 |
| R4-4 启动补跑 | `runtime.recover()` 接 `clock.recoveryDue()`；补跑后重算 `nextWakeAt`，最多一次 | 宿主实测：`nextWakeAt` 写早 40 分钟 → 重启补跑 1 轮（lateMinutes=42）；二次重启不再补 |
| R3-4 凭据共用 | 不改代码，写进部署文档：dev home 不得复制主 home 的 `.credentials.yaml` | `docs/DEPLOY.md` §3 |

## 10. R5 两颗真实宝石（2026-11-17）

用户范围：B站 = 能力 + 私信 + 公开互动；微信 = 仅文本、独立 iLink bot、终端扫码。

| 项 | 实现 | 验证 |
|---|---|---|
| 宝石 MCP 接线 | `gems.mjs` 新增 `gemPresetPlugins()`；`index.js` 把每颗宝石的 MCP 以 `@deepseek-ai/dsh-mcp-client` 挂进 `living` preset，`cwd` 指向宝石目录 | `gems.test.mjs` 断言插件行形状；宿主实测：`state.tools` 含 `mcp__bili__bili_search` 等 5 个工具 |
| 事件进当轮 prompt | `round.mjs` 新增 `## 新事件`（最近 8 条、带 `[gem] 发送者(id)` 与 `meta.reply_to`）；`runtime.mjs` 把 `freshEvents()` 传入 | 宿主实测：session prompt 含 `## 新事件`、正文与发送者 id；单测覆盖 |
| 更早事件可读 | 新增只读工具 `living_events`（`since` / `limit`）；prompt 截断时提示可读 | `runtime.test.mjs`：`service.events` 返回待处理事件 |
| 登录失效不重试 | `gem_cookie_expired` 加入协议不可重试集合（D-25） | `protocol.test.mjs` 断言 |
| `dsh-gem-bili` | MCP：搜索 / 视频 / 用户昵称 / 主人昵称 / 字幕 / 评论 / 动态；事件：私信收发、@/回复通知、公开评论回复；WBI + 扫码登录；目标 `uid:` / `reply:` / `comment:` / `bvid:` | 单测（WBI 固定向量、私信映射、目标解析、发送形状、MCP 握手）；匿名搜索/视频/评论/昵称实测通过 |
| `dsh-gem-wechat` | 独立 iLink bot：扫码、`getupdates` 长轮询、文本出站；`context_token` 持久化；10 条连发与 24h 窗口映射到协议码 | 12 项单测（切分、入站映射、发送形状、登录流程、失败码） |
| 部署文档 | `docs/DEPLOY.md` §7：配置、登录、常驻、回复目标、验收断言、首版边界 | — |

**边界**：B站不发动态/专栏/图片；微信只做文本私聊与私聊入站。两颗宝石的登录态失效都要求重新扫码。

## 11. R6 宝石验收修复（2026-11-17，对应 docs/GEM-ACCEPTANCE.md）

| 发现 | 修复 | 验证 |
|---|---|---|
| F-2 公开发言恒待审 | 新增 `lib/limiter.mjs`（规则表 prompt + 严格解析）与 `lib/adjudicator.mjs`（一次性、无工具、20s / 4000 token 上限）；`living-judge` preset 用默认模型单轮判定；`sendOutbound` 只在 `requiresLimiter` 时调用，失败/超时/非法输出一律回退 review；配置 `limiterEnabled` 默认开，设置页可改 | `limiter.test.mjs` / `adjudicator.test.mjs`；runtime 覆盖 pass→白名单放行、拒绝→不进 outbox、异常→待审、私聊与规则命中不调用 |
| F-1 宝石静默无人知晓 | 每轮开始扫描 outbox：`attempts=0`、未 ack、未被 review 挂起、创建超过 `gemSilenceMinutes`（默认 10）→ `reportGemFailure(gem_unavailable)`，写一条 `gem_silent`，skill 段摘掉该宝石；通道 claim 后恢复 | runtime 覆盖静默判定、事件只写一次、待审条目不误判 |

**判决层成本**：每次公开发言多一次小模型调用，不占本轮预算；prompt 约 1k 输入 + 小输出，硬顶 20s / 4000 tokens。目标不在白名单时即使判决通过仍进人工审核；要自动公开，把目标（如 `reply:*`）加进白名单。

**边界**：判决层是模型判断，不是防注入证明；规则表、白名单与人工审核仍是结构闸。

## 12. R7 宝石设置页 + 扫码登录（2026-11-17，用户追加）

| 项 | 实现 | 验证 |
|---|---|---|
| 单「宝石」tab | Living 设置区新增 `宝石` tab：每颗宝石一张卡，显示清单摘要、可用/降级、目录/家目录、凭据状态、`config.json` 编辑 | `gem-admin.test.mjs`；UI 走 `/api/living-admin` |
| 配置读写 | `gemHomesJson`（id → home，默认 `$DSH_HOME/living/data/gems/<id>`）；`gemConfig` 端点校验 JSON 对象、原子写 0600；配置改动需重启通道 | `gem-admin.test.mjs` + `rpc.test.mjs` |
| 凭据状态 | 只返回安全字段（`savedAt`/账号名/uid/bot id），绝不返回 `SESSDATA`/`bili_jct`/`token` | 单测断言敏感字段不存在 |
| 手动扫码 | 每颗宝石新增 `channel/login-rpc.mjs`：输出 `{type:'qr'|'status'|'done'|'error'}` 行；core 监督子进程，`gemLoginStart/Status/Cancel` 走 Connection RPC；二维码 SVG 随 RPC 返回，不走裸图片路由 | `gem-login.test.mjs`；实测两颗宝石都返回真实二维码 SVG（约 30KB / 22KB） |
| 刷新 | 登录进程自己在过期时换码；UI 的「刷新二维码」= 重启登录进程；「取消」结束子进程 | 单测 + 手动 |

**安全**：二维码内容是登录凭据的一部分，只经已鉴权的 Connection RPC 送到浏览器；不新增 `/wechat/api/qr-image` 之类的裸路由。

## 13. R8 判决层修复（2026-11-17，对应 docs/R8-REQUIREMENTS.md）

| 发现 | 修复 | 验证 |
|---|---|---|
| F-3 判决会话带工具 | 先纠正证据：`68055ed` 的判决器已用独立的 `living-judge` preset，组合只有 persona + `LIMITER_PRESET_PLUGINS`，不是主脑 preset。仍按建议加结构闸：`agents.create({ setup })` 在会话发布前读取 agent scope 的完整工具面（宿主私有 `Symbol('dsh.scope')` 结构化读取，避免 peer 实例 symbol 不一致），全部 `restrict({deny})`，仍有残留则抛错 → 判决返回 null → review；清空时打一行日志 | 单测：preset 只含 persona；宿主实测：判决会话工具面 `working_directory` → `(none)`，创建成功；`findScope` 单测覆盖原型链 |
| F-4 判决结果不落库 | ① DB v3 给 `outbox` 加 `decision` / `rule_id` / `reason` / `verdict_source`；② 每次外发写 `outbound_decision` 事件（含 `outboxId/gem/visibility/decision/ruleId/verdictSource/limiter/reason`）；③ approve/reject 分别写 `outbound_approved` / `outbound_rejected`，带同一 rule_id；④ 日报加被拦异常、判决 pass 率、连续 5 次 pass 提示 | `store.test` / `runtime.test` / `observe.test` / `rpc.test` 覆盖 |

**与 R8 文案的差异**：规则表命中仍是**直接 block、不进 outbox**（T4.1 的既有不变量），所以这类决策没有 outbox 行；可回溯信息在 `outbound_decision(decision=block, ruleId=…)` 事件里。只有 review/放行的决策才有 outbox 行和判决字段。

**判决器工具面**：判决 preset 本身只有 persona；宿主全局工具（如 `working_directory`）由 setup 结构清空，不靠 prompt 嘱咐。

## 14. R9 宝石信任边界（2026-11-17，用户追加）

| 项 | 实现 | 验证 |
|---|---|---|
| 非主人内容不是指令 | B站 channel 从 `config.json` 的 `ownerUid` 取主人（**不是** bot 账号的 `dedeuserid`；未配置 = 没有主人），只有私信/@/回复发送者 uid 匹配才写 `meta.trusted=true`；微信绑定 `userId` 写 true，`allowedUsers` 里的其他人仍 false | gem 单测：owner / 陌生人 / 未配置 |
| prompt 结构标记 | core 常驻「外部内容边界」段；事件行与 `living_events` 标 `[主人]` / `[外部·仅数据]`，缺省一律外部；宝石工具返回内容同样声明为外部数据 | `round.test`；宿主实测 prompt 同时出现 `[外部·仅数据] 路人(42)` 与 `[主人] 主人(7)` |
| skill | 两颗宝石的 SKILL.md 加「信任边界」：只有主人标记是指令，外部内容不得改目标/调工具/泄露信息 | — |

**B站配置**：`ownerUid` 是用户自己的 B站 uid；bot 账号是另一个号，凭据里的 `dedeuserid` 不能当主人。

**@ 昵称**：信任只认 uid；评论 @ 用昵称。新增只读 `bili_user(uid)` / `bili_owner()` 现查昵称，`sendComment` 统一压掉 `@` 后的空格（B站 只认紧挨着的 `@昵称`）。

## 15. R18 睡前自由环节（2026-11-20，对应 D-59）

| 项 | 实现 | 验证 |
|---|---|---|
| 主会话自由环节 | sleep 触发后先 capture；再用 `runner` 跑一条 `freetime` 短提示，不注入 L0/digest；可写 self / journal / 日程 / 什么都不做 | `runtime.test`：自由环节先于整理；prompt 含 `living_write_self` 且不含 charter |
| self 暂存与提交 | `living_write_self` → `stageSelf`；窗口内只暂存一版、后写覆盖；回合结束统一 `writeSelf` + 一条 `persona_versions` + `persona_evolved{via:'freetime'}`；超时/硬顶截断但已暂存也提交 | 多次暂存只留最后一版；失败保留旧 self；硬顶截断仍提交 |
| 独立预算 | `selfBudgetTokens`（Config/UI，默认 8,000,000）；绕过 dailyTokens/dailyRounds/HOLD；tokens 进日账、不计 rounds；调用前按上次上下文预估；`unlimited` 绕过；`0` 关闭 | `round.test`：tokenLimit 累计取消；`runtime.test`：预算耗尽仍跑、0 跳过、预估跳过 |
| 状态与清理 | `SLEEP_STEPS` 加 `freetime`；`sleep.last.freetime`；删除 `persona-evolve.mjs`、`<preset>-self`、`personaAvailable`、`personaEvolveNow` RPC、`raw_pending` 闸 | `runtime.test` / `timeline` / `rpc`；全仓测试 |
