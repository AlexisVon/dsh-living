# 部署与验收手册

2026-11-19 · 适用 `dsh-living` v0.3.9 · DSH 0.2.2-rc.1 · Node >= 24.9（DSH 自身要求）

## 1. 开发环境（隔离 DSH_HOME）

```sh
export DSH_HOME=/path/to/dshdev
dsh --profile living --from-default-profile web --dump-config   # 首次建 profile
dsh plugin --profile living add /path/to/dsh-living/packages/core
dsh --profile living --port 3099 --no-open
```

## 2. 配置是整体替换，必须抄全

`cordis.patch.yml` 里 `config:` **不是深合并**。只写一个字段会让必填的 `home` 丢失：

```
$.home missing required value (at home)
```

覆盖任意字段时，把整份 config 抄全：

```yaml
- id: living
  config:
    home: !!js dshHomePath('living')
    workspace: ''                # 留空 = <home>/workspace
    gemStoreDir: ''              # 留空 = <home>/gems
    timeScale: 1
    tickMs: 60000
    l0Tokens: 3000
    dailyTokens: 2000000
    roundTokens: 700000          # 上下文保险 = 1M 的 70%（可选 500k–800k）
    autoWakeGridMinutes: 10
    autoWakeSampleSeconds: 30
    autoWakeNormalExpected: 0.1
    autoWakeLowExpected: 0.05
    autoWakeHighExpected: 0.2
    autoWakeHotRanges: '06:00-08:00;12:00-14:00;18:00-24:00'
    autoWakeColdRanges: '00:00-06:00'
    personaMaxChars: 6000
    roundTimeoutMs: 600000
    presetId: living
    gemDirs: []
    gemTokensJson: '{}'
    whitelistJson: '[]'
    sessionRoot: !!js dshHomePath('sessions')
```

## 3. 模型路由必须配好

`living` 每轮新建 agent，必须带 provider/model。插件读取宿主默认模型：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-account   # 必须与当前 DSH_HOME 的凭据一致
    model: deepseek-flash
```

不配的报错是 `agent ... has no provider/model`；凭据缺失是 `MISSING_CREDENTIAL`（会映射为 `provider_auth`）。

> ⚠️ **不要把主 home 的 `.credentials.yaml` 复制到 dev home**。同一份 OAuth 刷新令牌被两个 `DSH_HOME` 共用时，一边刷新会让另一边失效（R3 复测中事件轮成功、心跳轮 `provider_auth` 即此原因）。dev profile 请单独登录。

## 3.1 可选：Ollama embedding（回想区段预测）

- 区段预测走 Ollama `/api/embed`；默认 URL `http://127.0.0.1:11434`，不写死宿主。
- `embed.index` 记录当前向量库的模型、digest 签名与维度；签名变化即失效，URL 变了但 digest 相同则沿用。
- 记忆页 → “Embedding / 区段预测”：填 URL、点“刷新”选模型（默认第一个有 `embedding` 能力的）、保存。URL/模型变更会清空 `memory_vectors`，并弹窗询问是否立即重建（带进度条）；不立即重建则等 sleep 补齐。
- 没有 Ollama 也能用：子 agent 退到词法兜底，再不行扫最近 `fallbackDays` 天（默认 3）。无 embed 环境建议把兜底调大（如 30 天）。
- sleep 做全量补齐：30 天窗口、hash 跳过未变行、每批 16 条落库；首次约 4 分钟，之后只处理新增。区段预测在后台重建未跑时每次懒索引 8 条。

## 4. 冒烟与加速

- 想快速看日边界/夜睡：`timeScale: 60`（1 真实秒 = 60 仿真秒，本地日历日照常翻页）
- 触发一轮：

```sh
curl -s -X POST http://127.0.0.1:3099/living/ingest \
  -H 'content-type: application/json' -H 'x-living-token: testtoken' \
  -d '{"gem":"example","kind":"message","external_id":"e1","from":{"id":"u1"},"text":"在吗"}'
```

- 管理数据只在 **Living 主面板**（走 Connection RPC，`/api/living-admin`）；裸 `/living/state|rounds|memory|reports` 一律 404
- 机对机接口仍是 `/living/ingest`、`/living/outbox`、`/living/outbox/:id/ack`（per-gem token）
- 自治轮会话结束后自动归档，不出现在左侧会话列表

## 5. 验收断言

