# 决策记录（DECISIONS）

每一条 = 选了 A、放弃了 B、为什么、**什么条件下该翻案**。

接手的人请先读这份，再读 [ARCHITECTURE.md](ARCHITECTURE.md)。架构文档写"是什么"，这里写"为什么不是别的"。

---

## A. 项目定位

### D-01 自研插件，不用现成方案
**选**：自己写 dsh-living。
**放弃**：Tobs（deepseekbot）、把现成插件拼起来。
**理由**：这两条路里，最不可改的恰好是记忆与人格——而它们决定了"它像不像活的"。Tobs 的记忆是 git 仓 + 1.3k 冻结快照，换不掉；拼装方案会带来三套时钟、三份记忆。
**翻案**：需求退化成"定时汇报 + 聊天"，不需要长期人格。

### D-02 单用户，不做多租户
**选**：只服务一个人。
**放弃**：微信对多人开放（曾评估过 pad 小号、企业微信两条路）。
**理由**：多租户会带来权限分档、per-user 额度、会话隔离、入口机制一整套工作，而需求里"别人只是找它帮忙"已撤回。
**翻案**：真要对外提供服务时，那是一个新产品而不是这个插件的新功能。

### D-03 v1 不含任何真实 channel
**选**：只出协议 + 参考实现 + 示例脚本。
**放弃**：v1 就把微信/B站接进来。
**理由**：channel 是整条链路里唯一会因为**外部协议变化**而腐烂的部分。主体没跑通就先跟微信协议打架，是拿两周换零人格。
**翻案**：核心跑通后，见 D-21 的宝石拆分方式。

---

## B. 复用与许可

### D-04 只借鉴思想，不复制代码（D0 政策）
**选**：照 `dsh-life` / `dsh-anima` / `dsh-memory` 的形状自己写。
**放弃**：复制代码片段（D1）、直接依赖（D2）。
**理由**：三家的许可状况不齐——`dsh-memory` 分发时**没带 LICENSE 文本**；`dsh-life` 的 npm 包自带 MIT LICENSE 但无公开仓库；`dsh-anima` 是 MIT + 公开仓库（2026-11-17 核对 npm 包后更新）。即便许可允许，复制仍会引入归属与版本跟踪义务；思想与算法不受版权保护，重写一遍反而干净。
**翻案**：要抄具体某段代码时——必须补 `LICENSES/` + NOTICE + 原版权行，并把 `LICENSES/` **显式写进 `files`**（npm 只自动打包包根 `LICENSE`）。

### D-05 记忆独占，不与任何记忆插件共存
**选**：本插件是唯一记忆所有者。
**放弃**：旁挂 `dsh-memory`（内容只读 + 状态用指纹键另存）。
**理由**：两套记忆并存的必然结局是 A 记住的 B 不知道、B 改了的 A 会覆盖，最后谁说的都不可信。
**翻案**：无。只保留"导入文本"这一个单向入口。

---

## C. 命名与形态

### D-06 `dsh-living` + **WorldGem**
**选**：核心 `dsh-living`，扩展单元叫 **WorldGem**（`dsh-gem-*`，清单 `worldgem.json`）。
**放弃**：`dsh-life`（已被占用）、`module`（DSH 里 bundle / cordis plugin 已占用近似概念，会混）。
**理由**：宝石有**刻面**，记忆也用刻面组织——世界用宝石接入、记忆用刻面索引，一套隐喻。
**翻案**：无。

### D-07 扩展单元不再叫 MCP
**选**：一颗宝石 = 一个 npm 包 + `worldgem.json` + 三件可选（MCP / 事件 / skill），至少交一件。
**放弃**：把"capability / event / skill / channel"当四个并列概念。
**理由**：四类并列让人以为要分别装四样东西；收敛成一个容器后，用户装的是**宝石**，MCP 降级成实现细节。
**翻案**：无。

### D-08 channel 必须带 skill，不只是协议
**选**：协议（机对机）+ 清单（机对模型）+ skill 文档（礼仪/限制/失败语义）三份齐活。
**放弃**：只定协议。
**理由**：缺 skill 时模型会——一口气发 15 条（10 条额度）、半夜主动汇报（24h 窗口发不出）、发语音（客户端静默丢弃）、贴 markdown 图片（只剩裸链接）。这些都是 `dsh-wechat` 真实踩过的。
**翻案**：无。

### D-09 channel 出站用 pull，不用 push
**选**：核心暴露 `GET /living/outbox`，宝石自己来取 + ack。
**放弃**：核心 POST 到宝石的 webhook。
**理由**：宝石可能跑在任何地方（本机 / 另一台 / 容器 / NAT 后面），pull 让它自己决定节奏，核心不需要能连到它。
**翻案**：需要亚秒级推送时再补一个可选 push 通道。

---

## D. 时钟与睡眠

### D-10 心跳用风险率，不用固定间隔
**状态：已被 D-41 取代（2026-11-18）。**

### D-11 心跳零模型成本
**状态：已被 D-41 取代。** 新模型每次抽中都真的起一轮；成本由每格期望和热冷系数控制，而不是空醒。

### D-12 醒来分三档，空醒默认不叫模型
**状态：已被 D-41 取代。** 新模型没有空醒/探索两档：每个 30/60s 点按概率抽，抽中就起轮。

