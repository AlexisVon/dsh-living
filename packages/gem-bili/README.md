# dsh-gem-bili

B站 WorldGem：能力（搜索 / 视频 / 字幕 / 评论 / 子回复 / 历史私信 / 动态）+ 事件（私信收发、@/回复通知、公开评论回复）。

## 装进 dsh-living

打开 **Living → 宝石 → 添加宝石 → B站 → 安装**。living 从 npm 下载到
`$DSH_HOME/living/gems`，并自动挂上 MCP server（`mcp__bili__*`）；重启宿主后生效。

开发时也可以绕过宝石库，把本地目录写进 `gemDirs`：

```yaml
# cordis.patch.yml 的 living config
gemDirs:
  - /path/to/dsh-living/packages/gem-bili
gemTokensJson: '{"bili":"<随机长 token>"}'
```

## 登录

在 **Living → 宝石** 里点「扫码登录」，或到宝石目录运行：

```sh
cd "$DSH_HOME/living/gems/node_modules/dsh-gem-bili"
node channel/login.mjs
```

终端会画出二维码，用手机 B站 扫码并选择「记住我 / 长期」。凭据写到
`$DSH_HOME/living/data/gems/bili/credential.json`（0600）。可用 `BILI_GEM_HOME`（或通用回退 `LIVING_GEM_HOME`）改目录。

## 跑事件通道

```sh
LIVING_BASE_URL=http://127.0.0.1:3099 \
LIVING_GEM_TOKEN=<与 gemTokensJson 里一致> \
node channel/run.mjs
```

三条轮询：私信（默认 30s）、@/回复通知（60s）、外发 outbox（5s）。
可选配置文件 `$DSH_HOME/living/data/gems/bili/config.json`：

```json
{
  "ownerUid": "<你自己的 B站 uid，不是 bot 账号>",
  "dmPollSeconds": 30,
  "noticePollSeconds": 60,
  "outboxPollSeconds": 5,
  "dmHistorySeconds": 300,
  "sendPerMinute": 5,
  "replyCooldownSeconds": 60,
  "proactiveDaily": 20
}
```

这些字段同时声明在 `worldgem.json` 的 `config.fields` 里：Living 面板的宝石页按声明渲染控件并做校验，不需要手写 JSON；`config.json` 仍是磁盘上的存储形式，未声明的私有 key 会保留。

`ownerUid` 是**信任边界**：只有这个 uid 发来的私信/@/回复会被标成「主人」、可当指令；其他人和所有工具返回内容都按「外部·仅数据」处理。未配置 `ownerUid` 时没有主人，所有 B站 内容都是外部数据。bot 账号自己的 uid（登录凭据里的 `dedeuserid`）不是主人。

信任只认 uid；**评论里的 @ 用昵称**。需要 @ 人时，模型用 `bili_owner()` 取主人昵称，或用 `bili_user(uid)` 取任意用户昵称，再写成 `@昵称`（不能有空格）。不用把昵称配进配置文件。

## 外发目标

模型通过 `living_send` 写 outbox，`to` 决定动作：

- `uid:<uid>` / `<纯数字>` — 私信
- `reply:<oid>:<root>:<parent>` — 公开回复评论
- `comment:<oid>` / `bvid:<BV...>` — 在视频下发评论

公开目标是公网发言，会先过 core 的限制层；未批准不会进入 outbox。回复别人时优先抄 `bili_comments` / `bili_replies` / 事件行给出的 `reply_to`，不要自己拼。

私信要自动发出，把对方加进 `whitelistJson`（例如 `"uid:123456"`）；否则每条都挂起等人工批准。公开回复同理：白名单目标才自动发，否则停在待审。

## 历史私信

`bili_dm_sessions` 列会话，`bili_dm_history({uid, limit, before})` 按需读历史——只读，只有模型主动调用才会读；B站一次最多返回最近 50 条，`before` 只在这个窗口内过滤。

## 预算与限制

- **主动发送**（模型自己发起、不是回复收到的消息）每天有 `proactiveDaily` 额度（默认 20 条）；额度用尽后，通道以 `provider_quota` 明确拒绝这条外发，不会补发。
- 通道每次 ack 上报 `quota: { day, cap, sent }`；core 缓存并叠加未 ack 的主动 outbox，`living_send` 返回 `remaining` 与 `quota` 明细。
- 回复收到的事件（私信/@/回复）不占主动额度，但仍受限速。
- 通道按 `sendPerMinute` 做滑动窗口，按 `replyCooldownSeconds` 对同一目标冷却；超出时等待，不硬发。
- 回复陌生人会消耗一轮模型预算；是否值得由模型判断。

## 首版边界

- 历史私信只读最近 50 条（接口上限）；不在通道里自动灌历史，由模型用 MCP 工具主动读
- 通道首次启动仍补最近 `dmHistorySeconds` 与未读，保证停机期间的消息不丢
- 不发图片/语音/动态/专栏
- 公开评论受 B站风控影响，失败会按协议码 ack