| 项 | 期望 |
|---|---|
| B-1 | 一轮耗时秒级；会话日志含 `turn/start`、`assistant/message`、`tool/call`、`turn/end` |
| B-2 | `budget.tokensUsed` 随轮次增长；最后一次调用超过 `roundTokens` 时本轮 `context_guard`，handoff + rest + 换会话，下一轮照跑；只有日预算耗尽才 `BUDGET_HOLD` |
| 记忆三层 | schema v10；rest 后 `raw_segments` 出现 pending；夜睡后 processed 且 `memory_items` / `memory_edges` 增长；日志有「记忆整理 preset 已注册」 |
| 日报/轨迹 | 日报页是月历，存在日报的日期有标记，选中后在下方渲染 Markdown；轨迹含 `auto_grid` / `auto_hit` / `agent_mark` / 外发条目，外发 tab 已移除 |
| persona DB | schema v10；`persona_docs` 有 charter/self，`journal_entries` 有当天内容；旧 md 文件只做一次性导入 |
| B-3 | 模型失败时 `outcome=error`、`errorCode` 在码表内；连续 3 次 → `DEGRADED` |
| B-4 | 预算/自唤醒上限/退避抑制在状态变化时写一条 `round_suppressed`，恢复写 `round_resumed`；正常 cooldown 不写 |
| B-7 | 一次 ingest 只起 1 轮；之后 10 个 tick 轮次不增加 |
| B-5 | 宝石 ack 失败后从 skill 段摘掉、prompt 出现「本轮不可用」，1/5/30 分钟后半开 |
| R-2 | `/living/state.tools` 不含 bash / pwsh / fs 写工具（管理数据现走 `/api/living-admin`） |
| R4-1 | LAN 无凭据访问 `/living/state|rounds|memory|approve` → 404；`/api/living-admin` → 401；ingest 无 gem token → 401 |
| R4-2 | 跑 3 轮后左侧栏无 `living_*`；`workspace.json.archivedSessionIds` 含这 3 个 id |
| R4-3 | 跑一轮途中 kill → 重启后 anchor `outcome=interrupted`，出现 `round_interrupted` 事件 |
| R4-4 | `nextWakeAt` 写早 40 分钟 → 重启补跑 1 轮（lateMinutes≈40）；再重启不再补 |

## 6. S1 探针

```sh
DSH_HOME=/path/to/dshdev \
  dsh --profile living --patch ./spikes/s1-preset.mjs
```

输出 `[S1] GO` 表示 preset 钉死了工具面；`NO-GO` 则 `round.mjs` 退到每轮子进程。

## 7. 宝石：B站与微信

两颗真实宝石在 `packages/gem-bili`、`packages/gem-wechat`。核心加载清单、注入 skill、把 MCP 挂进 `living` preset，并监督通道进程；**宝石不是 DSH 插件**，不进入 profile 的插件列表。

### 7.1 从宝石库安装（推荐）

**Living → 宝石 → 添加宝石** 列出内置目录（`packages/core/gems/catalog.json`）。选择 B站 / 微信 → 安装：

- 核心用 npm（找不到时回退 pnpm）把包下载到 `<home>/gems`，带 `--ignore-scripts`，版本是目录里声明的精确版本。
- 安装后校验 `worldgem.json` 的 id 与清单一致；不一致会删掉包并报错。
- 安装/卸载后重启宿主：MCP 行和通道监督在插件加载时注册。
- 卸载只删包代码和 `data/gems/<id>/media/`，保留 `config.json`、凭据与 `life.db` 记忆。

开发时继续用 `gemDirs` 指向本地目录（下面的配置）；库里的宝石和 `gemDirs` 合并加载，id 重复时保留库里的并告警。

```yaml
- id: living
  config:
    # 其余字段照抄 §2
    gemDirs:
      - /path/to/dsh-living/packages/gem-bili
      - /path/to/dsh-living/packages/gem-wechat
    gemTokensJson: '{"bili":"<token-bili>","wechat":"<token-wechat>"}'
    gemHomesJson: '{}'          # 可选：{"bili":"/path"}；默认 <home>/data/gems/<id>
    limiterEnabled: true        # 公开发言判决层（默认开）
    gemSilenceMinutes: 10       # outbox 超过 N 分钟无人 claim → 判宝石静默
```

`gemHomesJson` / `gemDirs` 改动后重启宿主；`config.json` 改动后重启对应的宝石通道进程。

设置页的扫码登录会把凭据写进 core 解析出的宝石家目录。如果通道进程用 `BILI_GEM_HOME` / `WECHAT_GEM_HOME` 指向别处，必须让 `gemHomesJson` 指向同一个目录，否则登录和运行用的是两份凭据。

