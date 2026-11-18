# M6 验收记录：宿主内实测（2026-11-17）

> **历史记录**：当时的测试数、路径与“午睡”行为已被后续版本取代；现行状态见 [WORKPLAN](WORKPLAN.md) 与 [DEPLOY](DEPLOY.md)。

状态：**未通过** —— 宿主装配能加载、接口能用，但**轮次空转**，核心闭环没有真正跑起来。

执行人：契约守门（DSH 侧）· 被测版本：`1f5fee3`

---

## 1. 环境与方法

```sh
DSH_HOME=/path/to/dshdev
dsh --profile living --from-default-profile web --dump-config     # 建 profile
dsh plugin --profile living add /path/to/dsh-living/packages/core
pnpm install                                                      # 根目录，link protocol
dsh --profile living --port 3099 --no-open
```

dev 覆盖（`profiles/living/cordis.patch.yml`）：

```yaml
- id: living
  config:
    home: !!js dshHomePath('living')
    tickMs: 5000
    dailyTokens: 300000
    roundTokens: 50000
    gemDirs: [/path/to/dsh-living/packages/gem-example]
    gemTokensJson: '{"example":"testtoken"}'
    # …其余字段见文末「部署坑」
```

所有验证走真实宿主与真实 HTTP，不 mock。

## 2. 通过项

| # | 项 | 证据 |
|---|---|---|
| P-1 | 插件在宿主内加载 | `GET /living/state` → `200`，返回完整运行时快照（status / clock / budget） |
| P-2 | 配置字段全部生效 | 合成配置里 12 个字段与 patch 一致 |
| P-3 | ingest 鉴权 | 无 token → `401 {"error":"unauthorized"}`；带 token → `200` |
| P-4 | 事件唤醒 | `{"accepted":true,"wake":"immediate"}`，随后 `anchor` 出现 `trigger:"event"` |
| P-5 | 会话创建 | 出现 `sessions/…/living_<uuid>` 目录，sessionId 回填进 anchor |
| P-6 | preset 结构窄口 | 注册的 preset 只含 `persona + time-context + living-agent`，无 bash/fs/web |

## 3. 缺陷

### B-1（致命）轮次空转：不调模型、不产生行为、却记成 ok

**现象**

```json
{"roundId":"r_mwkgzzle_dff9cb27","trigger":"event",
 "outcome":"ok","errorCode":null,"startedAt":1794906521330,"endedAt":1794906521457}
```

一轮耗时 **127ms**，`tokens: 0`，`outcome: ok`。

**会话是空的**（决定性证据）：

```
$ ls ~/.dshdev/sessions/--…-living--/living_68f43330-…
（目录存在，内容为空：无 turn/start、无 assistant/message）
```

**根因** — `packages/core/index.js` `createRunner()`：

```js
handle.agent.followup({ role: 'user', content: [{ type: 'text', text: prompt }] })
await handle.agent.whenIdle()                              // 此刻仍 idle，立即返回
return { tokens: 0, outcome: 'ok', sessionId }             // 结果写死
} finally { await handle.dispose() }                        // 打断刚发起的轮次
```

**影响**：核心闭环不成立。插件是"能加载的空壳"。

**修复要点**
1. 等 `turn/end`（或会话事件流里的轮次结束信号），不要用 `whenIdle()`
2. 会话结束前不得 `dispose()`；异常路径也要保证轮次有机会收尾
3. 超时用 `signal` 中断轮次，而不是销毁 handle 抢跑
4. 返回值必须来自真实结果：至少包含 `turns`、`toolCalls`、`tokens`

**验收**：同一条 ingest 触发后，会话目录里出现 `turn/start` 与 `assistant/message`，round 时长与模型延迟同量级（秒级），`tokens > 0`。

---

### B-2（严重）token 恒为 0 → 预算闸失效

**现象**：`rounds[].tokens` 永远 0，`budget.tokensUsed` 不增长。

**影响**：`dailyTokens` / `roundTokens` 两道闸形同虚设；BUDGET_HOLD 永不出现（D-11 设计目的落空）。

**修复要点**：从会话用量（token meter / 会话事件里的 usage）取真实值，累加进 `budget.consume`。

**验收**：连续跑 5 轮后 `budget.tokensUsed > 0`；把 `roundTokens` 调到 1，下一轮应返回 `budget_exhausted` 且状态进入 `BUDGET_HOLD`。

