# dsh-gem-wechat

微信 WorldGem：独立 iLink bot，1 对 1 私聊。文本、图片、文件、语音入站；可发送图片与文件。与 `dsh-wechat` 可以并存（各自一个 bot）。

## 装进 dsh-living

打开 **Living → 宝石 → 添加宝石 → 微信 → 安装**。living 从 npm 下载到
`$DSH_HOME/living/gems`；这颗宝石没有 MCP 工具，只有事件通道与 skill。重启宿主后生效。

开发时也可以绕过宝石库，把本地目录写进 `gemDirs`：

```yaml
# cordis.patch.yml 的 living config
gemDirs:
  - /path/to/dsh-living/packages/gem-wechat
gemTokensJson: '{"wechat":"<随机长 token>"}'
```

## 登录

在 **Living → 宝石** 里点「扫码登录」，或到宝石目录运行：

```sh
cd "$DSH_HOME/living/gems/node_modules/dsh-gem-wechat"
node channel/login.mjs
```

终端会画出二维码，用微信扫码确认。token 写到
`$DSH_HOME/living/data/gems/wechat/auth/token.json`（0600）。可用 `WECHAT_GEM_HOME`（或通用回退 `LIVING_GEM_HOME`）改目录。

## 跑事件通道

```sh
LIVING_BASE_URL=http://127.0.0.1:3099 \
LIVING_GEM_TOKEN=<与 gemTokensJson 里一致> \
node channel/run.mjs
```

- 入站：iLink `getupdates` 长轮询，只处理绑定用户（或 `config.allowedUsers`）的私聊
- 入站图片/文件：从 iLink CDN 下载并用消息里的 AES key 解密，落到 `$DSH_HOME/living/data/gems/wechat/media/<日期>/`，事件文本带绝对路径；语音只用微信转写，无转写时文本是 `[语音]（无转写，听不清）`
- 出站：每 5 秒拉一次 outbox；`to` 为 `me` / `self` / 空时发给绑定用户
- 出站图片/文件：`living_send` 的 `media` 传绝对路径；宝石按 `getuploadurl → CDN 加密上传 → sendmessage` 发送
- 自动发送需要把 `"me"` 加进 core 的 `whitelistJson`；否则每条挂起等人工批准
- 发送限制归宝石自己：`sendPerMinute` 限速所有出站，`proactiveDaily` 只限主动发起的消息（默认 20/天，0=不限）；超额以 `provider_quota` 明确失败
- 通道每次 ack 上报 `quota: { day, cap, sent }`；core 缓存并叠加未 ack 的主动 outbox，`living_send` 返回 `remaining` 与 `quota` 明细
- 同步游标存 `sync-buf.json`；重新扫码会清空，避免续用旧会话

可选配置 `$DSH_HOME/living/data/gems/wechat/config.json`：

```json
{
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "botType": "3",
  "textChunkLimit": 4000,
  "outboxPollSeconds": 5,
  "allowedUsers": [],
  "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
  "maxMediaBytes": 20971520,
  "sendPerMinute": 5,
  "proactiveDaily": 20
}
```

这些字段同时声明在 `worldgem.json` 的 `config.fields` 里：Living 面板的宝石页按声明渲染控件并做校验，不需要手写 JSON；`config.json` 仍是磁盘上的存储形式，未声明的私有 key 会保留。

## 首版边界

- 文本、图片、文件、语音入站；出站只发文本、图片、文件，不发语音气泡
- 语音**不做 STT**：有微信转写就用转写，没有就回「听不清」
- 视频只记占位，不下载
- 只做私聊；群消息忽略
- 单文件默认 20 MiB；文字气泡 + 媒体合计最多 10 条
- 主动发送默认 20 条/天，回复收到的消息不占；超额 `provider_quota`
- 24 小时窗口与 10 条连发限制由 iLink 决定，失败按协议码 ack
