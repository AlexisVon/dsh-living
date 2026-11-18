# dsh-living-protocol

WorldGem 的契约包。**写一颗宝石只需要依赖这个包**，不需要依赖核心。

**状态**：契约已实现，24 项测试全绿（`node --test test/`）；发布版本 0.1.0。

## 三件套

一颗宝石 = 一个 npm 包 + 一份 `worldgem.json` + 三件可选的东西：

```
mcp/         ① 能力（MCP server，或引用一个现成的）
channel/     ② 事件（ingest / outbox / ack 的实现）
skill/       ③ 给模型的知识（SKILL.md：能力边界、礼仪、失败语义）
```

三件都不强制，至少交一件。

## 清单

```json
{
  "id": "bili",
  "name": "B站",
  "version": "0.1.0",
  "mcp":   { "command": "node", "args": ["mcp/server.js"], "tools": ["bili_search"] },
  "event": { "protocol": ["ingest", "outbox", "ack"], "visibility": "public" },
  "notify": {
    "push":    { "mode": "ring", "budget": { "limit": true,  "count": true  } },
    "trusted": { "mode": "ring", "budget": { "limit": false, "count": false } }
  },
  "skill": "skill/SKILL.md",
  "capabilities": { "text": true, "image": true, "voice": false, "group": false },
  "limits": { "maxChars": 4000, "perMinute": 10 },
  "etiquette": ["B站评论是公网发言，必须过限制层"],
  "failure_hints": { "gem_cookie_expired": "登录态失效，需重新扫码" }
}
```

`visibility` 取值 `private` / `public` / `group`。`public` 与 `group` 的发声**强制过限制层**——这条由清单声明，不靠模型判断。

### 配置 UI（可选）

宝石不写前端。它在清单里声明 `config.fields`，核心按字段类型渲染控件、做约束校验，再把值写进宝石家的 `config.json`：

```json
"config": {
  "fields": [
    { "key": "dmPollSeconds", "label": "私信轮询", "type": "number",
      "default": 30, "min": 15, "max": 600, "step": 5, "unit": "秒",
      "group": "轮询", "help": "两次拉私信的间隔" },
    { "key": "ownerUid", "label": "主人 UID", "type": "text",
      "default": "", "placeholder": "B站 uid", "group": "身份" },
    { "key": "allowedUsers", "label": "允许的用户", "type": "list",
      "itemType": "string", "default": [] }
  ]
}
```

类型是有限集合：`text` / `textarea` / `number` / `boolean` / `select` / `list`。通用属性：`key`、`label`、`type`、`default`、`help`、`placeholder`、`unit`、`min`、`max`、`step`、`required`、`group`、`options`（select）、`itemType`（list 的 `string` / `number`）。未知类型或未知属性会让清单校验失败——不猜、不降级。

`config.json` 仍然是宝石自己的文件；未声明的 key 会被保留（宝石可以有私有扩展），声明字段的值由核心校验（类型、范围、选项、必填）。运行时 clamp/default 仍是宝石自己的最后一道。

`notify` 决定推送的响铃与预算：`mode: ring` 收到就立即 wake 一轮，`silent` 只落事件、等下一轮顺带处理；`budget.limit:false` 绕过日额度与单轮 token 闸，`budget.count:false` 不计入日预算。`trusted` 对应 `meta.trusted === true`（绑定主人），缺省逐字段继承 `push`。

## Channel 端点

入（宝石 → 核心）：

```http
POST /living/ingest          X-Living-Token: <per-gem token>
{ "gem": "bili", "kind": "message", "external_id": "dm_123",
  "from": {"id": "uid_9", "name": "小明"}, "text": "在吗", "ts": 1763356800 }
```

出（核心 → 宝石，**pull 而非 push**）：

```http
GET  /living/outbox?gem=wechat&limit=20
→ [{ "id": "out_9", "to": "me", "text": "文件在这", "visibility": "private", "origin": "proactive",
     "media": [{"path": "/home/me/a.pdf", "kind": "file"}], "attempts": 0 }]
POST /living/outbox/out_9/ack     { "ok": true, "external_id": "dm_999",
                                     "quota": { "day": "2026-11-18", "cap": 20, "sent": 3 } }
```

四条规矩：`external_id` 必填且去重 · ack 前不删、超时 5 分钟重投 · 每宝石独立 token · 每宝石限流。
`media` 是绝对路径数组，由宝石通道自己读文件；`visibility` 用于公开外发的每日上限。

## 失败码

码表在核心，宝石只提供文案（`failure_hints`），这样跨宝石可聚合、可统一决定是否重试：

`provider_auth` · `provider_quota` · `provider_rate` · `provider_timeout` · `gem_unavailable` · `gem_cookie_expired` · `browser_launch_failed` · `db_locked` · `db_corrupt` · `config_invalid` · `budget_exhausted` · `context_guard` · `window_closed` · `unknown`
