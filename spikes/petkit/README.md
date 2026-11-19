# PetKit D4H 冒烟（spike）

独立脚本，不接宝石、不改 core。目标：确认小号登录、设备可见、状态/记录可读、出粮链路可用。

## 状态

- 区域：`CN`，网关 `https://api.petkit.cn/6/`
- 登录：手机号 + 短信验证码（`user/sendcodeforquicklogin` → `user/login` 的 `validCode`）
- 状态文件：`.state/`（0600，已 gitignore）；不会打印 session id
- 还没有验证：共享账号的设备是否可见、`typeCode` 是否为 2、真实字段名、出粮单位

## 步骤

在该目录下运行（手机号替换成小号的）：

```sh
cd spikes/petkit

# 1. 密码登录（国区短信验证码接口目前不通，见“已知坑”）
node cli.mjs login-password 138xxxxxxxx 你的密码

# 3. 看状态与机型
node cli.mjs status

# 4. 看今天的出粮/进食记录
node cli.mjs records

# 5. 看喂食计划
node cli.mjs plan

# 6. 刷新会话（验证续期）
node cli.mjs refresh
```

出粮是物理动作，单独做，必须显式加 `--yes`：

```sh
# 7. 先看状态，再出 10 单位
node cli.mjs feed 10 --yes

# 8. 过一会儿看出粮记录是否新增
node cli.mjs records
```

**不要自动重试 `feed`**：请求超时可能已经出粮，重试会喂双份。先用 `status` / `records` 确认。

## 输出怎么读

- `devices`：看 `typeCode`；D4H + `typeCode=2` 才有 AI 归因。
- `status`：重点看 `state.food`、`state.feeding`、`state.errorCode`、`state.desiccantLeftDays`、`state.batteryPower`。
- `records`：看 `feed` 与 `eat` 的组数和 `items` 字段；确认 `petId` 是否存在、时间字段名。
- 出粮后称一下实际克数，确认 `amount=10` 到底是多少克。

## 已知坑

- **周计划 ≠ 今天实际**：`POST d4h/feed` 返回的是周计划；App 里“停掉今天 12 点这顿”不会改周计划，
  而是把今天的 `getDeviceRecord` 里对应计划项标成 `status=1`（无 state）。要判断今天实际喂没喂，
  必须看今日记录，不能只看 plan。
- PetKit 单账号单会话：这个脚本登录会把小号在手机 App 上挤掉；不要用主号。
- **2026-11-19 实测**：国区网关的 `user/sendcodeforquicklogin` 对合法 11 位手机号返回
  `105 Invalid mobile number`；换成 `+86`、`86-`、`mobile`、GET/JSON 都一样。
  社区库里的验证码登录只对国际站邮箱有效。**现行可用路径是手机号 + 密码**：
  在 App 里给小号设置/重置密码，然后 `node cli.mjs login-password <手机号> <密码>`。
- 密码错误返回 122；账号/密码字段在国区网关是 `username` + `password`（MD5）。
- 设备详情与记录里可能有 `secret` / `sn` / `mac`，CLI 已做脱敏打印。
