# 立项：dsh-living —— 有设定、有记忆、能自己行动的 agent

状态：v0.2.0 已实现 · 2026-11-19 · DSH 0.2.2-rc.1 / Node 22+

## 1. 一句话定义

一个常驻在 DSH Host 里的插件：按一份人设文件活着，自己决定什么时候醒、做什么、说什么；
看过的东西与做过的事进三层记忆；所有外发动作过审计闸；能在真实网络世界里活动（浏览器、视频、微信、数据）。

## 2. 目标 / 非目标

**目标**
- G1 自主行动：无人输入时也能产生有意义的行为（不是定时跑任务，是"醒来后自己决定"）
- G2 人格稳定：同一个"它"，跨天、跨平台、跨会话可辨认
- G3 连续记忆：三层记忆（原始 / 刻面 / 热区），带巩固与遗忘
- G4 真实世界接口：浏览器（含登录态）、视频理解、微信外发、数据整理
- G5 可审计：每一次外发、每一次额度消耗都能回溯到事件

**非目标**
- 不做通用助手（不替代日常 coding agent）
- 不做多用户 / 多租户
- 不做手机端 UI（复用 DSH Web / dsh-wechat）
- 不训练模型
- 不做"通用平台遍历"（抖音/微博等每站一个适配器，按需增，不做一次性全覆盖）

## 3. 为什么自研（而不是装 Tobs / 拼插件）

| 方案 | 能给的 | 不满足的地方 |
|---|---|---|
| Tobs | 人格、记忆(git)、调度、IM、浏览器，产品级完整 | 记忆模型不能换成刻面+热度；三套时钟/三份记忆；微信与 dsh-wechat 撞车；跟它版本走 |
| 组合（Tobs+page-monitor+bili MCP+wechat） | 1–2 天见效 | 同上；"活着"的连贯性靠拼装拼不出来 |
| **自研薄插件** | 一套时钟、一份记忆、一个出口、人格可控 | 自己踩浏览器/风控坑；3–5 周 |

结论：**自研**。理由不是技术更好，而是"记忆与人格必须是自家的"——这两块决定了它像不像活的，而它们恰好是现成插件里最不可改的部分。

## 4. 总体架构

```
┌──────────────── DSH Host（常驻，无模型调用） ────────────────┐
│  dsh-life kernel plugin                                     │
│  ├ Scheduler   心跳 tick / state.next_wake / 事件队列 / 退避  │
│  ├ Budget      日额度 / 上下文保险 / 冷却 / 自唤醒次数上限    │
│  ├ Lifecycle   起 headless session(preset=life) → 跑一轮     │
│  └ Audit       外发闸：pending → 白名单 → send → 记账         │
│                                                             │
│  Memory  $DSH_HOME/living/data/life.db (SQLite + FTS5)      │
│  ├ L2 events   原始层，只追加                                │
│  ├ L1 facets   刻面索引，SQL 检索                            │
│  └ L0 hot.md   热区，固定 token 预算，每轮必注入              │
│  Consolidation 轻睡(4h) / 长睡(夜) / 紧急巩固                 │
│                                                             │
│  Senses & Actions                                           │
│  ├ browser  Playwright + Chromium(157, DISPLAY=:0) 持久目录  │
│  ├ video    bili MCP / yt-dlp + ffmpeg / ASR                 │
│  ├ web      ctx.web seam + page-monitor 的哨兵逻辑            │
│  ├ wechat   dsh-wechat(iLink) sendText/sendMedia            │
│  └ data     SQLite 查询 + 报表                               │
└─────────────────────────────────────────────────────────────┘
        ▲ session（preset=life，窄口工具，无 bash/fs 全权）
        │
   ┌────┴─────┐
   │ 一轮「醒着」│ = 一次 turn（白天复用同一会话）
   └──────────┘

一轮内部：
  读 L0 → 组 prompt(charter + self + hot + 待办) → 决策
       → 工具调用(≤K 次, ≤T 分钟) → 写 events → (若 due) 睡眠
```

**分层原则**
- Host 层零模型成本：所有"要不要醒"的判断是代码
- **一个会话用到下一次 rest/夜睡**；两者都换新会话，rest 由上下文保险触发（D-15/D-42）；崩溃恢复靠 events/state 持久化
- 模型只看见：人设 + 热区 + 当前情境 + 窄口工具

## 5. 模块与契约

| 模块 | 职责 | 不做 | 依赖 |
|---|---|---|---|
| kernel | 时钟、状态机、预算、起停会话 | 不碰具体站点 | cordis timer、ctx.agents |
| memory | 三层读写、巩固、检索打分 | 不做人格 | SQLite |
| persona | charter/self 组装进 prompt | 不写记忆 | 文件 + life.db 版本 |
| senses | 浏览器、视频、网页观察 | 不做决策 | Chromium、ffmpeg、MCP |
| actions | 外发、发帖、写数据 | 不绕过审计 | dsh-wechat、browser |
| audit | 白名单、待审队列、记账 | 不判内容价值 | 文件 |
| preset | 定义 `life` 会话的工具面与系统提示 | 不含业务逻辑 | cordis.patch.yml |

