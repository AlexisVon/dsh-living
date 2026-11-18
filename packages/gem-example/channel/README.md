# channel/ — 事件参考实现

这颗示例宝石只演示协议形状，不接任何真实平台。

| 端点 | 方向 | 说明 |
|---|---|---|
| `POST /living/ingest` | 宝石 → 核心 | `x-living-token` 鉴权；`external_id` 必填且去重 |
| `GET /living/outbox?gem=<id>&limit=20` | 核心 → 宝石（pull） | 核心不主动连宝石，宝石自己来取 |
| `POST /living/outbox/<id>/ack` | 宝石 → 核心 | `ok:true/false`；失败按码表决定是否重投 |

`poll.mjs` 是轮询参考：取到消息 → 假装发送 → ack。真实宝石把"假装发送"换成平台 API 调用即可。

四条规矩（协议层保证）：

1. `external_id` 必填且去重——长轮询会重投，没有去重会把同一句话处理两遍。
2. ack 前不删；5 分钟内未 ack 自动重投。
3. 每颗宝石独立 token。
4. 每颗宝石独立限流（清单 `limits.perMinute`）。

鉴权失败的响应是 401；限流是 429；两者都不该静默重试到无限。
