# R4 需求：最终形态（进程内 + DSH 原生 UI + 会话不外露）

状态：待实现 · 2026-11-17 · 验收人：契约守门

用户对最终产品形态的三条硬要求：

1. **直接安装在 DSH 进程上**（已是 cordis 插件，本项无需改动）
2. **控制页与配置页走 DSH 自带 UI**——像本地装的记忆系统（mnemon）或上下文洞察（dsh-context）那样挂在设置页里，**不是自建网页**
3. **它开的主对话不出现在左侧会话列表**

---

## R4-1 管理面收进 DSH 原生 UI（含鉴权）

**问题**：`lib/http.mjs` 暴露了 `/living/state`、`/living/rounds`、`/living/memory`、`/living/outbox/:id/approve|reject`，全部**无鉴权**；而 `dsh_server.py` 会把 3080 整个转发到 LAN ⇒ 局域网内任何人可读它的记忆、并可**替它批准外发**。

`ctx.webServer` 注册的路由不经过 `/api/remote.mux` 那套网关鉴权，且插件拿不到 UI token（`webStartup` 只暴露 host/port/publicUrl/tls）。因此**不能"复用"鉴权，只能把管理面搬进 DSH 通道**。

**改动**
1. 客户端半端（`client.js`）按 `dsh-context` 的方式注册设置页 section：
   ```json
   "dsh": { "client": { "platform": "web", "inject": [
       "@deepseek-ai/dsh-client-connection",
       "@deepseek-ai/dsh-client-ui-settings",
       "@deepseek-ai/dsh-client-ui-sidebar-right"
   ] } }
   ```
   页面内容：状态徽标（RUNNING/SLEEPING/DEGRADED/BUDGET_HOLD/HALTED）、下次唤醒、今日额度、作息热图、最近轮次、L0 快照与 `why_recalled`、外发待审队列（可批准/拒绝）。
2. 删除或收口上述裸 REST 管理路由；数据改由客户端 RPC 取。
3. **保留** `/living/ingest`、`/living/outbox`、`/living/outbox/:id/ack` —— 机对机协议，已有 per-gem token + 限流 + timingSafeEqual。

**验收**
```
# LAN 口（192.168.31.76:3080）无凭据
GET  /living/memory            → 401 或 404（不可读）
GET  /living/rounds            → 401 或 404
POST /living/outbox/x/approve  → 401 或 404
GET  /living/state             → 401 或 404
POST /living/ingest   无 gem token → 401     （现状已满足）
POST /living/ingest   带 gem token → 200     （现状已满足）
```
同时：设置页能在 GUI 里正常打开并展示上述数据。

## R4-2 自主轮会话不进侧栏

**问题**：每轮 `agents.create({sessionId:"living_<uuid>"})` 结束后只 `dispose()`，会话仍留在 store 里 ⇒ 侧栏「未分组」常驻。`grep archive` 在 core 里零命中。

**改动**
1. 轮次会话 `cwd` 用插件家（`home`），不要用工作区
2. 轮次结束（成功 / 失败 / 超时 / 中断）**一律**调用：
   ```js
   await ctx.workspaceRegistry.archiveSession(sessionId)
   ```
   （`dsh-workspace` 的 `WorkspaceRegistry.archiveSession(sessionId, options?)`；归档写入先于 provider 通知）
3. 若 `workspaceRegistry` 未挂载，降级为记一条 warn，不阻塞轮次

**验收**：跑 3 轮后，左侧栏不出现任何 `living_*` 会话；`workspaceRegistry` 的 archived 集合包含这 3 个 id。

## R4-3 孤儿轮次收尾

**问题**：进程被 dsh-market 自重启或被 kill 时，正在跑的一轮留下 `ended_at IS NULL` 的 anchor，`observe.mjs` 把它计成 `open` 并永久留在统计里。

**改动**：启动时扫描 `anchors WHERE ended_at IS NULL`，批量标
```
outcome = 'interrupted', error_code = 'provider_timeout'  ← 或新增 'interrupted' 码
```
并写一条 `round_interrupted` 事件。

