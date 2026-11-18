# R11 处置（2026-11-18）

对应 [R11-ADDENDUM](R11-ADDENDUM.md) 的 P7，以及本轮追加的三条要求：推送立即处理、按宝石配置预算、今日用量可重置。

---

## P7（已修）单轮超限不再锁整天

**改法**：`roundTokens` 超限只终止该轮，写 `budget_exhausted {which:'round'}`；`status` 保持 `RUNNING`。只有日预算（`dailyTokens` / `dailyRounds`）耗尽才进 `BUDGET_HOLD`。删除 `budget.holdDay` 的读写，旧的持久化值不再生效。

**验收**：

- `roundTokens` 调到 1000，跑一轮超限 → 该轮 `budget_exhausted`，下一轮照跑；
- 调回 120000 **不需要清库/重启**；
- 重启后不再因为历史 `budget.holdDay` 直接进 HOLD。

## 推送立即 wake（已实现）

`POST /living/ingest` 接受事件后立即 nudge 一次 tick，不再等 `tickMs`（默认 60s）。

- 正在跑轮次时只置 pending；该轮结束后**立刻**补一次 tick，不抢占。
- 游标推进用轮次开始时捕获的事件列表，轮次运行期间到达的消息不会被跳过。
- `wake` 字段现在是真实语义：`immediate` / `none`。

**验收**：真微信发一条 → 秒级起轮，而不是最多 60s。

## 按宝石配置响铃与预算（已实现）

清单新增 `notify`（见 `docs/ARCHITECTURE.md` §9.5）：

```json
"notify": {
  "push":    { "mode": "ring", "budget": { "limit": true,  "count": true  } },
  "trusted": { "mode": "ring", "budget": { "limit": false, "count": false } }
}
```

- 微信：`push` 全免（`limit:false, count:false`）。
- B站：`push` 计费，`trusted`（我）免。
- `silent`：不立即唤醒，事件留给下一轮顺带处理。
- agent 主动轮固定计费，不受 `notify` 影响。

**验收**：日额度耗尽时微信仍能回；B站外部私信被抑制且事件保留；B站主人消息仍能回；豁免轮次不进 `budget.tokensUsed` / `budget.rounds`。

## 今日用量重置（已实现）

设置页「状态」→「重置今日用量」，或 `living-admin` 的 `budgetReset`。清当日 token/轮次、解除 HOLD、清 suppression，写 `budget_reset` 审计事件；不删历史、不动待办事件。

## 未动

- ~~**P8**：确认是合成事件缺 `context_token`~~ —— **该判断已撤回**，真因是外发未解析 target，见 [R12-FIX](R12-FIX.md)；`ret=-3` 的明确失败码待做。
- **附带 1（宝石 stdout 落 run.log）**、**附带 3（B站未登录反复拉起）**：未做。
- **RMB 计费**：后续单独讨论。DSH 只给 `TokenUsage`，不给金额；余额可读 `deepseekAccount.getBalance()`。
