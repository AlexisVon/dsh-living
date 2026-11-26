# dsh-living 技术架构 v1.0

2026-11-17 · 状态：**架构定稿** · v0.2.0 已实现 · 目标：自研 + 发布到 npm 与 DSH 插件市场

> **一句话**：`dsh-living` 是一个模块运行时；它通过 **WorldGem** 接入世界——每颗宝石交出它的能力（MCP）、事件（ingest/outbox）和一份教模型怎么用它的说明（skill）。

---

## 0. 先决：生态里已经有什么

**记忆这一层社区已经做过两遍**，所以不自造第三套，也不复制别人代码：

| 包 | 版本 | 做什么 | 我们的态度 |
|---|---|---|---|
| `dsh-memory` | 0.1.0 | 单文件 SQLite FTS5 记忆库 + 三个工具 + 提示段 | **只借鉴**（该包未随分发提供 LICENSE 文本） |
| `dsh-life` | 1.0.0 | L1–L6 记忆层（半衰期）+ R1–R8 想起通道 + 惰性衰减 + 再巩固 + `why_recalled` | **只借鉴**（npm 包自带 MIT LICENSE，但无公开仓库；仍按重写处理） |
| `dsh-anima` | 2.2.3 | 人格/角色 + 工作区两级覆盖 + 带待审缓冲的长期记忆 | **只借鉴**（MIT + 公开仓库） |
| `dsh-mnemon`（已移除） | 0.5.46 | 交互期热记忆注入 | 2026-11-19 从宿主卸载；记忆只由 living 管 |

**本插件的不可替代价值只有四块**：时钟、自主循环、感官（浏览器/视频/网页）、人格落地。

### 0.1 许可政策（D0：只借鉴思想，不复制代码）

版权保护表达，不保护思想与算法。以下照着重写，**不产生任何许可义务**：

| 借鉴什么 | 来源 | 我们写成 |
|---|---|---|
| L1–L6 分层与半衰期取值 | `dsh-life` | `lib/layers.mjs` |
| R1–R8 想起通道的划法 | `dsh-life` | `lib/recall.mjs` |
| `strength(t)=strength₀·exp(-Δt/S)` 惰性衰减 | `dsh-life` | 独立实现 |
| 内容指纹键 `sha1(scope\|kind\|target\|text)[:16]` | `dsh-life` | `lib/store.mjs` |
| 「没有通道命中不许浮现」+ `why_recalled` | `dsh-life` | `lib/recall.mjs` |
| 待审缓冲区的状态机 | `dsh-anima` | `lib/audit.mjs` |
| FTS5 存储布局 + 提示段召回 | `dsh-memory` | `lib/db.mjs` |

**核心与协议包因此不需要第三方 NOTICE**；两颗宝石各自 vendor 了 qrcode-generator（MIT），按规则在包内保留 `LICENSES/` 并登记。⚠️ 一旦将来真抄了代码，必须补 `LICENSES/` + NOTICE + 原版权行，并把 `LICENSES/` **显式写进 `files`**（npm 只自动打包根目录的 `LICENSE`）。

### 0.2 命名

| 层 | 名字 | npm 状态 |
|---|---|---|
| 核心插件 | `dsh-living`（`dsh-life` 已被占） | ✅ 空闲 |
| 扩展单元 | **WorldGem** | ✅ `worldgem` / `dsh-gem` 均空闲 |
| 宝石包 | `dsh-gem-<name>` | 前缀空闲 |
| 清单文件 | `worldgem.json` | — |
| 代码类型 | `WorldGem` / `WorldGemManifest` | — |

---

## 1. 包形态

```json
{
  "name": "dsh-living",
  "license": "MIT",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
  "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0-0", "node": ">=22" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings"] }
  },
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "autonomy", "agent-life"]
}
```

`engines.dsh` 用**精确区间**而非 `*`：`*` 连 `99.0.0` 都放行，等于放弃版本防护。

## 2. 目录

```
dsh-living/
  package.json
  cordis.patch.yml        # 挂插件 + 注册 living preset
  index.js                # host 半端
  client.js               # 设置页
  lib/
    clock.mjs             # tick / next_wake / 退避 / 恢复
    db.mjs                # node:sqlite，schema 与迁移
    layers.mjs            # L2–L5 分层判定
    recall.mjs            # R1–R8 通道与打分
    store.mjs             # events / episodes / facts / cold / 指纹
    import.mjs            # 文本记忆导入（markdown / jsonl / plain，幂等）
    memory.mjs            # L0 组装与注入预算
    consolidate.mjs       # rest / 夜睡
    budget.mjs            # token / 动作 / 自唤醒上限
    audit.mjs             # pending + 白名单 + 限制层
    persona.mjs           # charter + self + journal 组装
    gems.mjs              # WorldGem 加载器
    senses/browser.mjs    # CDP / Playwright
    senses/video.mjs      # 字幕 → ASR → 抽帧
    senses/web.mjs        # ctx.web seam
    round.mjs             # 起一轮、等结束、收尾
  prompts/                # prompt 片段
  test/                   # node --test
```

## 3. Host 插件契约（真实 API，已核对）

```js
export const name = 'living'
export const inject = ['tools', 'webServer', 'settings']   // 只列真正必须的
export const Config = z.object({
  l0Tokens: z.natural().default(3000).extra('volatile', true),
  /* …每个字段都要 .extra('volatile', true) */
})
export async function apply(ctx, config) { /* … */ }
```

### 六个必踩的坑（全部来自 `dsh-bili-scroll` 的实战注释）