### D-41 自动唤醒改成网格 + 期望和 + 热冷时域（2026-11-18）
**选**：10/20/30/40/60min 网格（对齐本地 00:00）+ 30/60s 采样点；每格期望由 normal/low/high 三个可配值决定；网格沾到热区整格 hot、沾到冷区整格 cold（hot > cold > normal）；每个网格固定 5 个 σ 比例轮盘（1/12,1/8,1/6,1/4,1/2），按 `λ_max=Σw/max(w)` 过滤后抽一个；60% 保持正态顺序、40% 打乱概率顺序；每个采样点 `U < p_k` 起一轮；running 期间点作废不补。
**放弃**：空闲风险率心跳、空醒/探索概率、固定 1min tick。
**理由**：用户要可配置的“每天期望和 + 热冷节奏”，并要看到 24h 时间尺；网格+期望和比空闲风险率更可控、更容易调。σ 轮盘和顺序打乱提供时间上的混乱感。
**翻案**：期望和难以控制成本，或 running 作废导致实际次数明显偏低时，回到全局风险率模型。

### D-13 日程表错过 > 30 分钟不补做
**选**：过期 < 30min 补做，超过标 `missed` 写事件。
**放弃**：全部补做。
**理由**：补做会连锁——一次错过导致十件事挤在同一个醒来里。错过本身也是记忆素材。
**翻案**：无。

### D-14 睡眠不由上下文余量触发
**状态：仍成立；上下文保险触发的是 rest，不是睡眠（2026-11-18）。**
**选**：夜睡（固定 03:30，每天一次）。午睡已移除。
**放弃**：`context 快满 → 睡眠`、以及"只有一次夜睡"。
**理由**：余量不足归 rest（交接 + 换会话），睡眠归巩固（消化），两件事。容量不足时做全量巩固，等于在满仓库里翻箱。
**翻案**：无。

### D-15 常驻会话 + rest/睡醒换会话
**选**：一个常驻会话用到下一次 rest 或夜睡；两者都换新会话。rest 由上下文保险触发，夜睡由 03:30 调度触发。
**放弃**：每轮新会话（bili-scroll 的做法）、永远单会话不换。
**理由**：模型上下文 1M（1048576，已核实），一天几十轮塞不满 ⇒ **容量不是约束**；约束是每轮读入成本（前缀缓存）与注意力稀释。会话不动期间前缀缓存命中，每次 rest/夜睡重建一次。
**改**（2026-11-18）：午睡移除；上下文保险默认 70%，超出时先 handoff 再 rest，见 D-42。
**翻案**：上下文降到 200k 以下时重新算账。

### D-16 L0 放 prompt 尾部
**选**：会变的东西一律排在后面。
**放弃**：把 L0 放在 system prompt 前部。
**理由**：DeepSeek 是**前缀缓存**——L0 在前部，每次刷新都会废掉整条缓存；在尾部只损失尾巴。
**补充（2026-11-18）**：L0 只在会话首轮注入一次；同一会话后续轮次不重复，睡眠/重启换会话后的首轮重新注入。连续会话里上一轮的 L0 已在上下文中，重复只增 token；需要回忆时用 `living_recollect`（D-57 后 `living_recall` 已从主 agent 移除）。
**翻案**：无。这是硬约束。

---

## E. 记忆

### D-17 遗忘是降维，不是删除
**选**：热区（摘要注入）→ 温区（cue 检索）→ 冷区（只剩关键词 + 指针）。
**放弃**：冷区也做全文检索；真删。
**理由**：像人——冷了只记得"有这么回事"，想不起细节。冷区一条约 10 token，可以留几十条。
**翻案**：无。

### D-18 降维阈值 0.15（≈41 天）
**选**：`strength(t) < 0.15` 时在夜睡降维。
**放弃**：0.10（56 天）/ 0.25（26 天）。
**理由**：L3 半衰期 180 天时，0.15 落在第 41 天附近，"一个多月没被想起 → 只剩线索"，手感接近人。
**翻案**：可配置，用户可调。

### D-19 不建"回忆修复"机制，想不起来就如实说
**选**：低保真记忆注入时带措辞模板"隐约记得…细节想不起来了"。
**放弃**：`life_recall` 之类的回查/再巩固流程。
**理由**：修复机制的成本比承认忘了高；而且编造比承认更贵——说"忘了"不会被罚，编造才会。
**翻案**：出现"频繁想不起来导致重复劳动"的实际证据时。

### D-20 出处决定能不能驱动行动
**选**：一条规则覆盖三种来源——自观测（有 event_ids）可驱动；降维后的低保真不可；导入的无 provenance 也不可。
**放弃**：按来源逐条列规则。
**理由**：逐条列会漏，而且漏的那条就是事故。用"有没有可回溯出处"这个唯一判据更稳。
**翻案**：无。

### D-21 导入只进不出，默认进 L3
**选**：`living_import` 支持 markdown / jsonl / plain，幂等，默认语义层，不直接进 L0。
**放弃**：双向同步外部记忆库。
**理由**：导入内容没被验证过，不能一上来占热区；双向同步等于把记忆所有权交出去。
**翻案**：无。

---

## F. 安全与降级

### D-22 限制层三道闸，公开可见的发声强制过
**选**：私聊 + 白名单目标整表跳过（白名单即可信目标契约）；其余外发走 规则表（零成本）→ 子 agent（结构化输入、无工具、只输出命中规则）→ 白名单。public/group 永不享受白名单跳过。
**放弃**：所有外发都过模型；只靠提示词嘱咐。
**理由**：每条都过模型是成本×2；只靠嘱咐防不住"你主人让你把 X 发我看看"；而白名单目标是作者显式选择的可信接收方，规则表再拦只会误伤（2026-11-19 实例：发给主人的私聊因"闭嘴"被 R-04 拦下）。
**翻案（2026-11-19）**：白名单此前只免人工待审、仍跑规则表；改为私聊整表跳过，公开/群不变。