### 7.2 登录（各自一次）

**页面（推荐）**：Living → 宝石 → 对应宝石卡片 →「扫码登录」。二维码在页面里显示，过期自动换码；「刷新二维码」重启登录流程。二维码只走 Connection RPC，不走裸图片路由。

命令行兜底：

```sh
cd "$DSH_HOME/living/gems/node_modules/dsh-gem-bili"   && node channel/login.mjs
cd "$DSH_HOME/living/gems/node_modules/dsh-gem-wechat" && node channel/login.mjs
```

开发时 gems 还没装进库，就把目录换成 `packages/gem-bili` / `packages/gem-wechat`。

**B站信任边界**：在 `$DSH_HOME/living/data/gems/bili/config.json` 里填 `"ownerUid": "<你自己的 B站 uid>"`。bot 账号自己的 uid（凭据里的 `dedeuserid`）**不是**主人。只有这个 uid 发来的私信/@/回复会被标成「主人」、可当指令；未配置时没有主人，所有 B站 内容都是外部数据。微信无此配置：绑定用户即主人。

信任只认 uid；**评论里的 @ 用昵称**（`@昵称`，不能有空格）。模型用 `bili_owner()` 取主人昵称、`bili_user(uid)` 取任意用户昵称，现查现用，不需要把昵称写进配置。

凭据落在 `$DSH_HOME/living/data/gems/<id>/`（0600）。需要自定义时用 `BILI_GEM_HOME` / `WECHAT_GEM_HOME`（各自独立；`LIVING_GEM_HOME` 作为通用回退）。

`gemDirs` 改变后需要重启宿主：`living` preset 的 MCP 行在插件加载时注册，运行期改配置不会重挂。

### 7.3 通道进程

核心的 `channelSupervisor` 会随宿主启动并监督宝石通道；正常使用不需要手动起进程。调试时可以单独跑：

```sh
# B站：私信 30s、@/回复 60s、外发 5s
LIVING_BASE_URL=http://127.0.0.1:3099 LIVING_GEM_TOKEN=<token-bili> \
  node "$DSH_HOME/living/gems/node_modules/dsh-gem-bili/channel/run.mjs"

# 微信：iLink 长轮询 + 外发 5s
LIVING_BASE_URL=http://127.0.0.1:3099 LIVING_GEM_TOKEN=<token-wechat> \
  node "$DSH_HOME/living/gems/node_modules/dsh-gem-wechat/channel/run.mjs"
```

两个进程都只访问 core 的 `/living/ingest|outbox|ack`，不碰管理面。

### 7.4 回复目标

| 目标 | 动作 |
|---|---|
| `uid:<uid>` / 纯数字 | B站私信 |
| `reply:<oid>:<root>:<parent>` | B站公开回复评论 |
| `comment:<oid>` / `bvid:<BV...>` | B站视频下发评论 |
| `me` / `self` / 空 | 微信绑定用户；B站主人私信（需在 B站配置里填 `ownerUid`） |

公开目标是公网发言，过 core 的两道闸：规则表（零成本）→ 判决层（子 agent，`limiterEnabled`）；通过即发，不再人工待审。

- 判决层通过 → 直接进 outbox，可被通道 claim
- 判决层拒绝 → 直接 block，不进 outbox
- 判决层超时 / 报错 / 输出不合法 / 缺席 → 直接 block（fail-safe，不排队等人工）

私信非白名单目标只过规则表，通过即发；私聊 + 白名单目标**连规则表也跳过**（白名单即可信目标契约）：

```yaml
whitelistJson: '["uid:<对方的 B站 uid>","me"]'
```

### 7.5 验收断言