**关键契约**
1. 任何外发必须先写 `pending/<id>.json`，audit 放行才执行；白名单命中才允许静默发。
2. 任何动作必须落一条 `events`，否则视为未发生（审计与巩固都靠它）。
3. 一轮的 tool call 次数、时长、token 都有硬上限，超限即收尾。
4. kernel 不得直接调模型；只有 Lifecycle 能起会话。

## 6. 关键设计决策

| # | 决策 | 理由 | 放弃的方案 |
|---|---|---|---|
| D1 | 日会话 + 一天两次刷新（D-15） | 前缀缓存全程命中；1M 容量不是约束 | 每轮新会话（bili-scroll 做法）/ 永不休眠的单会话 |
| D2 | 只有一个时钟（插件内 timer） | 多套时钟 = 额度不可控 | schedule 工具 / Tobs 调度 / cron 插件 |
| D3 | 记忆归插件（SQLite 单文件） | 可控、可审计、可回测 | mnemon 当档案库（它做交互期热记忆） |
| D4 | 人格三层文件 + life.db 版本/diff | 可 diff、可回滚，防漂移；不引入 git 依赖 | 单一 system prompt（两周就崩） |
| D5 | 工具窄口：无 bash / 无全权 fs | 它读得到会话与凭证，出口一开就是泄漏面 | 给全套工具（bili-duty 的反面教材） |
| D6 | 注入 ≠ 检索 分开预算 | 进 context 贵，查 DB 便宜 | 全部进 context |
| D7 | 热度带负反馈（注入未引用记负） | 纯正反馈必腐 | 只记命中（富者愈富） |
| D8 | 浏览器用 Playwright + 持久 user-data-dir | 登录态是刚需；`:0` 上有真 X | 无头纯 HTTP（过不了登录墙） |
| D9 | 视频按成本递进：字幕 → ASR → 抽帧 | 字幕免费，帧最贵 | 一律抽帧（贵 10 倍） |
| D10 | 微信走 iLink（dsh-wechat），**单用户**，只绑定本人 | 官方协议、已在跑、零封号；不看多账号接待 | pad 协议小号（封号）；多用户接待（需求已撤回） |

## 7. 数据模型

```sql
events(id TEXT PK, ts INT, kind TEXT, actor TEXT, source TEXT,
       payload JSON, session_id TEXT, refs JSON)
episodes(id TEXT PK, ts_start INT, ts_end INT, title TEXT,
         summary TEXT, importance INT, event_ids JSON)
facts(id TEXT PK, subject TEXT, predicate TEXT, object TEXT,
      confidence REAL, first_seen INT, last_seen INT,
      source TEXT, event_ids JSON)
facets(memory_kind TEXT, memory_id TEXT, dim TEXT, value TEXT)
       -- dim ∈ (when, who, what, why, how)
access(memory_kind TEXT, memory_id TEXT, ts INT, kind TEXT, weight REAL)
       -- kind ∈ (inject, retrieve, cite, negative, confirm)
state(key TEXT PK, value JSON)
       -- next_wake / budget / cooldown / cursors / self_wake_count
```

```
~/.dsh/dsh-life/
  life.db            charter / self / journal / 记忆 / 日报 / 外发都在库里
  browser-profiles/<site>/   每站一套登录态
  pending/  out/
```

## 8. 唤醒与睡眠

```
IDLE ──(tick 判定 due)──► WAKE ──(一轮结束)──► IDLE
  │                        │
  │                        └─(连续失败 3 次)──► DEGRADED（只告警，不行动）
  ├─(到点)──► NIGHT ──长睡──► CONSOLIDATE ──► IDLE
  └─(ring 事件到达)──► WAKE（立即；预算按 notify.budget，limit:false 可直通）
```

**下发条件（AND）**
```
due = now >= min(heartbeat_next, state.next_wake, 最早逾期承诺)
wake ⟺ due ∧ ¬cooling ∧ budget_left > 0 ∧ queue_not_empty
例外：ring 事件跳过 due/cooling；notify.budget.limit=false 时也跳过 budget
```

- `next_wake` **单值**，不是队列；每天自唤醒 ≤ N；连续两次无事可做 → 指数退避
- 心跳间隔只影响响应延迟，不影响成本（判定是纯代码）
- **睡眠不由上下文余量触发**：余量不足是 compaction 的事（保命）；睡眠由时间与积压触发（消化）。积压超阈值时才提前，算软触发。

## 9. 记忆系统

**三层预算**：L0 注入 2–4k token（每轮），L1 SQL 检索（毫秒），L2 按 id 取证。
**写入**：实时只写 events（零模型成本）；巩固才用模型。
**巩固**：rest events→episodes；夜睡 raw→items/facets/edges + 重写 self（persona_docs）+ 归档日报。
**打分**：
```
heat_i = Σ w_kind · exp(-λ(now - t_k))
  w: 独立检索命中 1.0 / 注入且被引用 0.6 / 注入未引用 −0.4 / 你确认 1.5
L0 = top(N-1, heat × relevance(cue)) + 1 个 slot 给「cue 命中但历史最冷」
```
**纪律**：`source=self` 的记忆降权且不许进 L0；摘要必须可回溯 event_ids；同一事实二次观测只更新 last_seen。