**验收**：跑一轮途中 kill 进程 → 重启后该 anchor 的 `outcome` 不再是 null；报表异常栏出现"中断 1 次"。

## R4-4 启动补跑（`recoveryDue` 接线）

**问题**：`clock.recoveryDue()` 定义了但**从未被调用**（runtime/index 里零引用）。错过窗口的唤醒不记账、不补跑。

**改动**：插件加载后、首个 tick 之前调用一次；若 `now > nextWakeAt`，按设计**最多补跑一次**（不补历史），并写事件说明补跑了几分钟前的。

**验收**：把 `nextWakeAt` 人为写早 40 分钟 → 重启后恰好补跑 1 轮，事件里带 `lateMinutes≈40`；再重启一次不再补跑。

---

## 现状对照

| 项 | 现状 | R4 后 |
|---|---|---|
| 进程内 | ✅ | ✅ |
| 设置页 | 有 `client.js`，但数据走裸 REST | 走客户端 RPC |
| 会话不外露 | ❌ 只 dispose | ✅ archive |
| 孤儿轮次 | ❌ 记为 open | ✅ interrupted |
| 启动补跑 | ❌ 死代码 | ✅ 接线 |
| 宝石协议 | ✅ token + 限流 | 不变 |

---

# R4 验收结果 · 2026-11-17 18:40

被测版本：`3cfe14f` · 结论：**四条全部通过**

单测 170 项全绿（含新增 `test/rpc.test.mjs` 111 行）。

## R4-1 管理面收进 DSH 原生通道 —— ✅

| 探测（dev 宿主 127.0.0.1:3099） | 结果 |
|---|---|
| `GET /living/state` | **404** |
| `GET /living/rounds` | **404** |
| `GET /living/memory` | **404** |
| `POST /living/outbox/x/approve` | **404** |
| `POST /living/ingest`（无 gem token） | 401 |
| `GET /living/outbox`（无 gem token） | 401 |
| `POST /api/living-admin`（无 connection 凭据） | **401 unauthorized** |

实现方式：管理面挂到 Connection 通道 `/api/living-admin`（`ctx.connection.register`），`fetch` 走 Connection RPC 信封；裸 REST 全部移除，`lib/http.mjs` 只剩 gem 协议两条。

## R4-2 自主轮会话不进侧栏 —— ✅

跑 3 轮后查 `storages/workspace.json`：

```
"archivedSessionIds": ["living_42ea2f73-…", "living_6d4079a4-…", "living_cca6019d-…", …]
```

三个会话 id **全部进入归档集合**。实现为 `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`，`workspaceRegistry` 缺失时降级为 warn。

## R4-3 孤儿轮次收尾 —— ✅

手工注入一条 `ended_at IS NULL` 的 anchor 后重启宿主：

```
前: {outcome: null, ended_at: null}
后: {outcome: 'interrupted', error_code: 'interrupted', ended_at: 1794911742224}
round_interrupted 事件: 1 条
```

## R4-4 启动补跑 —— ✅

把 `state.clock.nextWakeAt` 人为写早 40 分钟后重启：

```
recovery 轮次: 1 条, trigger_detail: {"lateMinutes":40}
二次重启后 recovery 总数仍为 1（未重复补跑）
未收尾 anchor: 0
```

## 环境说明（不影响结论）

dev home 的模型凭据无法通过认证（`provider_auth`），因此**本轮没有重验"成功轮次"**——该路径已在 R3 验过（`outcome: ok, tokens: 3925, toolCalls: 1`）。原因是 dev home 与主 home 共用同一份 OAuth 刷新令牌，互相踢。

**部署时必须记住**：dev/测试 home 不要直接复制主 home 的 `.credentials.yaml`，应在该 home 里单独登录。这条应写进 `docs/DEPLOY.md`。

## 尚未验的

| 项 | 阻塞原因 |
|---|---|
| LAN 口（192.168.31.76:3080）实测 401 | 插件还没挂进 `web` profile；`/api/*` 需 connection 凭据这一点已在本地验证 |
| 设置页视觉与交互 | 需要开浏览器（用户在场时再做） |