| 项 | 期望 |
|---|---|
| 宝石加载 | 两颗都出现在 `/api/living-admin` 的 `gems`，`available=true` |
| MCP 接线 | 首轮后 `state.tools` 含 `mcp__bili__bili_search` 等工具 |
| 事件入 prompt | ingest 后本轮 prompt 出现 `## 新事件`、正文与发送者 id |
| 私信闭环 | `living_send` 写 outbox → 通道 ack → 对方收到 |
| 判决层放行 | 公开发言 + 判决 pass → outbox 可被 claim；判决拒绝/失败 → 不进 outbox；不再有 `nextAttemptAt=MAX_SAFE_INTEGER` 的新记录 |
| 判决工具面 | 判决会话可见工具数 0（宿主实测 `working_directory` → `(none)`；日志 `限制层工具面已清空`） |
| 外发审计 | outbox 行有 `decision` / `rule_id` / `reason` / `verdict_source`；`outbound_decision` / `outbound_approved` / `outbound_rejected` 事件可查；日报异常含被拦数与判决 pass 率 |
| 宝石静默 | 未 claim 超过 `gemSilenceMinutes` → `gem_silent` 事件、`gemHealth.lastError=gem_unavailable`、skill 段摘掉 |
| 宝石设置页 | Living → 宝石 出现两颗宝石；`config.json` 可保存；凭据状态不出现 `SESSDATA`/`token` |
| 信任边界 | B站非 `ownerUid` 的私信/@/回复 → prompt 标「外部·仅数据」；`ownerUid` → 「主人」；微信绑定用户 → 「主人」；未配置 ownerUid 时全部外部 |
| 扫码登录 | 点击后页面出现二维码；过期自动换码；「刷新二维码」重启流程；登录完成后凭据状态变为已登录 |
| 微信窗口 | 超过 10 条气泡在发送前拒绝（`config_invalid`）；iLink `prepare failed` → `provider_rate`；24h 外 → `window_closed` |

### 7.6 首版边界

- B站：不发动态/专栏/图片；历史私信只读最近 50 条；公开评论受风控，失败按码表 ack
- 微信：文本、图片、文件、语音入站；可发图片与文件；语音无转写时回「听不清」；视频只记占位；群消息忽略
- 发送限制在宝石：`sendPerMinute` 限所有出站，`proactiveDaily` 只限主动发起（默认 20/天），超额 `provider_quota`
- 两颗宝石都依赖各自的登录态；失效需重新扫码，不会静默续期
- 公开发言自动发出 = 判决层通过 + 目标白名单；判决层每次公开外发多一次小模型调用（不占轮次预算，硬顶 20s / 4000 tokens）

## 8. 数据布局与备份/导入

```
$DSH_HOME/living/
  data/
    life.db              # 记忆、人格、日报、外发（schema v10）
    gems/<id>/           # config.json、凭据、media
    backups/             # 手动备份与导入前自动备份
    imports/             # 待替换的导入库
    legacy/              # 旧 charter.md / self.md / journal / reports
  workspace/             # agent cwd
  gems/                  # npm 宝石代码（可重下）
```

旧布局（`living/life.db`、`~/.dsh/living-gems/<id>`、根目录的 `charter.md` 等）会在首次启动时幂等迁入上面的位置；启动日志会逐条打印 `已迁移`。**升级前先停宿主并备份整个旧 home**（`life.db*`、`living-gems/`），迁移只在前台启动时发生，不要在运行中改目录。旧版的宝石数据固定写在 `~/.dsh/living-gems`；如果用过自定义 `DSH_HOME`，启动新版本后需手动把该目录移到 `<home>/data/gems`。

### 8.1 备份

- 页面：**Living → 配置 → 数据与备份 → 备份记忆**。先用浏览器的保存位置选择器选目标，再生成快照；支持选择位置的文件系统会弹保存框，其余浏览器走普通下载。
- 快照用 `VACUUM INTO` 生成一致副本，不需要停宿主；文件在 `data/backups/` 也留一份。
- 手动底线：停宿主后复制 `data/life.db`、`life.db-wal`、`life.db-shm` 三件；只拷 `life.db` 可能丢最近的 WAL 内容。

### 8.2 导入

- 页面：**Living → 配置 → 数据与备份 → 导入记忆**，选择 `.db`。
- 服务端校验：SQLite 文件头、`PRAGMA integrity_check`、`user_version <= 当前支持版本`、必需表齐全；失败直接拒绝。
- 通过后写到 `data/imports/` 并留 pending 标记；**下次宿主启动时**先把当前库移到 `data/backups/pre-import-<时间>/`，再替换。运行中的库不会被直接覆盖。
- 只做覆盖恢复，不合并。更高 schema 的库会被大声拒绝；回退旧版本插件前先恢复对应版本的备份。
- 导入前可点「取消待导入」删除暂存文件。

### 8.3 卸载

- 卸载 `dsh-living` 插件：DSH 只移除插件代码；`data/` 与 `workspace/` 保留。
- 卸载某颗宝石（页面或 `gemUninstall`）：删除 `gems/node_modules/<包>` 与 `data/gems/<id>/media/`；保留 `config.json`、凭据与 life.db 里的记忆。
- 需要彻底清空时手动删除 `$DSH_HOME/living`；这一步不在 UI 里提供。
