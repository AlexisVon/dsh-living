# R12 处置（2026-11-18）：微信外发两个真 bug

**P8 撤回**：[R11-ADDENDUM](R11-ADDENDUM.md) 里"`ret=-3` 是我合成事件的假象"这个判断是**错的**。用真微信消息跑通真实入站之后仍然 `ret=-3`，根因在下面 Bug 1；且实测 `context_token` 不是必填（不带也 200），那套推理从前提就不成立。

---

## Bug 1（已修）外发把没解析的 target 写到线上

**现象**：

```
[wechat] 发送失败 out_bd909d4b… -> o9cq****…@im.wechat: ilink/bot/sendmessage: ret=-3 invalid arguments（unknown）
```

日志里目标**看着**是解析好的用户 ID，但请求体里不是。

**根因**：

```js
// channel/run.mjs —— 解析结果只用于查 token 和打日志
const to = resolveRecipient(item.to, login.userId)      // "me" → o9cq****…@im.wechat
const result = await sendOutbound(item, { … })          // 但 item.to 还是 "me"
// lib/ilink.mjs
sendText({ to: message.to })                            // → to_user_id: "me"
```

`to_user_id: "me"` 不是合法用户 ID，服务端按参数不合法拒绝（`ret=-3 invalid arguments`）。

**改法**：解析下沉到发送函数里，原始 target 结构上到不了线上。

- `sendOutbound(message, { boundUserId })` 内部调 `resolveRecipient`，解析失败 `throw`（不静默发空）；
- `channel/run.mjs` 传 `boundUserId: login.userId`。

**真机验证**（2026-11-18 09:45）：直接拿库里凭据调真实网关，四种 body 变体全部 200（含"无 `context_token`"），说明网关与令牌都没问题；改成修复后的代码路径发一条真实消息，返回 `message_id`，微信端收到。随后宿主重启，outbox 四条积压全部 `acked_at` 非空、带 `external_id`。

---

## Bug 2（已修）待审的外发会被投递

**现象**：库里 `out_fa0bfa27` 这一行 `decision = review`（非白名单待确认），但 `attempts = 9`，一直在被 claim。

**根因**：待审是靠"停到时间的尽头"实现的 —— `deferOutbox(id, Number.MAX_SAFE_INTEGER)`。但可重试失败时 `ackOutbox` 会把 `next_attempt_at` 改写成 `now + 租约`，停车位被自己抹掉，行又回到可投递状态。

一直没真发出去，纯粹因为 Bug 1 让它每次都失败。**修完 Bug 1，这行下一轮就会被投递** —— 待审门等于不存在。

**改法**：审不审在 claim 的收口处判，放行是唯一通道。

- `claimOutbox` 加 `AND (decision IS NULL OR decision <> 'review')`；
- `approveOutbox` 把 `review` 翻成 `send`（放行后才可投递）。

时间戳停车保留，但不再承担正确性 —— 它只是 UI 上的排序提示。

---

## 回归测试

- `gem-wechat/test/ilink.test.mjs`：`to: 'me'` + `boundUserId` → 线上 `to_user_id` 必须是绑定用户；
- `core/test/store.test.mjs`：待审行被可重试失败改写 `next_attempt_at` 后仍不可投递，`approveOutbox` 后才可。

271 全绿（core 213 / protocol 19 / wechat 17 / bili 22）。

---

## 未做

- `failureCodeFor` 仍把 `ret=-3` 归到 `unknown`。现在它不该再出现（出现即真异常），但映射成明确码 + `failure_hints` 更省排查成本。
- 库里的历史待审行没改数据：新的 claim 条件已经不认它，等人工放行或拒绝。

---

# 追加（同日）：B站扫码登录 + 系统通知降级

## Bug 3（已修）B站扫码成功但拿不到 Cookie

**现象**：扫码确认后报「登录成功但二维码回调没有携带完整 Cookie」，账号始终未登录。

**真因**：passport 的回调格式变了。`poll` 返回 `data.code === 0` 时：

```json
{ "url": "https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=454e…&gourl=…&first_domain=.bilibili.com",
  "code": 0, "refresh_token": "…" }
```

`url` 的 query 只有 `ticket` / `gourl` / `first_domain`，**没有** `SESSDATA` / `bili_jct` / `DedeUserID`。Cookie 要走这个 `crossDomain` 地址的 302 链，在 `Set-Cookie` 里下发（`passport.biligame.com` → `passport.biligame.cn` → `www.bilibili.com`）。旧代码只在 url query 里找，永远凑不齐三个。

**改法**（`lib/credential.mjs`）：`code === 0` 后先按老格式解析 url；不完整且带 `ticket` 就自己走跳转链收 `Set-Cookie`，**后一跳覆盖前一跳**（`.bilibili.com` 压掉 `biligame.com` 同名值）。都凑不齐才抛，错误文案带上到底缺什么。

实测：第一跳下发的那份 Cookie 直接对 `api.bilibili.com` 有效（`nav isLogin=true`），不必等第二跳。

## Bug 4（已修）B站系统通知唤醒付费轮次

**现象**：扫码登录后 B站「社区中心」发来两条 `登录操作通知`，`notify.push` 是 ring+计费，各唤起一轮。

**判据**：系统通知的报文是 `{"title":"…","text":"…"}`，真人私聊是 `{"content":"…"}` —— 按**报文结构**判，不按 uid 大小。踩过的坑：新版真实账号的 uid 也是 `20002` 这种大数，用 uid 阈值会把真人误判成系统号。

**改法**：

- `lib/api.mjs`：`isSystemDm` + `mapDmMessages` 带 `system` 标记；
- `lib/channel.mjs`：`system` 的私信发成 `kind: 'notice'`、`meta.silent = true`、不给 `reply_to`（不该回复系统号）；
- `core/lib/runtime.mjs`：`eventPolicy` 认 `meta.silent === true`，覆盖清单策略为 `silent`（记事件、顺带处理、不唤醒）。协议层不用改，`meta` 本来就是透传。

## 顺手：root 的 `check` 闸门其实不存在

根 `package.json` 没有 `check` 脚本，之前"`npm run check` 过了"是空跑（子进程直接报 Missing script 却没人看）。现在：

- 根 `check` = `pnpm -r --if-present check`；
- protocol / gem-bili / gem-wechat 各补 `check`（`node --check` 覆盖 `index.js`、`lib/*.mjs`、`channel/*.mjs`、`mcp/*.js`）。

## 测试

277 全绿（core 214 / protocol 19 / bili 27 / wechat 17），`npm run check` 在各包上都真跑过。
