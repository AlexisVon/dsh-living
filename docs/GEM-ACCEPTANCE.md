# 宝石验收：gem-wechat / gem-bili

> **历史记录**：F-1/F-2 与限制层状态已被后续版本取代；现行见 [WORKPLAN](WORKPLAN.md) 和 [DECISIONS](DECISIONS.md)。

2026-11-17 20:10 · 验收人：契约守门 · 被测：工作区未提交版本（175 项测试）

结论：**协议层与工程实现通过**；两条能力边界需要知会（见 F-1 / F-2），不是缺陷但会改变产品预期。

---

## 1. 通过项

| # | 项 | 证据 |
|---|---|---|
| P-1 | 清单合法 | `validateWorldGem` 两包均 PASS |
| P-2 | 可见性正确 | `gem-wechat: private`；`gem-bili: **public**`（评论/私信是公网发言，符合预期） |
| P-3 | 单测 | 两个宝石 **28 项**全绿；全仓 **174 项**全绿 |
| P-4 | 许可归属 | `lib/vendor/qrcode.mjs` 是 kazuhikoarase/qrcode-generator（MIT），文件头保留、`NOTICE.md` 登记；明确声明未复制 `dsh-wechat` 源码 —— 符合 D-04 的 D0 政策 |
| P-5 | 宿主加载 | 两宝石均被加载，`dsh-gem-bili MCP ready` |
| P-6 | 入站去重 | 同一 `external_id` 连发两次：第 1 次 `accepted:true`，第 2 次 `accepted:false, wake:none`；`events` 只有 1 条 message，`ingest_seen` 1 行 |
| P-7 | 凭据权限 | 目录 `0700`、文件 `0600`、原子写（tmp + rename） |
| P-8 | 日志不泄密 | 只打印凭据路径与账号 id，不打印 token |
| P-9 | 未登录时优雅退出 | `[wechat] 未登录：先运行 node channel/login.mjs（凭据目录 …）`，退出码正常 |
| P-10 | 出站可靠性字段 | `outbox` 有 `attempts / next_attempt_at / claimed_at / acked_at / failed_at / last_error`，claim 时 `next_attempt_at` 递推 |
| P-11 | 群消息默认忽略 | `忽略群消息 …（首版只做私聊）` —— 与首版范围一致 |

## 2. 发现

### F-1（中）宝石不可用时，核心无从知晓

未登录状态下 poller 直接退出，**不 claim、不 ack**。于是：

- `outbox` 里的消息永久 `pending`（`attempts=0`, `next_attempt_at` 不动）
- 核心的 `gemHealth` 不会记录任何失败（没有 ack → 没有失败码）
- 模型在 prompt 里看到的 skill 仍声称该宝石可用

结果：它会以为自己发出去了，而实际上消息躺在队列里。

**建议**（core 侧兜底，成本低）：轮次开始时检查 `outbox` 中 `created_at` 超过 N 分钟仍 `attempts=0` 的条目，判定该 gem 不可用 → 写 `round_suppressed`/gem 健康事件 + 在 skill 段标注「该宝石当前不可用」。

### F-2（重要，属能力边界而非缺陷）公开发言一律进人工审核

`audit.mjs` 对 `public/group` 的策略是 **fail-safe**：

```js
if (!limiter) return { decision: 'review', reason: '公开发言必须过限制层', requiresLimiter: true }
```

而限制层（子 agent 判定）**尚未实现**，`sendOutbound({ limiter })` 目前没有任何调用方传入 verdict。所以：

> **`gem-bili` 的评论/私信永远不会自动发出**，全部停在待审队列，等人点头。

安全，但意味着"它会自己在 B站 说话"这件事目前是关着的。要用就得先实现限制层（规则表已就绪，缺的是那个只输出 `{pass, rule_id, reason}` 的子 agent 调用）。

## 3. 未验项

| 项 | 阻塞 |
|---|---|
| 真号入站/出站 | 需要微信扫码登录、B站 cookie |
| 24h 窗口 / 10 条上限的真实行为 | 同上 |
| B站 wbi 签名在真实接口下的有效性 | 同上 |
| 限制层放行后的公网发言 | 限制层未实现 |

## 4. 结论

协议、去重、凭据安全、失败字段、许可归属**全部合格**。两个发现里：

- **F-1 建议修**（core 侧十几行，能避免"它以为发了"
- **F-2 需要决策**：要么实现限制层，要么在产品说明里写清"公网发言永远是待审状态"

另外：两个 gem 与 core 的改动目前**尚未提交**，本验收只提交这份文档。