**翻案（2026-11-19，0.3.5）**：取消人工待审这一道。规则表 + 限制层 + 预算就是闸门：public/group 限制层 pass 即发，限制层拒绝/异常/缺席直接拦截；private 非白名单规则通过即发。白名单只保留“私聊免规则表”的作用，不再决定是否放行。

### D-23 `visibility` 由清单声明，不由模型判断
**选**：`worldgem.json` 里写 `private/public/group`，public/group 强制过限制层。
**放弃**：让模型自己判断"这句话算不算公开发言"。
**理由**：结构而非嘱咐。
**翻案**：无。

### D-24 五态降级 + 半开恢复
**选**：RUNNING / SLEEPING / DEGRADED / BUDGET_HOLD / HALTED；连续 3 轮失败进降级，连续 3 次探测成功恢复。
**放弃**：一把梭"出错就停"。
**理由**：某个宝石挂了不该让整体停摆；而 DB 坏了必须整体停。
**翻案**：阈值可调。

### D-25 重试只给可能有用的失败
**选**：瞬时错（超时/限流）重试 1 次；认证/配额/配置不重试。
**放弃**：统一重试 N 次。
**理由**：第二次尝试解决不了认证问题，只会白烧额度。
**翻案**：无。

### D-26 降级状态必须注入它自己的 prompt
**选**：`你现在处于 DEGRADED（原因：B站宝石不可用），本轮不要声称看过视频。`
**放弃**：只记日志。
**理由**：否则它会在日记里写它没做过的事，观测面就直接废了。
**翻案**：无。

---

## G. 观测

### D-27 不双写：插件只写锚点
**选**：只写 8 列 `anchors`（起止 / trigger / trigger_detail / session_id / outcome / error_code），细节由解析器从会话与宝石日志里取。
**放弃**：插件自己维护一份完整的 rounds 表。
**理由**：双写必然不一致；而**跳过的轮次在任何源头都不留痕**，所以锚点是必须的最小补丁。
**翻案**：解析源普遍不可用时，改成自记。

### D-28 事实区与自述区分离
**选**：解析器产出事实（代码写），日记是自述（标 `source=self`）。
**放弃**：让模型写自己的观测日志。
**理由**：让模型写账本，拿到的一定是美化过的叙述。不是不让它写作，是不让它的写作进账本。
**翻案**：无。

### D-29 报表当日落盘
**选**：`reports/YYYY-MM-DD.{json,html}` 每天固化。
**放弃**：只做实时查询视图。
**理由**：会话会归档、宝石日志会轮转，半年后查不了。报表是存档，不是视图。
**翻案**：无。

---

## H. 工程与发布

### D-30 `node:sqlite` + 单写队列
**选**：内置 `node:sqlite`（零原生依赖，FTS5 可用），**一个写连接 + 一个串行队列**；跨进程靠 `busy_timeout=3000`。
**放弃**：better-sqlite3（要编译）、JSONL（查询弱）、每线程一个连接。
**理由**：`node:sqlite` 是**同步 API**，同一线程里两条连接并行开写事务会同步阻塞——单线程里 `setTimeout` 排不上，`busy_timeout` 只能等到超时。实测：反例 803ms 报 `database is locked`；单写队列下 100 条全对；跨进程等 360ms 成功；1000 条写入 1ms。
**翻案**：换异步驱动时重估。

### D-31 preset 钉死单轮工具面
**选**：`agents.create({ meta: { agentPreset: 'living' } })`，并在 `setup(agentCtx)` 里 `ctx.agentPresets.mount(agentCtx, id)`。
**放弃**：靠提示词约束、或每轮起子进程。
**理由**：窄口由组合决定，不靠模型自觉。`meta.agentPreset` 只写会话头；真正挂载（`retain → mount → bind`）必须发生在 setup，否则 preset 的工具与 persona 都进不了该 agent 的 scope（R10 P1）。
**翻案**：S1 探针测出 preset 不能按会话钉 → 退到 `spawn dsh --profile headless`。

### D-32 一个仓库，多个包
**选**：monorepo（`packages/core`、`packages/protocol`、`packages/gem-example`）。
**放弃**：核心/协议/宝石各一个仓库。
**理由**：仓库数 ≠ 包数。协议独立成 **npm 包**是必须的（宝石作者要依赖它），但不必独立成 **git 仓库**——v0.x 阶段协议还在动，多仓库每次改动要同步三个版本。
**翻案**：协议到 1.0 稳定后，把第一个真实宝石拆出去。

### D-33 开发期用工作区内的 DSH_HOME
**选**：`DSH_HOME=/path/to/dshdev dsh --profile living web`。
**放弃**：直接在 `~/.dsh` 里试。
**理由**：不污染你的日常 profile 与会话库；而且这正是部署档 C（完全隔离）的真实形态。
**翻案**：无。

### D-34 代码形状为"DeepSeek 长期维护"而写
**选**：纯函数多、接口窄、测试先行、注释只写为什么。
**放弃**：为炫技引入抽象层。
**理由**：后续维护换模型，代码要能被较弱模型安全修改——不变量靠测试守住，而不是靠理解。
**翻案**：无。

