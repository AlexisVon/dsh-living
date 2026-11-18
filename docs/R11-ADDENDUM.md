# R11 追加发现（2026-11-18 09:10）

> 处置结果见 [R11-FIX](R11-FIX.md)：P7 已修，推送立即 wake 与按宝石配置预算已实现。

在 `45816ca` 之后实测出的两个新情况。**一个是真 bug，一个是我造出来的假象，别混淆。**

---

## P7（阻断，真 bug）单轮预算耗尽会把**整天**锁死，且重启不解锁

**现象**：`roundTokens: 50000` 时有一轮用了 53192 → `outcome: error, error_code: budget_exhausted`。之后：

- 状态一直是 `BUDGET_HOLD`（`state.suppression = {reason:"budget"}`）
- 当天后续两次入站（01:03:50、01:04:17）**都没有产生轮次**
- 我已把 `roundTokens` 调到 120000 并重启，**依然被锁**

**根因**（`lib/runtime.mjs`）：

```js
let perRoundHoldDay = store.getState('budget.holdDay') ?? null
let status = perRoundHoldDay === clock.dayKey(now(), tz) ? BUDGET_HOLD : RUNNING   // :55
...
status = BUDGET_HOLD            // :132 单轮超限时
await store.setState('budget.holdDay', perRoundHoldDay)                            // :127 持久化
```

`budget.holdDay` 是**按天**持久化的：一旦当天有一轮超限，这一整天（含重启后）都进 HOLD。抬高 `roundTokens` 不会解锁，因为 HOLD 只看日期，不看配置值。

实测确认：

```
state keys: budget, budget.holdDay, budget.holdAnnouncedDay, suppression, …
budget.holdDay = "2026-11-18"      ← 就是今天
suppression = {"reason":"budget","since":…}
```

**建议修法**（三选一，我倾向 A）

- **A**：hold 与配置值绑定——持久化 `holdRoundTokens`，启动时若 `config.roundTokens > holdRoundTokens` 则清 hold（"限额被抬高了，重新算"）
- **B**：单轮超限只跳过该轮，不进全天 HOLD（与"日额度"区分开：日额度才该锁天）
- **C**：提供显式重置（`living_budget_reset` 或状态事件），并让 HOLD 状态可见（设置页按钮）

**验收**：把 `roundTokens` 调到 1000 跑一轮 → 该轮 `budget_exhausted`、下一轮仍然能跑（或按 B 明确"今日暂停"）；改成 120000 后**不需要清库**就能恢复；设置页能看到 `BUDGET_HOLD` 及其原因。

**当前临时处置**：我删掉了 `budget.holdDay` / `budget.holdAnnouncedDay` / `suppression` 三个状态键，**需要一次宿主重启**才会以 `RUNNING` 启动（这些值在内存里，删库不即时生效）。

---

## P8（**已撤回**，下面的判断是错的）iLink `ret=-3 invalid arguments`

> **2026-11-18 更正**：真微信消息仍然 `ret=-3`，根因是外发没解析 target（`to_user_id: "me"`），详见 [R12-FIX](R12-FIX.md)。另实测 `context_token` 并非必填。以下内容保留作记录，不要按它行动。

**现象**：

```
[wechat] 发送失败 out_fa0bfa27… -> o9cq****…: ilink/bot/sendmessage: ret=-3 invalid arguments（unknown）
```

**判断**：这是我用 `POST /living/ingest` **合成**入站事件造成的假象，不是宝石缺陷。

理由：iLink 回复需要 `context_token`（由真实入站消息带来，宝石存在 `state.contextTokens[to]`）。合成事件没有经过 iLink，所以：

- 宝石从未见过真实入站 → `contextTokens` 为空
- `sendText` 里 `...(contextToken ? { context_token: contextToken } : {})` → 缺字段
- 服务端按"参数不合法"拒绝（`ret=-3`）

**验证方法**：**用真微信发一条消息**，让它走真实入站路径（会带 `context_token`），再看是否 `acked_at` 非空。在此之前不要改 gem 的 send 逻辑。

**建议**：`failureCodeFor` 把 `ret=-3` 映射成明确码（如 `window_closed` 或新增 `ilink_invalid_args`），并在 `failure_hints` 里给模型一句"这条多半是缺上下文令牌，等对方先说话"。

---

## 附带两条实测事实（供参考，不一定要改）

1. **宝石 runner 的 stdout 被核心捕获**（`/proc/<pid>/fd/1 → socket`），所以 `~/.dsh/living-gems/wechat/run.log` 不再更新，日志只能从 `~/.cache/dsh-web.log` 看 `[gem:wechat] …`。建议核心把宝石 stdout 落到 `~/.dsh/living-gems/<id>/run.log`，排障更省事。
2. **重复 runner 会互相抢单**：我留的 systemd 单元 + 核心拉起的实例同时跑，导致一次 `last_error: unknown` 和消息滞留。我的已停。这条应写进部署文档：**一颗宝石的 channel runner 只能有一个所有者**。

3. **B站宝石未登录会在每次启动时被反复拉起**（`已启动: bili（pid …）` 两次 + `未登录` 提示）。建议：登录态缺失时不要重试拉起，直接标 `gem_silent` 并在设置页提示扫码。
