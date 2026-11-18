# R13：微信多媒体 + B站历史私信/回复补全（2026-11-18）

## 微信

- 入站：`image_item` / `file_item` 从 iLink CDN 下载，按消息里的 AES key 解密，落到
  `~/.dsh/living-gems/wechat/media/<日期>/`；事件文本带绝对路径，模型用 `read` 看。
- 语音：只用微信自带的 `voice_item.text`；没有转写就是 `[语音]（无转写，听不清）`，不做 STT。
- 视频：只记 `[视频]` 占位，不下载。
- 出站：`living_send` 新增 `media: [{ path, name?, kind? }]`（绝对路径）；核心把路径写进
  `outbox.media`，微信通道读取文件后走 `getuploadurl → CDN AES-128-ECB 上传 → sendmessage`。
- 限制：单文件默认 20 MiB；文字气泡 + 媒体合计 ≤10；图片按魔数/扩展名，其余按文件。

## 核心

- `outbox` 新增 `visibility` 列与 `origin` 列（schema v6）：`origin=event` 表示当轮由事件触发，
  其余（自动/日程/启动）记 `proactive`。
- `living_send` 的 media 透传；主动发送的额度/限速不在 core，交给各宝石通道。
- 事件回复（`origin=event`）不占主动额度。

## B站

- 新增只读 MCP：`bili_dm_sessions`、`bili_dm_history`（最近 50 条 + `before` 过滤）、
  `bili_replies`（读子回复）。
- `bili_comments` 返回 `oid/root/parent/reply_to`，回复别人时直接抄目标，不自己拼。
- 发送限制在宝石：`proactiveDaily`（默认 20/天，只计主动）、`sendPerMinute`（默认 5/分钟）、
  `replyCooldownSeconds`（默认 60s/目标）；主动额度用尽以 `provider_quota` 明确失败。
- 宝石在每次 ack 上报 `quota: { day, cap, sent }`；core 缓存并叠加未 ack 的主动 outbox，
  `living_send` 返回 `remaining` 与 `quota` 明细。
- 历史私信不自动灌入；通道首次启动仍补 `dmHistorySeconds` 与未读，避免停机丢消息。

## 微信发送限制

- `sendPerMinute`（默认 5/分钟，所有出站）与 `proactiveDaily`（默认 20/天，只计主动）；
  主动额度用尽以 `provider_quota` 明确失败。

## 未做

- 语音 STT；视频入站下载。
- B站动态发布（三期）：需要 `csrf + dyn_req`、图片上传与风控验证，属于不可撤回的公开发言，
  单独设计工具、闸门与验收。