---

### B-3（严重）outcome 永远 ok，失败不可见

**现象**：`outcome: 'ok'` 写死；`errorCode` 恒 null。失败只走外层 `catch`（抛错路径），而真正"跑完但没做成"的情况无从表达。

**影响**：DEGRADED 永不触发；报表里的成功率是假的（违背 D-28「账本不许造」）。

**修复要点**：`outcome` 由执行结果分类得出（`ok` / `error` / `skipped` / `degraded`），失败必须带 protocol 码表里的 `errorCode`。

**验收**：人为让模型调用失败（如清空凭据），round 的 `outcome` 应为 `error` 且 `errorCode` 非空；连续 3 次后状态进入 `DEGRADED`。

---

### B-4（中）跳过的轮次无痕（D-27 未实现）

**现象**：`tick()` 里 `sleep` 分支直接 `persist()` 返回；`BUDGET_HOLD` 同样不记录。全库无 `skipped` 相关写入。

**影响**：报表答不了"它为什么没动"——而这正是观测面的首要用途。

**修复要点**：**状态变化时**写一条事件（不是每分钟一条），例如 `{kind:'round_suppressed', reason:'budget'|'explore_miss'|'cooldown'}`，同一 reason 合并。

**验收**：把预算调到耗尽，`/living/rounds` 或事件流里能看到一条 `round_suppressed reason=budget`。

---

### B-5（中）无能力级降级

**现象**：`gems.mjs` 无健康度跟踪；只有全局 `DEGRADED`（连续 3 轮失败），恢复方式是"下一轮成功即回 RUNNING"。

**影响**：某颗宝石挂了无法局部降级；也没有半开探测退避（D-24）。

**修复要点**：按 gem 记录最近失败与冷却；降级时把不可用的 gem 从工具面/技能段里摘掉，并在 round prompt 里说明。

**验收**：让示例宝石返回失败，其余能力仍可用；prompt 里出现"该宝石不可用"的句子。

---

### B-6（低）`home` 缺 `.extra('volatile', true)`

**现象**：`index.js` 的 Config 14 个字段中 13 个带 volatile，`home` 没有。

**判断**：可能是**有意**（home 是加载期路径，不该在设置页改）。若有意，请在 `index.js` 注释里说明；若非有意，补齐。

---

## 4. 部署坑（必须写进部署文档）

**`cordis.patch.yml` 的 `config:` 是整体替换，不是深合并。**

只写 `gemDirs` 会导致必填的 `home` 变成 undefined，插件加载失败：

```
$.home missing required value (at home)
```

覆盖任意字段时，**必须把整份 config 抄全**（见 §1 的完整示例）。

## 5. 验收环境改进需求

### R-1 `timeScale` 测试钩子（5 行）

`createRuntime` 已接受 `now`，但 `index.js` 未透出。加一个 `timeScale`（默认 1，锚定基准做仿射映射 `simNow = baseSim + (realNow - baseReal) * k`），即可把 24h 压成 24min 跑冒烟，**且本地日边界（预算重置）能真实发生**——这只靠压配置参数做不到（`dayKey` 用日历日）。

**验收**：`timeScale: 60` 下跑 24 分钟，`budget.day` 发生一次翻页、午睡与夜睡各触发一次。

### R-2 启动时打印工具面

现在无法从外部断言"preset 真的窄"。启动日志打印本轮可见工具名（或在 `/living/state` 里暴露 `tools[]`），S1 才能自动验收。

## 6. 复现清单

```sh
# 1. 起宿主
DSH_HOME=/path/to/dshdev dsh --profile living --port 3099 --no-open &

# 2. 触发一次事件醒
curl -s -X POST http://127.0.0.1:3099/living/ingest \
  -H 'content-type: application/json' -H 'x-living-token: testtoken' \
  -d '{"gem":"example","kind":"message","external_id":"e1","from":{"id":"u1"},"text":"在吗"}'

# 3. 看结果（B-1/B-2/B-3 会在这里暴露）
curl -s http://127.0.0.1:3099/living/rounds

# 4. 决定性证据：会话应为空
find ~/.dshdev/sessions -path '*living_*' -type d | tail -1 | xargs ls -la
```

## 7. 结论