1. **Config 每个字段必须 `.extra('volatile', true)`** —— `settings.update()` 只认 volatile 字段，否则抛 `Plugin entry … has no volatile fields`。
2. **loader entry 的 id 必须等于命名空间名**，且模块必须导出 `Config`。
3. **不要裸 import 可选 peer 依赖** —— 桌面版 `autoInstallPeers: false`，拿不到会让**整条插件不激活**。从宿主树里取，取不到再退本地等价实现。
4. **schema 里别写会校验失败的约束**（如 `.max(20)`）—— 校验不过 ⇒ cordis 拒收 entry ⇒ 整条插件不激活。范围钳制放到读写两头。
5. **tick 回调必须 try/catch** —— `setInterval` 里抛的错没人接，会带走宿主进程。
6. **所有后台 timer 都要 `.unref()`** —— 否则它成为"进程为什么退不出"的答案。

## 4. 一轮的生命周期

```
clock.tick()                      ← 30/60s，纯代码，0 模型成本
  └─ 判定 due（自动网格 / 日程 / 逾期承诺 / 事件）∧ 预算 ∧ running
      └─ 主会话（用到 rest/夜睡；换后 id 记在 state['session.current']）
          ├─ system prompt ← living:prelude（人格 + 全部宝石 skill + 信任边界；每会话一次）
          ├─ 无 agent → agents.create；重启后 agents.resume(上次 id)
          ├─ 隐藏模式轮前 unarchive（归档态被 pre-step 闸门拒绝）
          └─ agent.followup(首轮：L0 + 情境 + 新事件 + 指令；后续：情境 + 新事件 + 指令)
              └─ 等 turn/end
                  ├─ 写 events（原始层）
                  ├─ 外发进 pending/ → 审计 → outbox
                  └─ 写 anchors，更新 state.next_wake；轮末按可见性归档
```

会话生命周期：**同一个活 agent 跨轮复用，直到 rest 或夜睡**；两者都在 `consolidate` 时轮换（`dispose` 旧 agent、归档旧会话、清空 state）。rest 由上下文保险触发，夜睡由 `nightAt`（默认 03:30）触发。宿主重启后按 `state['session.current']` 恢复同一条对话。超时/中断只 `cancel` 当前 turn，不拆 agent。

主会话标题在创建时固定为 `living-YYYY-MM-DD-N`（N 为当天新建会话序号，本地午夜重置；恢复会话不占号；宿主 `sessionTitle.rename`，pinned，自动标题不会覆盖）。轮换后的新会话取下一个序号。

静态段进系统提示词：`living-agent` 在 agent scope 注册 `living:prelude` 系统段（charter/self/journal + 全部宝石 skill + 外部内容边界），**每个会话捕获一次**；每轮 user 消息只带情境、新事件、本轮指令与动态宝石注记。**L0 只在会话首轮注入一次**，后续轮次靠会话上下文保留；睡眠换会话后的首轮重新注入。第二轮起不再重复海量静态注入，前缀缓存落在系统段上。

侧栏可见性是**归档集合的开关**，不是会话属性：隐藏模式轮末归档、轮前解档；可见模式不归档。管理面 `sessionVisibility` 即时切换（空闲立即归档/解档，轮次进行中在轮末落地），不需要换会话。归档会话被宿主的 `archived-session-gate` 拒绝 `agent/pre-step`，所以解档必须先于 `followup`。

`CreateAgentOptions.meta.agentPreset` 只写会话头，**不会**自动挂载 preset；agent 的 `setup(agentCtx)` 里必须调用 `ctx.agentPresets.mount(agentCtx, id)`，preset 组合才会以 `retain → mount → bind` 绑到该 agent 的 scope。**窄口由组合决定，不靠模型自觉。**

**兜底**：`spawn dsh --profile headless <prompt>`（`dsh-bili-scroll` 已验证）。

## 5. 存储

`node:sqlite` 内置（Node 26 实测：SQLite 3.54.1，**FTS5 可用**）→ 零原生依赖。

```sql
events(id, ts, kind, actor, source, payload, session_id, refs)
raw_segments(id, session_id, kind, ts_start, ts_end, payload, status,
             created_at, processed_at, attempts, last_error)  -- rest/sleep 的半规格化快照
episodes(id, ts_start, ts_end, title, summary, importance, event_ids, raw_refs)
facts(id, subject, predicate, object, confidence, first_seen, last_seen,
      source, event_ids, raw_refs)
facets(memory_kind, memory_id, dim, value)        -- when/who/what/why/how
memory_edges(id, from_kind, from_id, relation, to_kind, to_id,
             note, confidence, raw_refs, model, created_at, status)  -- 三段式关系边
memory_items                                       -- episodes/facts 的统一只读视图
memory_vectors(source, id, ts, text, model, dim, hash, vector)
                                                  -- 回想区段预测的 embedding 索引（D-57）
reports(date, generated_at, live, json, markdown, html)  -- 日报归档，Markdown 为 UI 主视图
access(memory_kind, memory_id, ts, kind, weight)  -- inject/retrieve/cite/negative/confirm
cold(keyword, event_ids[3], label_20char, last_ts, importance, fidelity)
anchors(round_id, started_at, ended_at, trigger, trigger_detail,
        session_id, outcome, error_code)          -- 观测锚点，见 §12
state(key, value)                                 -- next_wake/budget/cooldown/cursors
outbox(id, gem, target, text, media, visibility, origin, attempts, created_at, next_attempt_at,
       claimed_at, acked_at, external_id, failed_at, last_error)  -- pull 队列
ingest_seen(gem, external_id, event_id, seen_at)  -- 入站去重（长轮询会重投）
imported(key, source, ts, text)                   -- 文本导入幂等
persona_docs(kind, text, updated_at)              -- 当前 charter / self
journal_entries(id, date, ts, text, source, created_at)  -- 按日 journal
notes(id, seq, tier, tag, text, core, day, created_at, updated_at)  -- 手写笔记：persistent/temp；seq 为视图槽位（D-60）
persona_versions(id, ts, kind, actor, action, message, previous_id, text, diff)
                                                  -- charter/self 版本：全文快照 + 对上一版的 diff
memory_fts(memory_kind, memory_id, tokens)        -- FTS5 检索索引（中文双字/四字）
```