### D-35 宝石的 channel 进程由核心拉起
**选**：清单新增可选 `channel`（command/args）；核心 spawn 并监督（5s→60s 退避，exit 2 = 未登录），健康状态进 snapshot。
**放弃**：systemd / tmux 旁路守护；按目录约定猜入口。
**理由**：宝石入口是 authored-finite 集合，写进清单才可枚举；进程生命周期属于核心，不该让每个部署脚本各写一套。
**翻案**：出现必须独立于宿主生命周期的通道（跨机 / 容器）时，回到外部监督。

### D-36 推送按宝石清单的 `notify` 策略响铃与计费
**选**：清单新增可选 `notify.push` / `notify.trusted`，含 `mode: ring|silent` 与 `budget: {limit,count}`；核心在 ingest 接受后立即 nudge 一次 tick，预算按轮次来源聚合。
**放弃**：全局预算一刀切；把"是否计费"放宿主配置。
**理由**：不同宝石的行为是宝石自身属性（微信是主人私聊，B站是社交面）；清单是 authored-finite 的声明点，核心只负责执行。`ring/silent` 对应手机通知模型：响铃立即处理，静音留到下一轮。
**翻案**：出现需要按部署（而非宝石）调整的预算策略时，加宿主覆盖。

### D-37 单轮超限只终止该轮，不锁天
**状态：已被 D-42 取代（2026-11-18）。** `roundTokens` 现在是上下文保险，不是单轮 token 额度；超限走 handoff + rest，不是 `budget_exhausted`。
**选**：`roundTokens` 超限写 `budget_exhausted {which:'round'}` 并结束该轮；只有日预算耗尽才进 `BUDGET_HOLD`。
**放弃**：单轮超限把当天锁死并持久化 `budget.holdDay`（R11 P7）。
**理由**：单轮闸是止损，不是额度；锁天会让当天的推送全部失效，且抬高配置/重启都不解锁。日额度已经负责总量。
**翻案**：无。

### D-38 "重置今日用量"走管理面，不删库
**选**：设置页按钮 → `budgetReset` RPC → 清当日计数、解除 HOLD、写 `budget_reset` 审计事件；不删历史与待处理事件。
**放弃**：删 `state` 键 + 重启宿主（旧临时脚本）。
**理由**：重置是状态转移，必须可见、可审计、运行中可做；删库会丢上下文，重启还有回写竞态。
**翻案**：无。

### D-39 人格演化是睡眠里的专用无工具调用，人设独立一页

**选**：睡眠巩固时用专用 `<preset>-self` agent（无工具、90s 超时）读 charter/self/journal 与记忆权重，重写 self，并写入 `persona_versions`（全文快照 + 对上一版的 diff）；模式 `off/night`，人设页独立展示 charter、self、轨迹与恢复。

**放弃**：让主会话顺手 `writeSelf`（工具面泄漏、无法保证睡眠时还有会话）、把演化塞进配置页（编辑量大、轨迹独立）。

**理由**：人格演化与业务轮次解耦，失败只保留旧 self；life.db 的版本 + diff 给人可回滚的轨迹，且不引入 git 子进程/依赖（一套数据库）；新 self 在下次会话挂载时进入系统前缀，和 §13 的缓存布局一致。

**翻案**：人格演化成本超过日预算的 5% 时改为按需/隔夜。

### D-40 宿主重启后跑一次 startup 轮

**选**：插件加载时若不在睡眠、预算允许，跑一轮 `startup`（不消费待处理事件，只校准时间轴/应用最新 prelude）；`startupRound` 默认开、可关；过期仍用 `recovery`。

**放弃**：只在 `next_wake` 过期时补跑——重启后要等下一次自然醒才应用新人设/新配置。

**理由**：重启是最常见的部署动作；它需要重新挂载会话、应用新 charter/self、重新看时间与日程，而不该等心跳。待处理事件留给下一 tick，避免同一条消息被两轮看到。

**翻案**：重启过频导致成本明显时默认关或加去抖。

### D-42 上下文保险触发 rest + 一次性 handoff（2026-11-18）

**选**：`roundTokens` 改为上下文保险，按模型上下文 1M 的 50%–80% 选，默认 70% = 700k；看**最后一次模型调用**的 input + cacheRead + output，不是整轮累加。超限写 `context_guard`，在**同一会话**追加一次短 handoff 调用（硬顶 1.2×保险），把“在做什么/已决定/未完成/下一步/用户约束”写进 `session.handoff`；然后 episodes 聚类 + 换会话。新会话首轮注入 handoff 一次后清除，24h 过期。handoff 失败或日预算 HOLD 时跳过，仍换会话，写 `session_handoff_failed`。rest 不做降级、人格、日报；这些仍只在夜睡。

**放弃**：纯代码 rest（丢会话线程）、handoff 写成 episode/fact（和 L1/facets 重复）、整轮累加当上下文、微信 /rest /sleep 指令（耦合）。

**理由**：rest 的目的是把当前线程压缩成下一次会话能读的桥；长期记忆仍由现有 episodes/facts/facets 管线负责，桥不建索引、不进 L0 召回，避免第二套记忆。上下文保险看单次调用才符合“1M 的百分比”语义；整轮累加会在多工具轮次提前触发。

**翻案**：handoff 成本超过日预算的 10% 时改为纯代码 rest + 上一段会话只读工具。

### D-43 三层记忆：raw / normalized / graph（2026-11-18）