**M6 不能标记完成**。P-1…P-6 说明"装配是对的"，B-1…B-3 说明"闭环没跑"。修复顺序建议：B-1（否则其余无法验证）→ B-2/B-3（同一次修复即可）→ B-4 → B-5 → B-6 → R-1/R-2。

---

# 复测（R2）· 2026-11-17 17:20

被测版本：`dd99e5e`（修复 B-1…B-6、R-1、R-2）· 采用：**有条件通过，但发现新缺陷 B-7（致命）**

## R2-1 已修复项

| 缺陷 | 复测证据 | 结论 |
|---|---|---|
| **B-1** 轮次空转 | 会话目录出现 `session.v4.jsonl.zstd`（15.8 KB，14 轮内容）；单轮耗时 3.9–7.1s（与模型延迟同量级） | ✅ |
| **B-2** token 恒 0 | `budget = {day:"2026-11-17", tokensUsed:60646, rounds:14}` | ✅ |
| **B-3** outcome 写死 | `round.mjs` 按 `completed/blocked/error` 分类 | ✅（代码级） |
| **B-4** 跳过无痕 | 出现 `round_suppressed` / `round_resumed` 事件（按状态变化写，非每 tick） | ✅ |
| **B-5** 无能力级降级 | `gemHealth` + 60s/5m/30m 三级退避 | ✅（代码级） |
| **R-2** 工具面不可断言 | `/living/state` 返回 `tools[]`：`working_directory, living_state, living_recall, living_journal, living_sleep, living_plan, living_import, living_query_rounds, living_stats, living_send, living_web_fetch` —— **无 bash / fs / patch** | ✅ 窄口成立 |

单测：158 项全绿。

## R2-2 新缺陷 B-7（致命）：事件唤醒自激

**现象**：一次 ingest 触发后，每 5s（tickMs）起一轮，**停不下来**。70 秒内跑了 **14 轮**，烧 60646 token。

```
pendingEvents: 6   ← 每一轮的 triggerDetail 都是这个数
round 间隔 ≈ 5s    ← 等于 tick 间隔
```

**决定性证据**（`life.db` 直查）：

```
events by kind:
  round            14 条   ts 1794906487019 → 1794907066295
  round_suppressed  7 条
  round_resumed     6 条
  message           6 条
events.cursor = 1794907026789      ← 只推进到最大 message ts + 1
```

`round` / `round_suppressed` / `round_resumed` 的 `ts` **都大于 cursor**，于是下一 tick 又被 `freshEvents()` 当成"新事件"，再起一轮 → 写新 `round` 事件 → 再触发。**自给自足的唤醒环。**

**根因** — `lib/runtime.mjs`：

```js
// :245 只把游标推进到「最大 message ts + 1」
if (decision.trigger === 'event' && decision.detail?.pendingEvents) eventCursor = maxTs(freshEvents()) + 1
```

`freshEvents()` **没有按 kind 过滤**，把自家账本事件也算成待办。

**修复要点**
1. `freshEvents()` 只取**可执行事件**（宝石推来的 `message/notice/change`、日程到点），排除 `source === 'living'` 的账本事件（`round` / `round_suppressed` / `round_resumed` / `round_failed` / `schedule_missed`）
2. 或给事件表加 `consumed` 位，按行消账而不是靠 ts 游标
3. 加一条不变量测试：**写入 1 条 message 事件，跑 10 个 tick，最多起 1 轮**

**验收**：ingest 一次 → 恰好 1 轮；再等 60s（12 个 tick）不再新增轮次。

## R2-3 次要问题：抑制状态抖动

`round_suppressed` 7 条 / `round_resumed` 6 条 —— 两个状态在反复横跳（每轮成功→resumed，下一 tick 不满足→suppressed）。建议加**滞回**：恢复需连续 N 次满足条件，或恢复后 30 分钟内不再写 suppressed。否则观测面会被噪声淹没。

## R2-4 结论

B-1…B-6、R-2 实质修复，单测与实测一致。**但 B-7 使插件不能部署**：它会在无人干预时无限起轮，直到额度烧完（本次 60646 token ≈ 一分钟）。

修复顺序：**B-7 → R2-3**。B-7 修完即可进入"压缩时间尺度跑 30 分钟"的冒烟（R-1 已验证可用）。

---

# 复测（R3）· 2026-11-17 17:35