三层在同一个 `life.db`：raw（events + raw_segments）→ normalized（episodes/facts + facets）→ graph（memory_edges）。rest 只采集 raw 和轻量 episodes；夜睡用 `living-memory` 专用无工具 preset 把 pending raw 整理成 items/facets/edges；模型失败 3 次后走确定性 fallback。边是派生数据，召回 G1 沿边扩 1 跳。详见 `docs/R16-MEMORY.md`。

`memory_vectors` 只服务回想子 agent 的时间区段预测，不参与 L0/recall 的事实召回；模型或 URL 变更时整表清空并按需重建。

笔记是独立于记忆的手写库（D-60）：S 持久 50 条 × 40 字 + ≤5 字 tag（core 全文、其余只注入关键词索引）；A 今天 / B 昨天临时每天 10 条 × 40 字（全文、B 只读），第二个 sleep 后过期。编号 S/A/B 是当前视图槽位：删除留空、不重排，新写/升/降取最小空闲槽，跨天 A 同序号变 B。容量由注入预算反向定义，store 单点拒绝。会话续接（D-61）：非 sleep 轮换/重启走外部压缩交接（确定性尾部兜底），sleep 是边界、不续接。

日报也进 `life.db` 的 `reports` 表（JSON + Markdown + HTML），不再写 `reports/*.json|html|md` 零散文件；UI 日报页按日历选日期，下面直接渲染 Markdown。persona 的 `charter` / `self` / `journal` 也在 `persona_docs` / `journal_entries`；旧 `charter.md` / `self.md` / `journal/*.md` 在启动时一次性导入，之后文件不再写。媒体仍以文件存放，DB 存路径与元数据；宿主 session 日志仍由 DSH 管理。

**记忆独占**（§7.6）：本库是唯一所有者，不与其他记忆插件共存。指纹键 `sha1(source|kind|target|归一化文本)[:16]` 用于去重与幂等导入，不再用于「旁挂别人的存储」。

### 5.1 写并发约定（S3 实测结论）

`node:sqlite` 是**同步 API**，所以：

| 场景 | 结论 |
|---|---|
| 进程内 tick 与一轮同时写 | **必须走单写队列**；两条连接并行开写事务会同步阻塞、`busy_timeout` 到期后报 `database is locked`（单线程里 setTimeout 排不上，永远等不到解锁） |
| 跨进程写（子进程轮次 / 解析器） | `PRAGMA busy_timeout=3000` **有效**，实测等待 360ms 后成功 |
| 失败识别 | `ERR_SQLITE_ERROR` + `errcode 5` + `database is locked` |
| 吞吐 | 1000 条事件批量写 **1ms**，瓶颈不在这里 |

⇒ 实现上：**一个写连接 + 一个串行队列**（`withWriteLock`），所有写经由它；读可以另开连接。

### 5.2 living home 布局

```
$DSH_HOME/living/
  data/
    life.db              # 本节的库；+ 运行时 -wal / -shm
    gems/<id>/           # 宝石 config.json、凭据、media
    backups/             # 手动备份与导入前自动备份
    imports/             # 待替换的导入库 + pending 标记
    legacy/              # 旧 charter.md / self.md / journal / reports
  workspace/             # agent cwd（meta.cwd）
  gems/                  # npm 宝石代码（可重下）
```

- 旧布局（`home/life.db`、`$DSH_HOME/living-gems/<id>`、根目录旧 persona 文件）在启动时幂等迁移；日志逐条打印。
- `data/` 与 `workspace/` 永不自动删除；卸载 `dsh-living` 只移除插件代码。`gems/` 是代码，卸载单颗宝石时删除其包目录。
- 备份：`VACUUM INTO` 生成一致快照，浏览器保存；导入：校验 SQLite 头、`integrity_check`、`user_version <= SCHEMA_VERSION`、必需表，暂存到 `imports/`，下次启动先备份当前库再替换。更高 schema 大声拒绝。
- agent 的 cwd 是 `workspace/`，不再与 `life.db` 同目录；但 cwd 不是沙箱，隔离仍靠工具面与宿主沙箱。

## 6. 时钟与唤醒

```
next_wake = min( 日程表最早未完成项 , 夜睡时刻 )
            受睡眠窗屏蔽；自动唤醒不写进这个硬截止
推送事件：ingest 接受后立即 nudge 一次 tick，不等定时器
          是否响铃（ring/silent）与预算策略（limit/count）由宝石清单声明（§9.5）
          正在跑轮次时只置 pending，该轮结束后立刻补一次，不抢占
```

### 6.1 自动唤醒：网格 + 期望和 + 热冷时域

一天按本地零点切成等距网格，大小只能是 `10/20/30/40/60 min`（必须整除 24h）。
每个网格再按 `30/60s` 采样切成 `n` 个点：

```
n = gridMinutes × 60 / sampleSeconds
```

- 网格分类：沾到热区 → `hot`；否则沾到冷区 → `cold`；否则 `normal`。
- 优先级 `hot > cold > normal`，不看重叠时长：沾到就算整格。
- 三类分别配置“每格期望”：`normalExpected / lowExpected / highExpected`，UI 显示全天期望和。
- 每个网格进入时，先生成 `n` 个正态概率点（中心在网格中点，σ = 网格长度 × 5 个固定比例之一），归一化到 `Σp_k = λ_g`。
- σ 轮盘固定 5 档：`1/12, 1/8, 1/6, 1/4, 1/2`，等权；配置端按 `λ_max = Σw / max(w)` 过滤：
  只允许 `λ_g ≤ λ_max` 的 σ 进入轮盘；若一个都不剩，配置直接拒绝。