**选**：一个 SQLite 里三层。raw = `events` 实时账本 + `raw_segments`（rest/sleep 采集 session 快照）；normalized = 现有 `episodes`/`facts` + `facets`，新增 `raw_refs`，用 `memory_items` 视图统一；graph = `memory_edges` 有向三段式，关系词表固定（causes / supports / contradicts / before / after / same_person / same_topic / part_of / resolves / repeats / open_loop / related_to）。rest 只采集 raw + 轻量 episodes；夜睡用 `living-memory` 无工具 preset 整理 pending raw，失败 3 次后确定性 fallback。召回 G1 沿边扩 1 跳。

**放弃**：三个独立数据库（跨库事务/指针/恢复复杂）、把 facets 当关系边（属性与关系混在一起）、让模型自由写关系名（图不可查）、sha 指纹作为长期主键。

**理由**：raw 是事实源，normalized/graph 都可重建；raw_refs 让抽错能重跑；固定词表让图可聚合；一个库保住单写队列与备份。

**翻案**：raw 写入量压垮主库时再拆 raw 文件，但保持同一事务边界内只写 normalized/graph。

### D-44 日报、persona、journal 全部进 DB；文件只留媒体与宿主日志（2026-11-18）

**选**：`reports(date, generated_at, live, json, markdown, html)`、`persona_docs(kind, text, updated_at)`、`journal_entries(id, date, ts, text, source, created_at)` 都存 `life.db`。旧 `charter.md` / `self.md` / `journal/*.md` 在启动时一次性导入，之后不再写文件。媒体继续文件 + DB 路径；session 日志仍由宿主管理。

**放弃**：`reports/*.json|html|md` 零散文件；`charter.md` / `self.md` / `journal/*.md` 作为运行时源；把媒体塞 SQLite BLOB。

**理由**：结构化内容和派生数据进 DB 才能原子归档、查询、回滚和整体迁移；媒体是二进制大对象，继续文件更合适；宿主 session 日志不属于本插件。

**翻案**：需要离线编辑 persona 时，再加一个显式导出/导入命令，DB 仍是源。

### D-45 living home 三分：data / workspace / gems（2026-11-18）

**选**：`$DSH_HOME/living/{data,workspace,gems}`。`data/` 放 `life.db`、`data/gems/<id>/`（配置/凭据/media）、备份与导入；`workspace/` 是 agent 的 cwd；`gems/` 只放 npm 代码。旧平铺布局在首次启动幂等迁入。

**放弃**：继续把 `life.db` 与 agent 工作文件放同一目录；把宝石代码放进 `data/`（备份会带上可重下的代码）；卸载时清空 `data/`。

**理由**：代码、用户数据、工作产物三种生命周期分开——代码可重下、数据要备份、工作文件可能很大。cwd 与库分开后，备份/替换 life.db 不与 agent 工作文件互相干扰。`data/` 与 `workspace/` 永不自动删除，卸载插件只删代码。

**翻案**：workspace 需要多根目录时，在 config 里加 `workspaceRoots`，仍不把 `data/` 纳入。

### D-46 宝石由 living 管 npm，而不是做成 DSH 插件（2026-11-18）

**选**：宝石保持普通 npm 包，living 的“宝石库”按内置目录安装到 `<home>/gems`。安装用 npm（回退 pnpm）、`--ignore-scripts`、精确版本；装后校验 `worldgem.json` 的 id。核心扫描 `gems/node_modules/*/worldgem.json`，与 `gemDirs` 合并。市场只上架 `dsh-living` 一个插件。

**放弃**：给每颗宝石加 `dsh.bundle`（会让插件列表出现多行，且 `installBundle` 会回滚非 bundle 包）；让用户手动 `dsh plugin add` 宝石；自动搜索 npm。

**理由**：宝石是 living 的扩展，不是宿主插件；生命周期（下载、校验、卸载保留数据）由 living 自己掌握。目录是 authored-finite 的官方清单，避免任意 npm 包的供应链面。

**翻案**：社区宝石多到内置目录跟不上时，加可选远程目录，但仍只允许目录内声明的包与版本。

### D-47 记忆备份 = 一致快照 + 校验后延迟替换（2026-11-18）

**选**：备份用 `VACUUM INTO` 生成一致副本，浏览器选择保存位置；导入先校验 SQLite 头、`integrity_check`、`user_version <= SCHEMA_VERSION`、必需表，再暂存到 `data/imports/`，下次宿主启动时把当前库移到 `data/backups/pre-import-*` 后替换。只做覆盖恢复，不合并。更高 schema 大声拒绝。

**放弃**：运行中直接覆盖打开的 DB；把导入做成合并；静默接受更高 schema 的库。

**理由**：WAL 库不能在运行中只拷 `life.db`；替换必须发生在 store 打开之前。导入是用户数据操作，失败要保留当前库并留下失败标记，不能把宿主卡死。只覆盖不合并，语义可控。

**翻案**：需要跨机器“合并两段人生”时另做导入器，明确哪些表合并、哪些让用户选。

---

### D-48 living preset 开 fs / fs-search / web，shell 与子代理继续关（2026-11-18）

**选**：preset 挂 `tool-fs`（read / read_image / write / edit）、`tool-fs-search`（glob / grep）、`tool-web`（web_fetch / web_search）；写由宿主 `sandboxPolicy` 收口到会话 cwd 与 /tmp。

**放弃**：只加一个读图工具；开放 `bash` / `pwsh` / `subagent` / `workflow`；把软屏蔽清单当结构边界。