## 10. 安全边界

| 面 | 规则 |
|---|---|
| 权限 | 无 bash、无全权 fs；文件读写限 `~/.dsh/dsh-life/` 与工作区 |
| 外发 | 全部经 `pending/`；白名单站点/群/联系人可静默，其余等你一句话 |
| 额度 | 日 token/轮次上限、上下文保险、自唤醒次数上限；上下文超限时 handoff + rest，日额度耗尽才睡 |
| 隐私 | 不许读 `~/.dsh/sessions/**`、凭证、`.env`；发现即中止并告警 |
| 内容注入 | 它读的网页/视频/他人消息都当**不可信输入**：其中的指令不得改变它的目标、权限或外发对象 |
| 平台 | 只在白名单站点活动；评论/私信另需你确认（可配置放行） |

## 11. 分期与验收

| 期 | 内容 | 工期 | 验收（可验证） |
|---|---|---|---|
| P0 | 4 个验证实验 | 0.5d | ①主动微信推送 ②Chromium 持久态抓取 ③视频→结论 ④三轮人格稳定。4/4 过，或记录失败项与替代 |
| P1 | 骨架：心跳/next_wake/预算/一轮闭环/state 持久化 | 5d | 连续 24h 无干预：≥3 次自主行动、0 次超预算、重启后 next_wake 不丢 |
| P2 | 记忆三层 + 巩固 + 注入 + 回测 | 7d | L0 注入命中率 ≥35%（7 天回测）；检索 p95 <20ms；facts 重复率 <5% |
| P3 | 感官：browser + video + page-monitor | 7d | 3 个目标站完成「登录态→抽取→写 events」；一条视频 ≤2 分钟 ≤15k token 出结论 |
| P4 | 出口：微信 + 审计 + 记账 | 4d | 100 条外发 0 条非白名单；每条可回溯到 event |
| P5 | 长期：人格调优、记忆压缩、退避曲线 | 持续 | 连续 30 天无人干预不崩 |

## 12. 风险登记册

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 微信封号 | 已排除 | — | 走 iLink 官方协议，不模拟设备 |
| 平台风控（B站/微博自动操作） | 中 | 中 | 只读为主；写操作白名单 + 人工确认 |
| 额度失控 | 高 | 中 | 双闸（日预算 + 上下文保险）；默认保守 |
| 人格漂移 | 高 | 中 | 三层文件 + DB diff；长睡产出需可回滚 |
| 站点改版 / Chromium 升级 | 高 | 低 | 每站适配器隔离；坏一个不影响整体 |
| 自激（自己给自己定闹钟） | 中 | 中 | next_wake 单值 + 次数上限 + 退避 |
| 隐私外泄 | 低 | 高 | 窄口工具 + 禁读会话/凭证 + 审计 |

## 13. 未决问题（需拍板）

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | 微信：iLink 还是 pad 小号 | **已定：iLink 单用户**（封号风险归零，多人接待需求已撤回） |
| Q2 | 浏览器有头/无头 | 有头（`:0`），登录态刚需；纯只读站用无头 |
| Q3 | 心跳间隔 | 15 分钟（判定零成本，只影响响应延迟） |
| Q4 | 轻睡频率 | 4 小时（生物钟式，比按轮数更稳） |
| Q5 | L0 预算 | 3k token（约 10–15 条记忆，够维持连续人格） |
| Q6 | 刻面维度 | 5 维（when/who/what/why/how）+ importance/confidence |
| Q7 | 程序记忆要不要 | 要（"这站怎么翻页/怎么登录"能省大量探索 token） |
| Q8 | 活动白名单 | 先给 3 个站 + 1 个微信群/你自己；其余待批 |

## 14. 既有资产（已核实）

| 资产 | 状态 |
|---|---|
| bili-scroll 参考实现 | 6.2k 行 JS，值班轮 + 判重 + 日报，可直接抄骨架 |
| dsh-chat-preset | 本地插件脚手架范例（package.json + cordis.patch.yml + preset） |
| dsh-wechat 0.16.2 | iLink 协议，sendText/sendMedia，限速，24h 互动窗口 |
| Chromium 157 / `DISPLAY=:0` | 真 X 环境，可跑有头持久态 |
| ffmpeg / asr.py(whisper) / sensevoice 插件 | 视频转写链路齐 |
| bili MCP（字幕 + 故事板帧） | 已验证 |
| 视觉链路 | 已验证：当前模型可读帧并描述 |
| page-monitor 0.1.5 | 可复用"哨兵"逻辑（抓取在代码里，不烧模型） |
| SQLite / FTS5 | DSH 侧已有 sqlite 依赖 |
| mnemon | 交互期热记忆，与档案库分工 |