- 模式固定：60% 保持正态顺序，40% 打乱这组概率值；打乱不改变多重集和 `λ_g`。
- 每个采样点：`U ~ U[0,1)`，`U < p_k` 则起一轮自动触发；每点最多一次。
- running 期间不抽，错过的点作废、不补；结束后从当前时间点继续。
- 自动唤醒与外部事件各跑各的：事件不消耗网格，但事件轮占用的 running 时间会让自动点作废。

自动唤醒的 anchor `trigger=auto`，`trigger_detail` 记录网格、σ、模式、λ、p。配置页渲染 24h 时间尺（热/冷/normal）与全天期望估算。**RNG 与时钟都必须可注入**。

### 6.2 醒来优先级

| 优先级 | 条件 | 动作 |
|---|---|---|
| 1 | `ring` 外部事件到达 | 起事件轮；当前自动点作废 |
| 2 | 日程到期 | 起日程轮；当前自动点作废 |
| 3 | 夜睡窗口 | 进入睡眠；睡眠期间自动点全部作废 |
| 4 | 自动网格当前点 `U < p_k` | 起自动轮 |
| — | 未命中 / running | 睡眠或跳过；不叫模型 |

### 6.3 日程表

`{at, intent, done, missed}`：到期即做；过期 < 30min **补做**；> 30min 标 `missed` 写事件、**不补做**。只在插件设置页展示，**不进 DSH `schedule` 面板**。

### 6.4 rest 与夜睡

|  | rest | 夜睡 |
|---|---|---|
| 触发 | 上下文保险（默认 1M 的 70%） | `period: 1d`，`at: nightAt`（默认 03:30），不可跳过 |
| events → episodes | ✅ | ✅ |
| 降级到冷区 | ❌ | ✅ |
| 重写 self | ❌ | ✅（默认；DB 版本化） |
| 换会话 | ✅ | ✅ |
| 日报 | ❌ | ✅ |
| handoff | ✅ 先写会话桥，再换 | ❌ |

rest 的 handoff 用同一会话追加一次短模型调用，产物只存 `session.handoff`，新会话首轮注入一次后清除；不写 episodes/facts/facets。**睡眠本身不由上下文余量触发**；上下文保险只触发 rest，不触发夜睡。

### 6.5 恢复与重启激活

插件加载时只跑一次启动判定：

| 情况 | 动作 |
|---|---|
| `sleepingUntil > now`（有记录的睡眠） | 不打扰，按睡眠计划醒 |
| 已过期（`now > next_wake`） | `recovery` 轮：最多补跑一次，不补历史 |
| 未过期且 `startupRound=true`（默认） | `startup` 轮：立即重新挂载会话、应用最新 charter/self、校准时间轴；**不消费待处理事件**，留给下一 tick；只一次 |
| `startupRound=false` | 不激活，等正常 tick |

启动轮是普通计费轮（`AGENT_POLICY`），预算耗尽时进 `BUDGET_HOLD` 不跑。判定失败只记日志，不抛。

### 6.6 为什么"日会话 + 两次刷新"是成本最优

上下文 1M（`1048576 = 2²⁰`，已核实）。一天几十轮塞不满 ⇒ **容量不是约束**，约束是：

1. **每轮读入成本**：会话前缀在使用期间不动 ⇒ 缓存命中；每次实际睡眠重建一次（一天最多两次）
2. **注意力稀释**：1M 里塞 300k，早上的细节照样糊 ⇒ L0 不是"压缩替代品"，而是**当下索引**（"今早在 X 发现 Y，细节在会话第 N 轮"）

**排布铁律：会变的排后面，不变的排前面**（§14）。L0 紧贴首轮指令；同一会话后续不重复，换会话首轮重新注入。

## 7. 记忆

### 7.1 分层（借鉴取值，独立实现）

| 层 | 半衰期 | 用法 |
|---|---|---|
| L2 情节 | 事件 21d / 话题 7d | 温区检索候选 |
| L3 语义 | 180d | 温区检索候选 |
| L4 程序 | 10y | 与 skill 并列放在 prompt 稳定区（技能不是回忆） |
| L5 自传 | 永不 | charter / self，不进衰减 |

物理上同一个 `life.db` 分三层：raw（`events` + `raw_segments`）→ normalized（`episodes`/`facts` + `facets`）→ graph（`memory_edges`）。rest 采集 raw + 轻量 episodes；夜睡用 `living-memory` 无工具 preset 整理 pending raw，写描述/刻面/关系边；召回 G1 沿边扩 1 跳。详见 `docs/R16-MEMORY.md`。

### 7.2 遗忘是降维，不是删除

| 层 | 外观 | 每轮成本 | 它"知道"什么 |
|---|---|---|---|
| 热区 L0 | 摘要注入 | 2–3k token | 记得内容 |
| 温区 | cue 命中 → 摘要 + `why_recalled` | 按需 | 想起来才记得 |
| **冷区** | **只有关键词 + 指针** | ~10 token/条 | 只知道自己记得有这么回事 |

冷区注入形如：`你隐约记得（2026-09）：显卡 / 散热 / 换风扇 —— 细节已不可考`

- 保留 **20 字原文锚**，防止关键词被改写后失真
- 每关键词最多 3 指针；每轮最多注入 8 条线索；同一关键词一周内不重复
- `events` 原文永不删：冷区从"可注入"降为"可考证"
- **降维在夜睡**：`strength(t) < 0.15`（≈41 天）→ 摘要丢、抽关键词、写 `cold`

### 7.3 低保真的两条硬规则

想不起来就如实说"忘了"，**不建修复机制**——编造的成本比承认高。

1. 冷区注入带 `fidelity: low`，措辞固定为"隐约记得…细节想不起来了"
2. **低保真不得作为行动依据**

| 用途 | 低保真 |
|---|---|
| 发言 / 提及 / 闲聊 | ✅ |
| 行动 / 决定 / 替人办事 | ❌ 先查原文或直接问 |

即：**记忆影响它说什么，不影响它做什么**。