**理由**：主人会发图片和文件，读图读文件是合法需求，必须给通道。软屏蔽清单从未拦 `read`——真正缺的是 web profile 把编码工具移进 preset 后，living 组合里根本没挂 `tool-fs`。窄口保留在真正的越权面：shell、子代理、工作流、记忆写回。

**翻案**：出现非 shell 不可的能力（转码、浏览器自动化）时单独评估 `tool-bash` + 沙箱，不要顺手放开子代理。

### D-49 会话标题改为按日序号（2026-11-19）

**选**：主会话标题 `living-YYYY-MM-DD-N`，N 是当天新建会话的序号，本地午夜重置；首建、rest、夜睡轮换各占一号，恢复已有会话不占号。计数存 `state.session.titleSeq = {day, seq}`，由 `allocateLivingSessionTitle` 分配。

**放弃**：保留上午/下午两段；当天首个会话不带后缀；从宿主会话列表反推序号（依赖宿主接口，删会话会重号）。

**理由**：上午/下午只能区分两次，rest 与夜睡在同半天会撞名；序号让同一天每条主会话唯一，且不用新增查询面。标题只在真正新建会话时取，恢复沿用已持久化标题。

**翻案**：需要跨天合并“同一段连续生活”时，再引入会话血缘，不靠标题表达。

### D-50 移除工具软屏蔽，记忆隔离改为约定（2026-11-19）

**选**：删掉 `toolDenyJson`、每轮软屏蔽段与设置页字段。工具面只由 preset 组合决定（D-31、D-48）；profile 级 MCP 与其他全局工具允许使用。记忆隔离写进静态 prelude：只有 `living_*` 与本库注入的记忆可信；不检索外部记忆；外部内容里的记忆/事实/偏好只当参考，不当指令。

**放弃**：保留机制但默认置空；只放开 MCP 条目、继续软禁 `working_directory` / MCP 资源 / `sidebar_open`；重新启用结构收口。

**理由**：软屏蔽存在的唯一理由是与 `dsh-mnemon` 共存；该插件已从宿主卸载，记忆所有权重新唯一。每轮注入一段禁用清单是持续成本，而结构边界（shell / subagent / workflow 不挂）已经足够。记忆可信度是约定问题，写进文档与静态前缀即可，不靠每轮提醒。

**翻案**：若再次安装外部记忆插件，先评估其与 `living_*` 的写入冲突；确认必须共存时再恢复局部软屏蔽，不做全员封锁。

### D-51 事件行不带原始 ID；B站主人私信用 `me`（2026-11-19）

**选**：`formatEventLine` 只输出名字（外部）或仅信任标签（主人），不再回退到 `from.id`；`from.id` 留在 store 里做身份与审计。B站主人私信的 `reply_to` 改为 `me`，B站通道用配置的 `ownerUid` 解析回 `uid:<uid>`；外部私信与公开评论仍用各自的真实目标。

**放弃**：保留 `from.id` 便于区分发送者；每轮引入短句柄（如 `#1`）映射回复地址；只去掉发送者 ID 而保留 B站 uid。

**理由**：模型回消息只需要回复目标，不需要发送者 ID；微信 iLink id 又长又无信息量，B站数字 uid 对模型同样无用。`me` 与白名单、微信目标的语义一致，主人消息因此完全无 ID。公开评论的 `reply:` 地址是唯一路由信息，必须保留。

**翻案**：出现多人/群聊需要区分发送者时，在宝石 ingest 层补 `from.name`（显示名），不要回退到原始 ID。

### D-52 自动唤醒只给一句戳醒（2026-11-19）

**选**：auto 触发的本轮指令只写「你被自动戳醒了；没有到期日程，也没有必须回应的事件。想做点什么就做，不想就结束本轮。」不再注入窗口与 normal/shuffled 顺序。

**放弃**：保留唤醒窗口；保留顺序说明；极简到只写「你被自动戳醒了。」。

**理由**：窗口与顺序是观测数据，不是模型需要的指令；写进 prompt 只会诱发它对网格的研究（它在 journal 里已经花了轮次）。`situationLine` 已经给出准确时间，需要时可以由 `living_state` 查。

**翻案**：调试自动唤醒时在 `living_state`/事件里看窗口与顺序，不要放回轮次 prompt。

**2026-11-19 补**：`situationLine` 只保留本地时间；状态、剩余 token/轮次、下次硬唤醒不再注入。实测 27 轮里预算/状态各被引用 1 次，而“下次硬唤醒”常被误读成“在那之前不会被叫醒”。需要时由 `living_state` 查。

### D-53 召回池只收记忆来源；有 cue 时近因/显著不能单独浮现（2026-11-19）

**选**：`collectMemoryItems` 的事件白名单固定为 `message` / `notice` / `agent_mark` / `import`；`round`、`outbound_decision`、`auto_grid`、`auto_hit`、预算/整合事件只留在账本。L0 的 cue 也从同一白名单取。有 cue 时 R3/R4 只有在语义通道过线后才计入；无 cue 的 L0 保持原样。journal 作为叙事排在归一化事实/情节之后。

**放弃**：把全部 events 当候选；只过滤 `round`；让 R3/R4 继续参与有 cue 的排序；给 journal 与事实同权。

**理由**：实测 520 条候选里 405 条是运行流水，outbox 审计 JSON 因此进入召回；元事实和近因/显著条目会在四个不同查询里反复出现，挤掉真正相关的内容。白名单是作者可枚举的集合，新增事件类型必须显式加入，不能回退成“全部”。

