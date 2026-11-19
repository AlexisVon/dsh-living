# dsh-gem-mijia（米家宝石）技术路线

> 状态：**讨论稿（2026-11-19）**。只记录路线与边界，未实现、未定稿。
> 定稿前不要建 `worldgem.json`、不要进 `catalog.json`。

## 1. 目标与非目标

**目标**：让 living 通过一颗宝石观察与控制米家设备——设备属性变化进 core 的 `ingest`，属性读写与动作走 MCP 工具。

**非目标**：

- 不做通用智能家居平台，不追求全品类支持；
- 不替代 Home Assistant；
- 不做公网远程控制服务，宝石只跑在宿主所在网络；
- 不把米家做成聊天渠道（没有 outbox）。

## 2. 体系约束（复用现有宝石机制）

- 宝石 = npm 包 + `worldgem.json` + 可选的 MCP / event / skill；至少交一件。
- 事件 kind 已有 `message / notice / change`，设备状态变化用 `change`；只需 `ingest`，不需要 `outbox / ack`。
- `channel` 进程由 core 拉起，拿 `LIVING_BASE_URL / LIVING_GEM_ID / LIVING_GEM_TOKEN`；未配置 token 不会启动。
- 凭据按 B站/微信模式：`login.mjs` 交互写入 gem home，目录 0700、文件 0600，不进 `worldgem.json`。
- 宝石安装走 `--ignore-scripts`、精确版本、官方目录（D-46），第三方依赖的安装脚本不会执行。

## 3. 路线对比

| 路线 | 覆盖 | 实时性 | 主要风险 | 结论 |
|---|---|---|---|---|
| **本地 MiIO**（IP + token） | 同网段 Wi-Fi 设备 | 支持属性推送（`startNotify`） | 需一次性提取 token；Zigbee/BLE 子设备不可达 | 首选，低延迟、不依赖小米云 |
| **小米云**（账号登录） | 账号下全部设备 | 云通道 + 属性订阅 | 非官方接口；登录可能触发 2FA/验证码；限流与账号风险 | 兜底，用于不在同网段或本地不可达的设备 |
| **HA 桥接** | 米家 + 小佩 + 其它家电 | HA 决定（云 MQTT / 本地） | 多一个常驻服务；宝石范围变宽，需要服务白名单 | 若已有 HA，最稳的可选后端 |
| **官方 MIoT 开放平台** | 厂商/企业 | — | 个人账号拿不到通用云接口 | 不可行 |

**共同依赖**：`xmihome`（MIT，Node ≥18，2026-10 仍在更新）。

- 支持 `miio / cloud / bluetooth` 三种连接，自动选择；
- 云登录支持 `on2fa` / `onCaptcha` 回调，可在 `login.mjs` 里做成终端交互；
- 设备无专用定义文件时，可从 MiOT 云加载 spec，再按 `siid/piid` 读写；
- 提供 `getProperties / setProperty / callAction / startNotify / startMonitoring`。

已知限制：

- BLE 的 Linux 配置依赖 postinstall 与 dbus 权限；宝石安装用 `--ignore-scripts`，蓝牙路线需单独手工配置。首版不做 BLE。
- 云登录与云控制走非官方接口，版本变化会腐烂；必须把失败做成显式状态，不能让模型以为设备可控。
- 动态 spec 的属性命名因机型而异，写操作必须落在白名单上，不能由模型给 `siid/piid`。

## 4. 推荐路线

**一个设备适配层，两个后端；首版只开本地 MiIO，云作为显式兜底。**

```
MCP tools ─┐
           ├─ lib/client.mjs ─ xmihome ─┬─ miio  (首选)
channel ───┘                            └─ cloud (显式配置才启用)
```

- 设备清单由 `login.mjs` 发现后写入 `devices.json`（gem home，0600）：id、name、model、address、token、允许的属性与动作。
- 运行时只读这份清单；**模型只看到逻辑名**，看不到 IP/token/siid/piid。
- 连接策略：能本地则本地；`devices.json` 里标了 `cloud: true` 或本地多次失败才落到云。
- 设备发现/登录只在登录脚本里发生；channel 与 MCP 进程不做交互式登录。

