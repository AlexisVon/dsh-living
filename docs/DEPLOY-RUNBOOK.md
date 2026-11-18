# 部署运行手册（DEPLOY RUNBOOK）

> **历史记录（2026-11-17）**：本文按当时的 `0.1.0-alpha` 和旧目录布局写成；现行安装、目录与备份见 [DEPLOY](DEPLOY.md)。

2026-11-17 21:45 · 首次真实部署记录 · 供后续「插件市场自动化部署」复用

## 0. 当前版本判定

| 项 | 值 |
|---|---|
| 版本 | **`0.1.0-alpha.1`**（alpha：能装、能跑、能观测，但有门禁项未过） |
| 部署位置 | `web` profile（用户日常那个宿主，`dsh_server.py` 拉起） |
| 状态 | 已部署运行中；**自主活动建议先关**（见 G-1） |

## 1. 部署步骤（可自动化）

```sh
# ① 装包（会同时写 dependencies 与 bundles）
dsh plugin --profile web add /path/to/dsh-living/packages/core

# ② 追加配置到 profile 的 cordis.patch.yml
#    注意：config 是【整体替换】，必须写全字段，漏 home 会导致插件不加载
```

```yaml
- id: living
  name: dsh-living
  config:
    home: !!js dshHomePath('living')
    tickMs: 60000
    timeScale: 1
    l0Tokens: 3000
    dailyTokens: 2000000     # 日 token 上限
    roundTokens: 700000      # 上下文保险 = 1M 的 70%；可选 500k–800k
    autoWakeGridMinutes: 10
    autoWakeSampleSeconds: 30
    autoWakeNormalExpected: 0.1
    autoWakeLowExpected: 0.05
    autoWakeHighExpected: 0.2
    autoWakeHotRanges: '06:00-08:00;12:00-14:00;18:00-24:00'
    autoWakeColdRanges: '00:00-06:00'
    personaMaxChars: 6000
    roundTimeoutMs: 300000
    presetId: living
    limiterEnabled: true
    gemSilenceMinutes: 30
    gemDirs:
      - /path/to/gem-wechat
      - /path/to/gem-bili
    gemHomesJson: '{}'
    # 自主轮屏蔽的工具：后缀 * 是前缀匹配，否则精确匹配。允许侧不开放配置
    # （living_* 与已配置宝石的 MCP），其余一律屏蔽 —— 不靠提示词嘱咐。
    toolDenyJson: '["mnemon_*","mcp__codebase__*","working_directory","list_mcp_resources","list_mcp_resource_templates","read_mcp_resource","sidebar_open"]'
    gemTokensJson: '{"wechat":"<32hex>","bili":"<32hex>"}'
    whitelistJson: '[]'
    sessionRoot: !!js dshHomePath('sessions')
```

```sh
# ③ 首次运行后在 Living → 人设 写 charter；旧的 charter.md/self.md/journal 会一次性导入 life.db

# ④ 如果 profile 里还有第二个记忆插件（dsh-mnemon 等），把 living home 从它的
#    参与范围里排除。mnemon 的字段是 excludedWorkspaces（设置 → 记忆 → 存储 →
#    「排除的工作区」），否则它会给 living 会话注入自己的记忆快照。
#    property: agent.session.header.cwd == living home 即被排除。

# ⑤ 校验合成（不启动，只看配置）
dsh --profile web --dump-config > /dev/null   # 必须 exit 0

# ⑥ 重启宿主（配置变更不会热生效）
<your dsh launcher> stop
<your dsh launcher> start
```

## 2. 踩过的坑

### 2.1 `DSH_HOME` 写错会建出一个假 profile

我一开始用了 `DSH_HOME=$HOME`（错），CLI 在 `$HOME/profiles/web` 建了一整套新 profile，装完 `package.json` 里却没有 `dsh-living`。

**正确**：`DSH_HOME` 就是 `~/.dsh`；不确定时**不要设**，让 CLI 用默认值。

### 2.2 `cordis.patch.yml` 的 `config:` 是整体替换

只写 `gemDirs` 会让必填的 `home` 变 undefined，插件直接不加载：

```
$.home missing required value (at home)
```

**规则**：覆盖任意字段时，把整份 config 抄全。

### 2.3 旧 patch 块会持续报警

`bili-scroll` 已卸载，但 patch 里还留着它的配置块，每次启动都报 `patch: entry "bili-scroll" not found`。无害但会掩盖真警告，建议清掉或移到备份文件。

### 2.4 dev 环境不要复制主 home 的凭据

两个 home 共用一份 OAuth 刷新令牌会互相踢，表现为 `provider_auth`。测试 home 应单独登录。

## 3. 部署后验证清单

```sh
# ① 监听与子进程
<your dsh launcher> status

# ② 插件加载（应看到限制层 preset 与宝石）
grep -E "living|gem" ~/.cache/dsh-web.log

# ③ 裸路由必须不可达
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/living/state        # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/living-admin \
  -H 'content-type: application/json' -d '{}'                                      # 期望 401

# ④ 家目录成形
ls ~/.dsh/living/        # life.db（persona/journal/reports 都在库里）

# ⑤ 自主轮的权威工具面（重启后第一轮，应含 living_send 与宝石工具）
grep "\[living\] round tools:" ~/.cache/dsh-web.log | tail -1

# ⑥ 宝石通道由核心拉起
grep "living: 宝石通道已启动" ~/.cache/dsh-web.log | tail -2

# ⑦ 主会话：每个醒着的段落只创建/恢复一次，睡醒才轮换
grep -E "living: 主会话" ~/.cache/dsh-web.log | tail -5

# ⑧ 重启激活（默认开）：启动后应有一轮 startup
grep -E "启动激活一轮" ~/.cache/dsh-web.log | tail -1
```