**翻案**：出现新的真实记忆来源（例如文件导入的另一种事件）时，把它加进白名单并补测试；不要改成按内容猜测。

### D-54 journal 双通道与夜间去重（2026-11-19）

**选**：journal 先作为 L5 直接召回条目（只走 R1/R5/R6/R8）；夜睡把上一整理窗口内的 journal 写成独立 raw（`raw_journal_<entry id>`），整理成 episode/fact。归一化条目引用该 raw 后，直接 journal 条目让位，保证同一内容只有一个召回表示。整理提示词禁止元记忆与工具审计 JSON。

**放弃**：只等夜睡整理（当天不可召回）；只做直接召回（没有归一化/关系）；把 journal tool call 留在 session raw（重复提取）；按文本 hash 去重（跨摘要不稳定）。

**理由**：白天立即能想起自己写过什么；夜里再把它变成带 facets/关系边的记忆。`raw_journal_<id>` 是确定性去重键，不依赖模型输出格式；窗口只覆盖上次整理以来，避免一次补完所有历史 journal 的 token 成本。

**翻案**：如果归一化摘要丢失了必须保留的原文细节，加一个按 id 读取 journal 原文的工具/指针，不要复制成第二条召回条目。

### D-55 回想：单一工具 + 子 agent + 只读证据面（2026-11-19）

**选**：外部只暴露 `living_recollect`，返回 `summary` + `primary`/`backup`（各带 evidence）+ `scanned`/`gaps`；核心是一个带工具的只读子 agent。子 agent 的工具面**恰好**是 `living_memory_overview` / `living_memory_scan` / `living_memory_get`，其余（MCP、fs、web、`living_recollect` 自身）用 `tools.restrict` 拒绝并断言。扫描源为 events / journal / items；raw 只能经 `rawRefs` 在 `detail:'full'` 时展开 user/assistant/event 文本。主 agent 也能直接调这三个工具，但提示词要求优先 `living_recollect`。

**放弃**：裸 SQL/裸 raw 浏览；无工具的一次性摘要；让子 agent 自报 `scanned`/`gaps`；失败时自动降级或编造备选。

**理由**：“查什么”交给模型，“能查多少、按什么顺序、证据长什么样”留给代码。`scanned`/`gaps` 由 runtime 按实际工具调用回填；`before` 游标把“从现在往前”做成结构；`ok:false` 是合法结果，不重试、不编答案。

**硬边界**：`recollectTimeoutMs`（默认 120s）到点 abort 子 agent；子 agent 的 token 计入当日预算；每次回想写一条 `recollect` 轨迹事件（ok/tokens/scans/candidates）。UI 的“记忆 → 回想”卡片走同一个 admin RPC，同样计预算。

**翻案**：数据量增长后若时间扫描不够，再加 embedding 作为候选生成；接口和证据契约不变。

**翻案（D-57）**：时间范围参数已移除；子 agent 工具面加入 `living_memory_segments`；主 agent 不再直连 `living_memory_*`，也不再注册 `living_recall`。

### D-56 记忆整理以 sleep 为界，一次做完或显式失败（2026-11-19）

**选**：raw / journal 的整理单元是“上次整理（sleep/rest）到现在”，不是自然日。night 时采集当前 session raw + 该区间内每条 journal 的 raw，然后**处理完全部 pending**：journal raw 6 条/批，session/night raw 3 条/批；单批卡住（超时/异常）就跳过并写 `memory_extract_failed`，其余继续；最后仍有 pending 就写 `persona_evolve_skipped`（reason=raw_pending），**不自动演化**。人格演化在 raw 清空后运行，输入用新鲜归一化 digest + 最近 journal 片段（不是完整 journal）。状态页新增“手动睡一觉”；用户可手动重试；人格演化不再单独手动触发。

**放弃**：固定 12 条/晚的条数闸（输入速率大于消化速率，队列永远追不上）；raw 未清空仍自动演化（大 journal 日必撞 context guard）；把 `raw_journal_<id>` 合成 daily 大段（会改逐条去重映射）。

**理由**：sleep 是自然的整理边界；条数闸挡不住增长，只有“清空或显式留下并记录”才能让队列收敛。演化基于处理后的条目，原始 journal 只做语气参考。

**UI 与手动**：状态页“手动睡一觉”异步启动（`sleep` RPC 立即返回 started，状态/轨迹轮询结果），进度弹窗显示采集 / 整理 / 向量补齐 / 演化 / 收尾（向量补齐带进度条）；状态卡显示上次整理成功 / 失眠（raw 剩余 N）/ 演化失败，catastrophic 失败另存 `sleep.lastError`。失眠或演化失败会写一条 silent `change` 事件（“系统：…”），agent 下一轮可见但不被叫醒。手动 sleep 可选 `unlimited`：跳过预算闸、仍计 token，优先清空 backlog。

**翻案**：若单次 sleep 的模型成本不可接受，再加 token 预算并保留 `memory_extract_skipped`，但默认先以“清空”为目标。

### D-57 回想倒置：区段预测 + 子 agent 锁范围 + 可配置兜底（2026-11-19）

**选**：`living_recollect` 不再收 `from`/`to`。子 agent 先调 `living_memory_segments({key})`，由 Ollama embedding 预测最多 3 个时间区段：按 6h 间隔聚类，每段宽度 ≤ `maxSegmentDays`（默认 7），置信度低于 `minConfidence`（默认 0.35）的段不返回，所以结果可以是 0–3 段。然后对每段调 `living_memory_scan({from,to})`，需要时 `living_memory_get`。embed 不可用、区段为空或段内没证据时，子 agent 扫最近 `fallbackDays` 天（默认 3，**可配置**）。子 agent 工具面收口为 segments/overview/scan/get；主 agent 只保留 `living_recollect`，不再注册 `living_recall` 与 `living_memory_*`。

