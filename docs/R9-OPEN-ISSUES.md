# R9 未决问题（2026-11-17 22:30）

两件事都**未解决**，先记清楚现状与已验证的事实，别让结论漂。

---

## G-2 微信显示"不在线"：因为没人跑 channel runner（已定位，处置见 §3）

**现象**：扫码登录成功（`~/.dsh/living-gems/wechat/auth/token.json` 0600 存在），但微信端显示不在线、发不出消息。

**原因**：iLink 的在线状态由**长轮询**维持。登录只拿到 token；不跑 `packages/gem-wechat/channel/run.mjs` 就不接电话，微信侧就是离线。

**验证**：手工拉起 runner 后，12 秒内立刻收到入站消息：

```
[wechat] 启动：core=http://127.0.0.1:3080 gateway=https://ilinkai.weixin.qq.com gem=wechat
[wechat] 入站 o9cq****@im.wechat: hi
```

**临时处置**（当前生效）：一个带重启的后台循环

```sh
setsid nohup sh -c 'cd <repo>; while true; do
  LIVING_BASE_URL=http://127.0.0.1:3080 LIVING_GEM_ID=wechat \
  LIVING_GEM_TOKEN=<token> node packages/gem-wechat/channel/run.mjs \
  >> ~/.dsh/living-gems/wechat/run.log 2>&1; sleep 5; done' &
```

**正式方案（待做）**：宝石进程必须**受监督**。三选一：
| 方案 | 说明 |
|---|---|
| A 插件监督 | `gems.mjs` spawn 每颗宝石的 `channel/run.mjs`，带退避与健康上报（顺带解决 `gem_silent` 的判定来源） |
| B 交给 dsh_server.py | 与 dsh 子进程同级，由 supervisor 启停 |
| C systemd user unit | 最稳，但要用户机器上有 systemd 用户会话 |

倾向 A：与「核心监督、宝石只提供协议」的设计一致，也让部署脚本只剩一条命令。

---

## G-1 工具面收口把 agent 自己的工具也摘掉了（未解决）

**现象**：`自主轮工具面已收口（屏蔽 41 个，保留 0 个）`，随后 `本轮最终工具面 0 个`。轮次仍然 `ok`（2s），但 `outbox` 0 条 —— 它连 `living_send` 都调不到，**能收消息、不能回**。

**已核实的事实**

1. `tools.restrict({ deny })` 的语义（读 `dsh-tools/lib/index.js`）：
   - `view(scope)` = `inherited`（global + 祖先层）里 `layers.every(layer => layer.admits(name))` 的项 + `own`（本 scope 自己的注册，**不受限制**）
   - `restrict()` 只能在 scoped ctx 上调用，且名字必须在 `restrictableNames` 里，否则抛错
2. 我们在 `agents.create` 的 `setup` 回调里调用 `restrict`，`before` 取到 **41** 个名字
3. `max(living_*)` 的注册发生在 preset 组挂载时；`agent.js` 的启动诊断（在 preset 组内）看到的是 **27** 个（11 个 `living_*` + 16 个全局）

**未验证的假设**（按可能性排）

| # | 假设 | 怎么验 |
|---|---|---|
| H1 | `setup` 回调的 ctx scope ≠ agent 最终 scope，所以 `before` 只看到全局 41 个、restrict 落在别的层 | 在 setup 与 `setImmediate` 两个时点打印 `scopeOf(ctx)` / `view()` |
| H2 | `restrict({deny})` 一旦存在，preset 组的工具也被 `admits` 过滤（与类型注释"scope-local 豁免"相反） | 只 deny 一个全局名（如 `mcp__alxrun__run`），看最终是否变成 13 |
| H3 | 41 名单里本身就含 `living_*`（即 `before` 已包含 preset 工具） | 打印 `before` 全名单 |

**当前临时处置**：把 `toolDenyJson` 缩到只剩 `["mcp__alxrun__*"]`，先把微信闭环跑通；其余屏蔽暂停。
风险自负：`mnemon_*`、`mcp__codebase__*` 暂时对它可见。

**H2 的验证正好借这次临时处置完成**：如果缩到 1 条后 `保留` 变成 13，说明之前是名单里含了自家工具（H3）；如果仍是 0，说明任何 `restrict` 都会清空（H2）。

**修好之前不要开自主活动**：现在的工具面要么过宽（关掉收口），要么为空（开着收口）。两种情况都不该让它无人值守跑。

---

## 附：部署侧仍未做的

- 宝石进程受监督（G-2 正式方案）
- `selfcheck` 一条命令验完（登录态 / 路由 / 家目录 / 工具面）
- 真号端到端的 B站 部分（cookie 未登录）