### 7.4 其它

- 衰减**惰性计算**（读时现算），不跑定时器、不天天写盘
- 再巩固：+strength、−fidelity、+version、+rehearsal
- 每条召回带 `why_recalled`；没有通道命中的记忆不许浮现
- 候选池只收 `message` / `notice` / `agent_mark` / `import` 与未整理的 journal；`round`、`outbound_decision`、`auto_*` 等运行流水只留在账本
- journal 先作为 L5 直接召回；夜睡送入独立 raw 整理，归一化条目接管后直接条目让位（避免同一条内容出现两次）
- 有 cue 时 R3/R4 不得单独让条目浮现；无 cue 的 L0 仍按近因/显著组装
- journal 是叙事，排序低于归一化的事实/情节（`JOURNAL_SCORE_FACTOR`）

### 7.5 参数

| 项 | 默认 | 可调 |
|---|---|---|
| `demoteThreshold` | 0.15 | ✅ |
| 冷区注入上限 | 8 条/轮 | ✅ |
| 线索指针数 | 3 | ✅ |
| L0 预算 | 3k token | ✅ |

### 7.6 记忆独占与导入

**记忆只能有一个所有者。** 两套记忆并存的必然结局是：A 记住的 B 不知道、B 改了的 A 会覆盖，最终谁说的都不可信。因此本插件**不与任何外部记忆插件共存**（`mnemon` / `dsh-memory` / `dsh-life` / `dsh-anima` 均不接管记忆）。

**"禁止"的现实形态是隔离 + 警告，不是卸载别人：**

| 做法 | 效果 |
|---|---|
| preset 不包含其他记忆工具 | 结构隔离：它调用不到 |
| 启动检测到其他记忆插件在注入 | 明确警告，建议在该 profile 禁用 |
| 文档写死：不要共用第二个记忆源 | 责任边界清楚 |

### 导入接口（只进不出）

```
living_import({ format, source, text, tags?, ts? })
```

| 格式 | 切段 | 落库 |
|---|---|---|
| `markdown` | `§` 或 `##` | 每段一条 |
| `jsonl` | 每行 `{ts, kind, text, tags}` | 一行一条 |
| `plain` | 空行 | 一段一条 |

1. **幂等**：`sha1(source|text)[:16]` 去重
2. **来源标记**：`source=import`，`origin=<文件名/URL>`
3. **默认进 L3，不直接进 L0**——导入内容未被验证，不能一上来占热区
4. **无 provenance**：回溯不到 `event_ids`

### 一条统一规则：出处决定它能不能驱动行动

| 记忆来源 | 能发言 | 能当行动依据 |
|---|---|---|
| 自观测（有 `event_ids`） | ✅ | ✅ |
| 自观测但已降维（低保真） | ✅ | ❌ |
| **导入（无 provenance）** | ✅ | ❌ |

比按来源逐条分档更稳：**有没有可回溯的出处，决定它能不能驱动行动**（与 §7.3 同源）。

### 7.7 睡前自由环节与自主写 self

`charter` 是人类写的底座（agent 只读）；`self` 由主会话在睡眠的第一阶段自己写。两者存 `persona_docs`，版本存 `persona_versions`。

```
sleep 触发
  ├─ capture raw                      ← 先做；自由环节的消息不进 raw
  ├─ freetime：主会话自由回合（runner；不注入 L0/digest）
  │    ├─ living_write_self 开放：只暂存一版，后写覆盖
  │    └─ 也可写 journal、整理日程/待办、回想，或什么都不做
  ├─ 提交暂存 self                    → persona_docs + persona_versions（一版，diff + 快照）
  ├─ normalize / embed / gems
  └─ rotateSession(kind)              ← 新会话下次挂载时读取新 self
```

- 窗口：任意 sleep 触发（夜睡 tick / 手动睡）都打开；无主会话时由 `runner` 新建。`persona.evolve=off` 只关 self 窗口，自由环节照跑。
- `living_write_self` 窗口外 loud throw；窗口内只写内存暂存，回合结束统一提交；回合被超时/硬顶截断但已暂存也提交。
- 独立硬顶 `selfBudgetTokens`（默认 8,000,000，UI 可配）：绕过 `dailyTokens` / `dailyRounds` / `BUDGET_HOLD`；tokens 记入当日账本但不计 rounds；`unlimited` 手动睡绕过硬顶；`0` 关闭该环节。
- 没写 self 记 `persona_self_skipped`；提交失败保留旧 self；失眠（raw 剩余）与自由环节失败在状态页并列，互不阻断。
- 状态页：睡眠进度含 `freetime` 步；上次睡眠卡显示“写 self（字数）/ 未写 / 超预算 / 失败 / 跳过”。
- 人设页独立一页：charter 编辑（人类写）、self 手工编辑/清空、模式、版本轨迹（diff 查看/恢复）、今日 journal（`journal_entries`，按 Markdown 渲染）。占位/空 charter 会显式警告并给模板。
- **新 self 只在下次会话挂载时生效**：系统提示词按会话捕获，当前会话仍用旧 self。

## 8. 预算与审计

- 双闸：日预算（`dailyTokens` / `dailyRounds`）+ 上下文保险（`roundTokens`，按模型上下文 1M 的 50%–80% 选，默认 70% = 700k）
- **上下文保险看最后一次模型调用的 input + cacheRead + output**，不是整轮累加；超限写 `context_guard`，先 handoff 再 rest + 换会话，不锁天；只有日预算耗尽才进 `BUDGET_HOLD`
- 推送轮的预算由宝石清单 `notify.budget` 决定：`limit:false` 绕过日闸和上下文保险，`count:false` 不计 token/轮次
- 睡前自由环节走独立硬顶 `selfBudgetTokens`（默认 8M，UI 可配）：日预算耗尽也允许一次；只计 token、不计轮次；调用前按上次上下文预估，回合内累计超限即 cancel
- 设置页提供"重置今日用量"：清当日计数、解除 `BUDGET_HOLD`、写 `budget_reset` 审计事件；不删历史与待处理事件
- 外发：白名单私聊 → 规则表也跳过、静默直发；其余 → 规则表（public/group 再过限制层）→ 放行或拦截，无人工待审
- **公开可见的发声强制过限制层**（§9 `visibility: public|group`）
- 内容注入：外部内容包成 `untrusted` 段；**影响"知道什么"，不影响"能做什么"**