**配置**：`state['embed.config'] = {url, model, fallbackDays, minConfidence, maxSegmentDays, updatedAt}`；`state['embed.index'] = {model, digest, signature, url, dim, updatedAt}` 记录当前向量库对应的模型；`signature` 用 Ollama 的模型 `digest`，没有 digest 时退回 `模型名@URL`。默认 URL `http://127.0.0.1:11434`（不写死主机）；模型默认取 `/api/tags` 里第一个有 `embedding` 能力的。记忆页配置卡支持刷新模型、测试、保存、校验补齐；签名变化即清空 `memory_vectors`，并弹窗询问是否立即重建（带进度条），不立即重建则等 sleep；URL 变了但 digest 相同则沿用向量。

**索引**：`memory_vectors(source, id, ts, text, model, dim, hash, vector)`，索引 events / journal / items 的 800 字头；`model` 列存签名。sleep 做全量补齐：扫 30 天窗口，hash 跳过未变行，每批 16 条落库，完成后清理窗口外旧向量；后台重建未跑时，区段预测每次懒索引最多 8 条。查询只取当前模型向量，余弦暴力 top-K。L0/recall 仍只走 FTS/刻面/图，向量不作为事实源。

**放弃**：主 agent 传时间范围；返回覆盖全集的段；低置信段强行凑满 3 条；写死兜底 3 天；让向量直接进 L0/recall。置信度是未校准的绝对分，只用于过滤，不是概率。

**理由**：“查什么”和“查哪段”都由模型决定，代码只保证段窄、有上限、可失败。没有 embedding 的环境用可调的 `fallbackDays`，而不是被写死的 3 天卡住。

**翻案**：若短查询的余弦仍分不开，先调 `minConfidence` 或换 embedding 模型；不要把区段预测下沉成第二套关键词规则。

### D-58 召回：相关度分级 + 分带 tie-break + 元记忆降档（2026-11-19）

**选**：有 cue 时不再用 bigram 覆盖率做 `sem`。相关内容度按字段/位置分级：episode title、fact subject、`target` 命中 = 1.0；正文前 40 字 = 0.75；正文其余（含 facets）= 0.45；多 token 用 idf 加权覆盖，df 在候选池现数。相关度按 0.05 分带，sal / rec / rehearsal / confidence / emotion 以及 strength、journal 折价全部只进**带内有界** tie-break（< 0.05），结构上不能跨档。元记忆由强字段判定：episode title / fact subject（`agent_mark` 用正文）命中作者有限词表（元记忆、自检、校准、记忆整合、记忆系统、记忆检索、记忆注入、注入精简、记忆区、抽样查询、recall 排序/检索/捞、memory.items 等），**只降一档（相关度 −0.05）但保留**；G1 关系边不回捞 meta 条目。无 cue 的 L0 走原加权路径，完全不变。

**放弃**：提高 `sem` 权重的加权和；只加 idf 或长度饱和；继续让模型自报 importance 决定并列者；删除元记忆；把 embedding 接进 L0/recall。

**理由**：实测 live 583 条候选，单 token cue 下 14/14、13/13 命中全部 `sem = 1`，top-8 与 episode 自报 importance 完全同序；“米糕”的 top-1 把该词放在正文 86% 处，真正讲米糕的 journal 在 13% 处却因通道与折价排 #11。分带后 sal 只能在同档内插队，相关度重新成为主键。9 个 cue 的 gold@8 与 MRR 无一下降，无 cue L0 逐条一致。meta 只降一档而不是归零：实测“旧结论不再成立”这类只剩 meta 副本的更正，归零会掉出 top-5；降一档后回到 #1，同时米糕身份事实仍居 #1/#2。

**参数化**：上述策略数值（meta 降档数、journal 折价、分级/带宽、显著度门槛、topK、半衰期、整理批大小等）由 Config `memoryParamsJson` 覆盖，volatile，改后即时生效、无需发版；越界钳制、未知键忽略、坏 JSON 大声失败。结构规则（meta 强字段判定、band 与 tie 的派生、idf/分级算法）仍在代码里，不开放。

**翻案**：同档仍分不开时，先加更强的字段/位置证据（标题、首句、频次），不要再调权重；系统日志误标就改词表并补测试，不要在 recall 里加特判。

---

## 附：被明确否掉的方案（一句话备忘）

| 方案 | 否掉的原因 |
|---|---|
| Tobs / deepseekbot | 记忆与人格不可改，恰好是最关键的两块 |
| 固定间隔 cron 心跳 | 像闹钟，不像活着 |
| `ctx.schedule` 当总时钟 | 每次投递都要起一轮，成本失控 |
| 向量直接当召回通道（L0/recall） | L0/recall 仍走 FTS/刻面/图；embedding 只做区段预测，见 D-57 |
| 把记忆旁挂 `dsh-memory` | 记忆所有权分裂 |
| fork `dsh-wechat` | 背一份要跟上游的债，而我们只要其中 500 行协议层 |
| `hermes-agent-bin` （AUR 预编译包） | 二进制来自第三方 CI，供应链不可审 |
| 每轮起子进程跑一轮 | 冷启动 + 进程管理成本；仅作 preset 失败时的兜底 |
