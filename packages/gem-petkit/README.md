# dsh-gem-petkit

小佩 D4H 单仓摄像头版 WorldGem：状态、周计划、出粮与进食记录、手动出粮。状态里有粮仓有/无（`food`）和碗里余粮百分比（`bowl`）。重要异常唤醒一轮；日常进食只拉不推。

## 装进 dsh-living

开发时把本地目录写进 `gemDirs`：

```yaml
gemDirs:
  - /path/to/dsh-living/packages/gem-petkit
gemTokensJson: '{"petkit":"<随机长 token>"}'
```

重启宿主后在 **Living → 宝石 → 小佩喂食器** 登录。发布后走宝石目录安装。

## 登录

小佩国区是手机号 + 密码（`user/login` 的 `password`，MD5）。国区的短信验证码接口
`user/sendcodeforquicklogin` 对合法手机号返回 105，暂不可用；不要再走验证码路线。

- 面板：宝石页的“登录”会依次弹出账号、密码两个输入框；密码只转发给登录进程，core 不保存。
- 终端回退：`node channel/login.mjs`（密码会回显在终端）。
- 登录成功后只保存 session（0600），用 `user/refreshsession` 续期；刷新失败才需要重新输入密码。

建议使用单独小号并共享喂食器：小佩同一账号只允许一个活跃会话，登录会把手机 App 挤掉。

## 配置

字段在宝石页按 `worldgem.json` 的 `config.fields` 渲染，存到 gem home 的 `config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxPortion` | 20 | 单次出粮上限，D4H 只接受 10/20/30/40/50 |
| `dailyFeedCap` | 40 | 宝石自己发起的手动出粮日累计上限（App 手动与计划出粮不计入） |
| `feedVerifySeconds` | 15 | 提交后等待物理确认的秒数，0 = 不等待 |
| `pollSeconds` | 120 | 状态/记录轮询间隔；太快会被限流 |
| `historyDays` | 7 | `petkit_history` 最多回看天数 |
| `foodLowLevel` | 1 | `state.food` 低于等于此值视为缺粮；D4H 的 `food` 只有 0/2（有/无），先对照 App 校准 |
| `desiccantWarnDays` | 7 | 干燥剂剩余天数提醒 |
| `offlineMinutes` | 30 | 连续不可达超过此时间才唤醒 |
| `batteryLowPercent` | 20 | 只在电池供电（`pim=2`）时有意义 |
| `timezone` | Asia/Shanghai | 日期与出粮时间使用的时区 |

## 停/恢复今天某一顿

- `petkit_skip_meal({ time: "12:00" })`：调 `d4/removeDailyFeed`（`{day, deviceId, id: "s<秒>"}`），只影响今天，不改周计划。
- `petkit_restore_meal({ time: "12:00" })`：调 `d4/restoreDailyFeed`，把今天已停的那顿恢复。
- 调用前先读今日记录：只动计划餐（`s<秒>`）；已出粮的餐、时间已过的餐拒绝；恢复过期餐可能立即出粮，所以也拒绝。
- 调用后重读记录确认 `status=1`（停）/ `status=0`（恢复）；没反映就返回未确认，不要重复调用。

## 看图

`petkit_media` 下载最近一张进食/出粮预览图，解密后保存到 gem home 的 `media/`，返回绝对路径；
agent 用 `read_image` 打开。

- 预览图是 **AES-128-CBC**：key 为 `aesKey` 的 ASCII 16 字节，IV 为 16 个 `0x61`，PKCS#7 去填充。
- 预览 URL 约 1 小时过期，工具每次立即下载；已下载过的同一事件直接复用文件。
- 只做图片；视频需要 Care+，不在工具范围。
- **看图的两种方式**：
  1. living 换到声明图像输入的模型 → `petkit_media` + `read_image`。
  2. 保持文本模型（默认 deepseek-flash）→ `petkit_media` 拿路径，用 `living_send` 的
     `media` 把图发回给主人；agent 不要声称自己看过图。
  `read_image` 在文本模型上会明确拒绝（“does not declare image input”）。

## 事件与拉取

- **ring**：缺粮、离线、故障、出粮失败。
- **silent**：出粮记录、干燥剂到期、低电量。
- **只拉不推**：进食、`pet_detect`、AI 描述、预览链接 → `petkit_status` / `petkit_history`。
- `petkit_plan` 是周计划；一天的停喂只体现在今日记录的 `status=1`，`petkit_status` 会合并成“已停”。

## 出粮时序（2026-11-19 实测 D4H）

- `saveDailyFeed` 返回约 158ms，立即给记录 id。
- +2.9s：`feeding=1`、`addAmountTotal` +10（手动总量）。
- +~10s：`feeding=0`、`realAmountTotal` +10，记录带 `eventId` 与 `state.realAmount=10`、`errCode=0`。

工具以 `realAmountTotal` 增量为最终确认；`unknown` 绝不重试，60 秒内拒绝再次出粮。

## 手动额度归属

`dailyFeedCap` 只算**宝石自己发起的出粮**（按提交记录落 `state.gemFeeds`）。
App 里的手动出粮不占宝石额度；`petkit_status` / `petkit_history` 会把今日手动拆成
「全部 / 宝石 / App」并逐条标注来源。

## 已知边界

- 这台 D4H 的 `typeCode=0`（YUMSHARE SOLO WITH CAMERA），**没有宠物身份识别**；`typeCode=2` 的 YUMSHARE SOLO 2 才有。记录里没有 `petId`。
- 预览链接是 OSS 签名链接，约 1 小时过期。
- 云接口是社区逆向的非官方 API，版本变化会腐烂；失败会明确返回，不会假装成功。
- 出粮量单位按克处理；换机型或校准前先称重验证。

## 开发

```sh
cd packages/gem-petkit
node --test test/
node channel/login.mjs
```

状态与凭据在 gem home（`$PETKIT_GEM_HOME` / `$LIVING_GEM_HOME` / `$DSH_HOME/living/data/gems/petkit`），目录 0700、文件 0600。