### 8.1 限制层（三道闸，从便宜到贵）

```
① 规则表     关键词/联系方式/链接/长度/@对象      零成本，命中即拒（私聊 + 白名单目标跳过此闸）
② 子 agent   {text, channel, audience} → {pass, rule_id, reason}
             无工具、输入结构化、只判"命中哪条规则"
③ 白名单     已知安全对象（你自己 / 指定群）；私聊直通，公开/群仍需过前两闸
```

规则表可枚举（R-01 泄露隐私 / R-02 承诺 / R-03 立场 / R-04 攻击 / R-05 引流），因此**可回归测试**。

## 9. WorldGem：扩展模型

**扩展单元 = 一颗宝石 = 一个 npm 包 + 一份清单 + 三件可选的东西。**

```
dsh-gem-bili/
  package.json
  worldgem.json          ← 清单
  mcp/                   ← ① 能力（MCP server / 引用）
  channel/               ← ② 事件（ingest / outbox 参考实现）
  skill/SKILL.md         ← ③ 给模型的知识
```

| 宝石类型 | MCP | 事件 | skill | 例子 |
|---|---|---|---|---|
| 纯能力 | ✅ | ❌ | ✅ | 搜索、字幕 |
| 纯事件 | ❌ | ✅ | ✅ | 网页哨兵 |
| 完整 | ✅ | ✅ | ✅ | B站、微信 |

**三件都不强制**；一颗宝石至少交一件。

**分发**：宝石是普通 npm 包，由 living 自己管，不是 DSH 插件。Living → 宝石 → 添加宝石 从内置目录（`packages/core/gems/catalog.json`）安装到 `<home>/gems`；安装禁用生命周期脚本、固定精确版本、校验 `worldgem.json` 的 id。开发时仍可用 `gemDirs` 指向本地目录。早期考虑的 `dsh.bundle` 方案已放弃——那会让每颗宝石在 DSH 插件列表里占一行。

### 9.1 清单

```json
{
  "id": "bili", "name": "B站", "version": "0.2.0",
  "mcp":   { "command": "node", "args": ["mcp/server.js"], "tools": ["bili_search", "bili_subtitle"] },
  "event": { "protocol": ["ingest", "outbox", "ack"], "visibility": "public" },
  "channel": { "command": "node", "args": ["channel/run.mjs"] },
  "notify": {
    "push":    { "mode": "ring", "budget": { "limit": true,  "count": true  } },
    "trusted": { "mode": "ring", "budget": { "limit": false, "count": false } }
  },
  "skill": "skill/SKILL.md",
  "capabilities": { "text": true, "image": true, "voice": false, "group": false },
  "limits": { "maxChars": 4000, "perMinute": 10 },
  "etiquette": ["B站评论是公网发言，必须过限制层", "cookie 会过期，失效要提示重扫码"],
  "config": {
    "fields": [
      { "key": "dmPollSeconds", "label": "私信轮询", "type": "number",
        "default": 30, "min": 15, "max": 600, "unit": "秒", "group": "轮询" }
    ]
  },
  "failure_hints": {
    "gem_cookie_expired": "登录态失效，需重新扫码",
    "quota_exceeded": "额度用尽，已排队"
  }
}
```

核心读清单后**自动生成三样**：MCP 工具注册 · 事件端点绑定 · skill 注入段（含限制/礼仪/失败语义）。

`config.fields` 是第四样：宝石声明自己的配置控件（`text / textarea / number / boolean / select / list` 六种有限类型，带 default/min/max/step/options/group/help），核心渲染成原生表单并校验后写入宝石家的 `config.json`；未声明的 key 保留，运行时 clamp 仍归宝石。宝石不写前端。

### 9.2 Channel 协议（v1 定稿）

**入**：
```http
POST /living/ingest          X-Living-Token: <per-gem token>
{ "gem": "bili", "kind": "message", "external_id": "dm_123",
  "from": {"id": "uid_9", "name": "小明"}, "text": "在吗", "ts": 1763356800, "meta": {} }
→ { "accepted": true, "event_id": "ev_7", "wake": "immediate" }
```

`wake` 是真实语义：`immediate` = 已调度一次立即 tick；`none` = 重复事件，或该宝石配置为 `silent`（只落库，等下一轮顺带处理）。

**出（pull，不是 push）**：
```http
GET  /living/outbox?gem=wechat&limit=20
→ [ { "id": "out_9", "to": "me", "text": "文件在这", "visibility": "private",
      "origin": "proactive",
      "media": [{ "path": "/path/to/a.pdf", "kind": "file" }], "attempts": 0 } ]

POST /living/outbox/out_9/ack     { "ok": true, "external_id": "dm_999" }
```

四条规矩：`external_id` **必填且去重**（长轮询会重投）· **ack 前不删、超时 5min 重投** · 每 gem 独立 token · per-gem 限流。

**媒体**：`living_send` 的 `media` 是绝对路径数组，核心只记录路径，不读文件；宝石通道发送时自己读取。
**来源**：`origin=event` 表示该轮由事件触发，其余记 `proactive`；主动发送的额度与限速由各宝石通道自己控制，core 不设统一日限。

**出用 pull 的理由**：宝石可能跑在任何地方（本机/另一台/容器），pull 让它自己决定节奏，核心不需要能连到它，NAT 后面也能工作。

