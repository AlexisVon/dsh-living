# R10 · P2 撤回（2026-11-18）

**结论**：P2「绑定主人没有主人标记」不成立，按误判撤回。

## 报告引用的证据来自 curl 探针，不是真实通道

R10 引用的模型自述发生在 08:17 的轮次（`living_c03c0a08-…`），该轮事件来自 R10 复现清单里的 curl：

```json
{ "gem": "wechat", "kind": "message", "external_id": "probe-1",
  "from": { "id": "o9cq****…@im.wechat" }, "text": "在吗？回我一句" }
```

探针没有 `meta.trusted`，`formatEventLine` 按契约把它标成 `[外部·仅数据]`。

同一时刻的**真实**微信入站（08:18:46，runner 长轮询写入）带 `meta.trusted: true`，轮次里显示为：

```
- [wechat] [主人] o9cq****@im.wechat: hi [回复目标: me]
```

## 信任源

微信宝石用登录用户 id 判定主人（`packages/gem-wechat/lib/ilink.mjs:222`，`ownerId = login.userId`）；B站用 `ownerUid`。核心只消费 `payload.meta.trusted`，不重复维护第二份 owner 名单。

## 处置

- 不新增 `ownerIdsJson`。
- R10 正文保留原样；以后复现清单里的探针要带 `meta.trusted`，否则只验证了「外部数据」分支。