本次实测结果：

```
dsh: true, dsh_pid: 418762, upstream_ok: true
living: 限制层 preset 已注册（living-judge）
dsh-gem-bili MCP ready
/living/state → 404      /api/living-admin → 401
~/.dsh/living/life.db
```

## 4. 门禁项（拦住 alpha → beta）

### G-1（已缓解，软屏蔽）工具面泄漏：全局注册的工具仍会进轮次

处置按 R9/R10 结论：**`toolDenyJson` 只写进轮次提示（软屏蔽），不做结构收口**。日志里的"未登记工具"告警保留，用于发现新增泄漏，但不进提示词。

宿主实况（自主轮可见工具 **27 个**，其中 10 个是漏进来的）：

```
mcp__alxrun__run              ← 任意代码执行
mcp__alxrun__capabilities
mcp__bili__bili_search        ← B站（绕过宝石协议，但本身无害）
mcp__bili__bili_video / bili_user / bili_owner / bili_subtitle /
mcp__bili__bili_comments / bili_dynamics
mnemon_subagent_result        ← 违反 D-05「记忆独占」
mnemon_view_route / mnemon_view_action
list_mcp_resources / list_mcp_resource_templates / read_mcp_resource
working_directory
```

**结论**：当时 `agents.create` 只传了 `meta.agentPreset`，preset 组合从未绑到 agent scope，所以模型看不到 `living_*`（R10 P1）。修法是在 `setup` 里 `agentPresets.mount(agentCtx, id)`；S1 探针已同步修正。preset 隔离的是「组合」，全局工具仍要靠软屏蔽约束。

**为什么不走结构收口**：当 preset 组合没有真正绑到 agent scope 时，`restrict()` 的可见集里只有全局工具、看不到 preset 注册的 `living_*`；一收口就把自家通道也摘掉（R10 P6）。R10 P1 已修正挂载方式，但结构收口是否重新启用另行评估，当前保持软屏蔽。

### G-2（已解决）宝石的 channel runner 由核心拉起

清单里声明 `channel` 后，核心 spawn 并监督该进程（5s→60s 退避；`exit 2` 视为未登录，按最长间隔重试）；健康状态进 `/living` 的 `gems[].channel`。

**部署时必须停掉旧的旁路守护**，否则两个 runner 会同时长轮询、重复投递：

```sh
systemctl --user stop living-gem-wechat    # transient 单元 stop 即可；enabled 的还要 disable
```

验证：重启宿主后日志出现 `living: 宝石通道已启动: wechat（pid …）`，`/living` 里 `gems[].channel.state = running`。runner 的 stdout 现在带 `[gem:wechat]` 前缀写进宿主日志。

### G-3（中）真号端到端未验

微信需扫码、B站需 cookie。在此之前，宝石只有单测（28 项）与假数据闭环。

### G-4（低）charter 是占位

`charter` 现在是空的。**这是内容工作，不是代码工作**：Living 面板 →「人设」页有编辑器与模板；填入真实设定后，夜睡会按 `persona.evolve` 模式重写 `self`（存 `persona_docs`），轨迹在该页可查看/恢复。

### G-5 推送响铃与预算：写在宝石清单的 `notify`

不需要改宿主配置。当前两份清单：

```json
// gem-wechat：主人私聊，立即回，不占预算
"notify": {
  "push": { "mode": "ring", "budget": { "limit": false, "count": false } }
}

// gem-bili：外部私信/通知计费；我（meta.trusted）免
"notify": {
  "push":    { "mode": "ring", "budget": { "limit": true,  "count": true  } },
  "trusted": { "mode": "ring", "budget": { "limit": false, "count": false } }
}
```

- `ring` = 收到立即 wake 一轮；`silent` = 只落事件，下一轮顺带处理。
- `limit:false` = 日额度 HOLD 时照跑，且上下文保险不生效（只剩 `roundTimeoutMs`）。
- `count:false` = token 与轮次数都不计入日预算。
- `trusted` 缺省逐字段继承 `push`。

**今日用量重置**：设置页"状态"里点"重置今日用量"（或 `budgetReset` RPC）。只清当日计数并解除 `BUDGET_HOLD`，写 `budget_reset` 审计事件；不删历史、不动待处理事件。旧的 `scripts/reset-budget-hold.mjs` 已删除。

## 5. 面向「插件市场自动化部署」的清单

| 步骤 | 现在怎么做 | 自动化要补 |
|---|---|---|
| 装包 | `dsh plugin add` | ✅ 已是 CLI，可直接串 |
| 配置 | 手写 patch 块（必须全字段） | 需要一个 `--config` 落盘方式，或插件支持配置文件分离 |
| 人格 | 手动写 charter.md | 首次运行自动生成模板（现在文件缺失 = 空人格，静默） |
| 宝石进程 | 未解决（G-2） | 核心监督 or 部署脚本 |
| 重启 | `dsh_server.py stop/start` | 市场侧应提供"需要重启"的提示与自动执行 |
| 验证 | 手动 curl | 收敛成 `selfcheck`（登录态/路由/家目录三组断言） |

## 6. 版本门槛建议

| 版本 | 门槛 |
|---|---|
| `0.1.0-alpha.x`（当前） | 能装能跑；G-1、G-2 未过 |
| `0.2.0-beta.1` | G-1 修完（工具面收口）+ G-2 解决（宝石进程受监督）+ 真号跑通一次 |
| `0.3.0-rc` | 压缩时间冒烟 24 模拟小时无异常 + 观测 UI 与报表验收 |
| `1.0.0` | 30 天无人干预不崩 + 文档齐 + 市场清单通过 |