**通道进程**：清单里的 `channel` 由核心拉起并监督（5s→60s 退避；`exit 2` 视为未登录，按最长间隔重试）。宝石不需要再配 systemd / tmux 之类的旁路守护。

### 9.3 为什么 skill 是必需的一半

协议只解决"怎么传"，skill 解决"什么时候传、传什么、传成什么样"。缺了它，模型会：一口气发 15 条（10 条额度）· 半夜主动汇报（24h 窗口发不出）· 发语音（客户端静默丢弃）· 贴 markdown 图片（只剩裸链接）。

**这些都是 `dsh-wechat` 开发者文档里的真实限制——现在写给人看，我们要求写进清单变成给模型看。**

### 9.4 能力扩展与事件扩展是两条腿

- **能力** = 装一颗宝石（或直接加 MCP 服务器）
- **事件** = `POST /living/ingest`（不写代码、不装插件也行）

### 9.5 `notify`：推送的响铃与预算策略（清单声明）

```json
"notify": {
  "push":    { "mode": "ring",   "budget": { "limit": true,  "count": true  } },
  "trusted": { "mode": "ring",   "budget": { "limit": false, "count": false } }
}
```

| 字段 | 含义 |
|---|---|
| `mode` | `ring` = ingest 接受后立即 wake 一轮；`silent` = 只落事件，不唤醒，下一轮顺带处理 |
| `budget.limit` | `false` = 日额度 HOLD 时这轮照跑，且上下文保险不生效（只剩超时） |
| `budget.count` | `false` = 这轮的 token 与轮次数都不计入日预算 |

- `trusted` 对应 `meta.trusted === true`（绑定主人）；缺省逐字段继承 `push`。
- 单条事件可被宝石标 `meta.silent === true`，覆盖清单策略为 `silent`（系统通知、回执这类噪声走这条）。
- 缺省策略 = `ring` + 全计费，即旧行为。
- 混合批次：任一触发事件豁免 → 整轮放行；任一触发事件计费 → 整轮计入。
- agent 主动轮（heartbeat / schedule / recovery / explore）不属于推送，固定 `limit+count`。

微信清单：`push` 全免（主人私聊不设预算）；B站清单：`push` 计费，`trusted`（我）免。

## 10. `living` preset 的工具面

允许：

- `living_state` / `living_journal` / `living_mark` / `living_plan` / `living_send` / `living_web_fetch`
- `living_write_self`（仅睡前自由环节窗口；只暂存一版，环节结束统一提交）
- `living_recollect`（慢回想，唯一记忆查询入口） / `living_events`（只读）· `living_import`（只进不出）
- 主 agent 不注册 `living_recall` / `living_memory_*`；`living_memory_segments|overview|scan|get` 只在回想子 agent 内可见
- `read` / `read_image` / `write` / `edit`（写由会话 cwd 沙箱收口到 workspace 与 /tmp）
- `glob` / `grep`
- `web_fetch` / `web_search`
- 宝石提供的工具（按启用的宝石）

禁止：

- `bash` / `pwsh`
- 沙箱外的任意路径 `fs` 写
- `subagent` / `workflow`（绕开限制）
- 未启用宝石的工具
- 任何写回/修改记忆的工具

工具组由 preset 组合钉死（D-31、D-48）；web profile 把编码类工具从宿主平面挪进 preset，所以不在组合里的工具（如 `bash`）连注册都不存在。

profile 级 MCP 与其余全局工具不再软屏蔽（D-50，2026-11-19）：工具面由 preset 组合决定，组合外的 shell / subagent / workflow 本就不存在。记忆隔离改为提示词约定——只有 `living_*` 与本库注入的记忆可信，外部记忆不检索、看到只当参考。

## 11. 失败与降级

### 11.1 五态机

| 状态 | 含义 | 自动唤醒 | 用户消息 | 恢复 |
|---|---|---|---|---|
| **RUNNING** | 正常 | ✅ | ✅ | — |
| **SLEEPING** | 夜睡 | ❌ 屏蔽 | ✅ 可打断 | 到点 |
| **DEGRADED** | 局部能力坏（某宝石挂、浏览器起不来） | ✅ 只做不用该能力的活 | ✅ | 半开探测 |
| **BUDGET_HOLD** | 日额度耗尽 | ❌ | 按 `notify.budget.limit`（false 直通；`count` 决定是否计费） | 次日 / 设置页重置 |
| **HALTED** | DB 打不开 / 迁移失败 / 认证失效 | ❌ | ❌ | 只靠人 |

**判定阈值**：连续 **3 轮失败** → DEGRADED；连续 **3 次探测成功** → RUNNING。

### 11.2 四个原则

1. **降级分级**：能力级（某宝石挂）不等于全局级（DB 坏）
2. **半开恢复**：熔断 + 探测退避（1min → 5min → 30min），探测是 ping 不是完整一轮
3. **重试只给可能有用的失败**：瞬时错（超时/限流）重试 1 次；认证/配额/配置错**不重试**
4. **降级状态注入它自己的 prompt**：

```
你现在处于 DEGRADED（原因：B站宝石不可用），本轮不要声称看过视频。
```
否则它会在日记里写它没做过的事。

### 11.3 失败码（结构化，统一）

`provider_auth` · `provider_quota` · `provider_rate` · `provider_timeout` · `gem_unavailable` · `gem_cookie_expired` · `browser_launch_failed` · `db_locked` · `db_corrupt` · `config_invalid` · `budget_exhausted` · `context_guard` · `window_closed` · `unknown`

宝石在 `failure_hints` 里**只提供文案**，码表在核心——这样跨宝石可聚合、可统计、可决定是否重试。

### 11.4 可见性

| 面 | 内容 |
|---|---|
| Living 面板（主界面左侧栏图标） | 状态徽标 + 原因 + 已持续时长；主会话可见性开关 |
| 邮件 | HALTED / BUDGET_HOLD 立即发（**不走微信**，24h 窗口不可靠） |
| 报表 | 异常栏：失败轮 / 降级时长 / 错过的日程 |