被测版本：`e2afe4f`（修复 B-7 与 R2-3，补单轮上限）· 采用：**B-7 修复确认；压缩时间尺度冒烟通过，但发现凭据问题**

## R3-1 B-7 修复确认（决定性）

清库重跑，**只 ingest 一次**，观察 65 秒（13 个 tick）：

```
初始轮次: 0
ingest 一次 → {"accepted":true,...}
65s 后:
  轮次总数: 1
  r_mwkhn6md_2b002b16 | event | ok | 6s | {"pendingEvents":1}
  budget {"day":"2026-11-17","tokensUsed":3925,"rounds":1}
```

`events` 表只有 `message×1 + round×1`，`suppression = null`。
**自激环消失**：1 条消息 = 1 轮，13 个 tick 内不再新增。✅

## R3-2 R2-3 抑制抖动

R3 全程 `round_suppressed` / `round_resumed` 均为 0 条，`suppression` 状态为 null。✅

## R3-3 R-1 压缩时间尺度冒烟（timeScale=720，tickMs=1000，跑 165s ≈ 2.3 模拟天）

| 观测项 | 结果 | 结论 |
|---|---|---|
| 日边界翻页 | `budget.day` 17→18→19 | ✅ 真实发生 |
| 预算按日重置 | 新的一天 `tokensUsed` 归 0 | ✅ |
| 夜睡 | `nightDay` 推进到 19；`events` 出现 `consolidation×2` | ✅ 两晚都巩固了 |
| 午睡 | `napDay=2026-11-18`，当日素材 < 20 条 → 按设计跳过 | ✅ |
| 心跳自唤醒 | **3 次**（模拟日 18 的 09:54 / 14:29 / 22:41） | ✅ 会自己醒，且不自激 |
| 无异常日志 | `grep -c error` = 0 | ✅ |

**压缩验证方案成立**：24 小时 → 约 2 分钟（720×），且能验到"日重置"这类压配置参数做不到的东西。

## R3-4 新问题：心跳轮次全部 `provider_auth` 失败

```
r_mwly0jue | heartbeat | error | provider_auth | turns:1 toolCalls:0 tokens:0
r_mwm7vlie | heartbeat | error | provider_auth | turns:1 toolCalls:0 tokens:0
r_mwmpgk6e | heartbeat | error | provider_auth | turns:1 toolCalls:0 tokens:0
```

同一个 dev 环境里，**事件触发的轮次是成功的**（`ok, tokens:3925, toolCalls:1`），只有心跳触发的那三轮认证失败。

**判断**：大概率是**测试环境凭据问题**，不是产品缺陷——我为了跑 dev 宿主，把 `~/.dsh/.credentials.yaml` 复制进了 `.dshdev`。同一份 OAuth 刷新令牌被两个 home 共用，一边刷新就会让另一边失效（平台账号类 provider 通常如此）。

**但它暴露了两件产品侧该做的事**：
1. **连续 3 次认证失败必须进 DEGRADED**（本次正好 3 次）—— 需补一条验收：清空凭据后跑 3 轮，`status` 必须变 `DEGRADED`，且发一条告警（邮件出口尚未实现，见 B-4 之后的新需求）
2. **失败要能自愈**：凭据修好后，下一次成功轮应把状态拉回 `RUNNING`

**待办（实现方）**：确认 `deepseek-account` 是否允许多 home 共用凭据；若不支持，`docs/DEPLOY.md` 需写明"dev home 不能直接复制主 home 的凭据，应单独登录"。

## R3-5 未覆盖项

| 项 | 状态 |
|---|---|
| B-5 宝石级降级 | 未触发（示例宝石没有真实失败路径） |
| B-2 预算闸实际拦截 | 已见 `tokensUsed` 增长，但未跑到耗尽；建议下轮把 `roundTokens` 调成 1 验证 |
| M8 观测 UI | 未验（未开浏览器） |
| 邮件告警出口 | 尚不存在 |

## R3-6 结论

**B-7 已修复并实测确认，压缩时间尺度方案可用。** 剩余三件：① 凭据共用问题（文档/环境）；② 认证连败进 DEGRADED 的验收；③ 预算闸拦截与 B-5 的实测。

到这一步，**它可以开始受控试跑了**——前提是你给它一份干净的凭据、把 `dailyTokens` 调到保守值，并且接受"现在没有任何告警出口"这件事。