**事件**：

- 对清单里声明的属性调用 `startNotify`，变化时 `ingest` 一条 `kind=change`，`external_id = <deviceId>:<prop>:<ts>`。
- 事件都来自自家设备，标 `meta.trusted = true`；日常属性变化再标 `meta.silent = true`（只落事件，下一轮顺带看）。清单里标了 `ring: true` 的属性（门锁、漏水、烟雾）不带 silent，走 `notify.trusted` 的响铃策略。
- 断线重连后做一次全量状态 diff，补发漏掉的 change；不补发历史。

**动作**：

- MCP 工具只接受清单里声明的逻辑动作，如 `mijia_set({device, prop, value})`、`mijia_action({device, action, params})`。
- 白名单是 authored-finite 集合：新增设备/动作必须改 `devices.json`，模型无法自己扩展。
- 高风险动作（门锁、加热、大功率开关）默认不开放；需要用户在清单里显式打开。

## 5. 计划中的宝石形态

```
packages/gem-mijia/
  worldgem.json          # id: mijia；mcp + event(ingest) + skill
  mcp/server.js          # mijia_devices / mijia_state / mijia_set / mijia_action
  channel/run.mjs        # 订阅属性变化 -> ingest
  channel/login.mjs      # 云登录 / 本地设备扫描 -> devices.json
  lib/                   # client、config、credential、errors
  skill/SKILL.md         # 读状态、允许动作、失败语义
```

`worldgem.json` 草案要点：

- `event.protocol: ["ingest"]`，`visibility: private`；
- `notify.push` 默认 `silent`，清单里 ring 的属性由 channel 以 `meta.silent=false` 覆盖；
- `config.fields` 只放简单项（轮询/订阅开关、是否允许控制、日志级别）；设备清单与 token 走 `devices.json`；
- `capabilities: { device: true, text: false, image: false }`（布尔能力表是自由字段）。

## 6. 安全与失败语义

- 账号密码/会话 token 只在 gem home（0600）；日志与工具返回不含 token。
- 设备与动作白名单是唯一入口；不提供"任意设备任意属性"的原始通道。
- 失败码：`auth_expired`（重新登录）、`device_offline`、`device_unsupported`、`action_denied`、`provider_rate`、`unknown`。
- 连接失败必须让 skill 段标注"该宝石当前不可用"，模型不得声称已控制设备。
- 建议单独小米账号并共享设备，降低主账号 2FA/风控影响；若不可行，登录脚本承担全部交互。

## 7. 待验证

1. `xmihome` 云 `startNotify` 的实际推送通道（MQTT？轮询？）与稳定性。
2. 本地 MiIO 的属性推送在不同机型上的覆盖度。
3. 国区账号的验证码/2FA 触发频率；会话 token 能否免密码复用。
4. `--ignore-scripts` 下不含 BLE 的安装是否完整（Wi-Fi 路线应无影响）。
5. 目标设备的 MiOT spec 与属性命名（先拿 1 台设备做 PoC）。

## 8. 阶段

0. 确认设备清单、控制范围、是否已有 HA（本文档）；
1. PoC：单设备本地读写 + 一条属性变化事件；
2. 宝石骨架：`worldgem.json`、MCP、channel、登录脚本、skill；
3. 加固：白名单、失败语义、断线重连、单元测试（mock HTTP/MiIO）；
4. 真机验证 → 本地 `gemDirs` 跑通 → 发布 `dsh-gem-mijia` → 进 `catalog.json`。

## 9. 未决问题

- 接哪些设备、只读还是可控制？
- 是否已有 Home Assistant；有的话要不要直接做 HA 桥接而不是直连？
- 是否接受单独小米账号？
- 首版是否只支持 Wi-Fi 设备（不做 BLE / Zigbee 网关）？