## 12. 观测面

**不双写：细节留在源头，插件只写锚点，解析器每日固化。**

### 12.1 锚点

MCP 日志与会话记录都不含"这轮为什么开始"；更关键的是**跳过的轮次**在任何源头都不留痕——那正是"它为什么没动"的唯一线索。

插件只写 8 列（§5 `anchors`）：`round_id / 起止 / trigger / trigger_detail / session_id / outcome / error_code`。

### 12.2 解析器：一个 record + N 个 adapter

```
record = { ts, round_id, source, kind, summary, ref }
```

| adapter | 源头 | 给出 |
|---|---|---|
| `session` | `~/.dsh/sessions/**` JSONL | turn / tool / token / cache / 耗时 |
| `gem:*` | 各宝石自己的日志 | 具体动作 |
| `wechat` | `~/.dsh-wechat/audit.jsonl` | 外发内容与结果 |
| `page-monitor` | `alerts.jsonl` | 外部变化 |
| `living` | anchors + 日记 | 起因、结局、自述 |

纪律：adapter **只做映射不做判断**；单个 adapter 失败只标"该源不可用"。

### 12.3 事实区与自述区

| 区 | 谁写 | 性质 |
|---|---|---|
| 事实区 | 解析器（代码） | 可对账、可审计 |
| 自述区 | 它写的日记，标 `source=self` | 允许有温度与偏差，**不许冒充事实** |

不是不让它写作，是不让它的写作进入账本。

### 12.4 报表：当日落盘，零模型成本

```
reports/YYYY-MM-DD.json   ← 固化后的当天事实
reports/YYYY-MM-DD.html   ← 人看的视图（纯 SQL + 模板）
```

**报表不是视图，是存档**（会话会归档、宝石日志会轮转）。四个视角：作息热图 · 行动分布 · 成本曲线（含 rest/夜睡的缓存损失）· 异常。

### 12.5 只读查询接口

```
living_query_rounds(since, until, trigger?, outcome?)   → 结构化
living_stats(days)                                       → 计数/均值/额度
living_recollect(question, cue?, mode?, detail?)           → summary + primary/backup + evidence
living_memory_segments(key)  [仅回想子 agent]              → 0–3 个时间区段
```

只读、无写工具：写入走内部 events，**不通过工具回写**，否则账本可被自己篡改。

## 13. Prompt 分段顺序（已定）

铁律：**不变在前，会变在后**。

```
① charter（永不自动改）
② skill 段（各宝石的 skill + 礼仪 + 失败语义）
③ L4 程序记忆（怎么操作某站 —— 技能不是回忆，与 skill 同区）
④ 工具定义（随 preset）
⑤ 会话历史
⑥ L0 快照（夜睡刷新）
⑦ 冷区线索（fidelity: low）
⑧ 本轮指令（每次）
```

L2/L3 的回忆留在 ⑥ 尾部才有意义；L4 是技能，天然属于 ②③ 区。这样缓存拿大头（①②③④ 一天不变），叙事顺序也没坏。

实现：①②③ 由 `living-agent` 在 agent scope 注册为 `living:prelude` 系统段（每会话捕获一次）；⑥⑦⑧ 是本轮 user 消息。不要再把静态段塞回每轮 prompt。

## 14. 发布

- 版本 `0.2.0` 起，CHANGELOG 按阶段
- README 中英双份，写清**"它不做什么"**
- 测试 `node --test`：分层、衰减、预算闸、审计白名单、自动网格/σ/期望
- 冒烟 `selfcheck.mjs`
- **核心与宝石分开发布**：微信/B站协议怎么腐烂都传染不到核心
- 市场只上架 `dsh-living`；宝石由 living 从 npm 下载，不各自占一个插件位

## 15. v1 交付范围

| 有 | 无 |
|---|---|
| 时钟（自动网格 / 日程 / 夜睡） | 任何具体宝石（只出参考实现 + 示例脚本） |
| 记忆三层 + 降维 + 巩固 | 浏览器（v1 只 `web_fetch`） |
| 人格三块（charter / self / journal，DB） | 视频理解 |
| 预算 + 审计 + 限制层 | MCP 按轮裁剪（v1 全挂） |
| 事件触发（ingest + poller） | |
| 动作执行（工具 + outbox） | |
| WorldGem 加载器 + 协议 | |
| 观测（锚点 + 解析器 + 日报） | |
| 文本记忆导入（只进不出） | |

## 16. P0 Spikes（不验证不写代码）

| # | 假设 | 状态 | 退路 |
|---|---|---|---|
| S1 | `agents.create` + `meta.agentPreset` 能钉死单轮工具面 | **机制已核实**（会话头 → `retain → mount → bind`）；探针已写（`spikes/s1-preset.mjs`），待宿主运行 | `spawn dsh --profile headless` |
| S2 | 零成本 tick + 一次闭环 | 待验证（1 天） | `ctx.schedule` 当总时钟 |
| S3 | `node:sqlite` 并发写不锁死 | **✅ 已验证**（`spikes/s3-sqlite.mjs`，6/6）：进程内必须单写队列，跨进程靠 `busy_timeout`，1000 条 1ms | — |

**S1 是地基**：钉不住，整套"窄口"设计要改成"每轮子进程"。

## 17. 待议

- 群聊场景（多宝石同时在场时的礼仪与发言权）
- 观测 adapter 的"最小统一 record"是否够用

**已定**：宝石发现 = living 管理的 npm 目录（`<home>/gems`）+ 内置目录 + `gemDirs` 本地开发；宝石不进入 DSH 插件列表。目录布局 = `data/`（life.db 与宝石数据）、`workspace/`（agent cwd）、`gems/`（代码）；卸载默认保留 `data/` 与 `workspace/`。
