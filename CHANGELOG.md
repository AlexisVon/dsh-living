# Changelog

## 0.3.17 — 2026-11-27

- 记忆整理：模型输出 JSON 解析失败时同轮自动重试一次（写 `memory_extract_retried` 事件，两次调用的 token 都计入预算）；仍失败才保留 pending、记失眠。修复 2026-11-27 凌晨两批输出语法错误（属性间全角逗号、facets 数组缺 `]`）导致 12 条 raw 失眠。
- 测试：core 399 / 全仓 522。

## 0.3.16 — 2026-11-26

- 笔记 UI：关键词行直接列出该词下的全部编号（如 `喂猫 S7 S9 S10 S11 A1`），不再用 `S4 A1` 计数，避免与编号混淆；新增「关键词查看 / 全部笔记」切换，全部笔记按 S/A/B 分组直接浏览并操作；`notes` RPC 关键词带 `codes` 并同时返回 `entries`。
- 测试：core 397 / 全仓 520。

## dsh-gem-petkit 0.1.3 — 2026-11-26

- 状态口径：D4H 的粮仓 `state.food` 只有有/无两档（0=空、2=有粮），`food=1` 只在支持多档的机型上出现；状态里一直有 `state.bowl`（碗里余粮百分比），但之前没展示。`petkit_status` 现在输出「粮仓 有粮/空（food=N）；碗里 X%」，机型上报 `percent`/`weight` 时一并显示。缺粮报警在 food=0 时说「粮仓空了」，food=1 才说「粮量低」。
- SKILL 补「粮量口径」：`food` 是粮仓有/无，`bowl` 是碗里百分比（不是克数）；不要用 `bowl=0` 直接判断猫饿。
- 测试：gem-petkit 33。

## 0.3.15 — 2026-11-26

- 手写笔记 `living_note`（自写提示/规则 + 热区记忆补充，补自动记忆覆盖不到/不及时的部分；不是 journal）：编号是当前视图槽位——S 持久（≤50 条）、A 今天临时、B 昨天临时（各 ≤10 条），每层 40 字 + ≤5 字关键词；删除留空、不重排，新写/升/降都取最小空闲槽，跨天 A 同序号变 B。关键词索引列出全部 tag 及 S/A/B 计数，条目按 tag 查询；S 的 core（≤8）每段新会话首轮注入全文，其余 S 只进索引，A/B 全文注入，B 只读。写入成功只返回新编号 + 余量，失败大声给原因与下一步；不要求回读，避免习惯性双校验。后续轮次不重复注入；sleep 机械清理过期临时条 + 自由环节复盘；接近上限未动笔记写 `notes_ignored`；日报与 snapshot 带笔记计数。Living 新增关键词优先的「笔记」tab（记忆与日报之间）：关键词表 + 按词条目，新增、编辑、删除、升 S、降 A、core 切换；B 无操作按钮。
- 会话续接：非 sleep 的轮换/重启/恢复失败走压缩交接——读旧会话 transcript，tool-free `living-handoff` 子 agent 压到 ≤800 字（当前任务、决定、未完成、下一步、主人约束），失败/超时/预算不足退回最近 6–10 条确定性尾部；`session.handoff` 注入后清除，TTL 72h。夜睡/手动睡眠是边界：清空交接、不续接对话；跨睡眠只走笔记/日程。轮换/恢复失败前补采旧会话 raw，`living_recollect` 以后能捞到（不再只保每晚当前会话）。
- 热区：`recall.toResult` 带 `ts`，L0 条目显示本地日期（不再全是 `[—]`）；记忆整理 prompt 每行带 `@epoch ms`，每个 episode/fact 的时间戳必须落在自己的 raw 段内，越界夹紧并计 `tsFixed`；facts 用自己 raw 段的起点/终点，不再用批首段。
- schema v11：新增 `notes` 表（`seq` 槽位；persistent 的 `seq` 与 temp 的 `day+seq` 各自唯一）；一次性按 raw 段修正历史 episode/fact 时间（测试库实测 episode 613 / fact 701）、清空错误 cold，并写 `change` 事件与 `schema.repair.v11` 计数（无修复的 fresh DB 不写）。
- 修复 bundle 默认 `roundTokens: 150000` 低于 schema 下限 500000，fresh 安装会激活失败；默认改为 700000（与 schema 默认、部署文档一致）。
- 冷区：同 label 去重后展示；夜间只保留最新 16 个 label；L0 注入写 `access(kind=inject)`，先度量不参与排序。
- 测试：core 396 / 全仓 519。

## dsh-gem-petkit 0.1.2 — 2026-11-22

- 周计划星期标签修正：小佩 `repeats` 为 1=周日…7=周六（OEM），原代码按 1=周一渲染，整体错一天。现在先转 ISO 再按周一到周日排序显示，周末组 `{1,7}` 正确显示为「周六、日」。
- `formatPlan` 移入 `lib/plan.mjs` 并补测试（gem-petkit 30）。

## 0.3.14 — 2026-11-20

- 睡前自由环节：sleep 的第一阶段改为主会话自己的回合（capture 之后，不注入 L0/digest）；可以写 self、写 journal、整理日程/待办，或什么都不做。删除 `<preset>-self` 无工具子 agent 与注入式 charter/journal/digest（D-39 翻案）。
- `living_write_self`：仅自由环节窗口开放，窗口外大声失败；窗口内只暂存一版，后写覆盖；环节结束由框架统一写入 `persona_docs` 并记录一条 `persona_versions`（diff + 快照）。超时/硬顶截断但已暂存也提交。
- 独立硬顶 `selfBudgetTokens`（默认 8,000,000，配置页可改）：绕过日预算/轮次/`BUDGET_HOLD`，只计 token、不计轮次；调用前按上次上下文预估，回合内累计超限即中断；`0` 关闭该环节；手动睡勾选“不限制 token”时绕过硬顶。
- 失眠不再跳过 self；自由环节失败/超预算与失眠并列显示，互不阻断。睡眠进度新增 `freetime` 步，上次睡眠卡显示写 self / 未写 / 超预算 / 失败 / 跳过。
- 删除 `persona-evolve.mjs`、`<preset>-self` 注册、`personaAvailable`、`personaEvolveNow` RPC 与 `raw_pending` 演化闸。
- 测试：core 370（全仓 488）。

## 0.3.13 — 2026-11-20

- `dsh-gem-petkit` 0.1.1：设备错误码按不透明 token 处理（如 `blk_d`；`0`/空为无错），修复字符串错误码经 `Number()` 变 `NaN`、导致同一故障每次轮询（120s）都重发唤醒；同一故障状态只通知一次，恢复发一条静默 `error_clear`。
- 故障事件 `external_id` 改为 `code + errorSeq`：重放同一跳变由 core 的 `ingest_seen` 吞掉，新故障仍唤醒一次。
- 出粮验证与 `petkit_status` 共用同一归一化，故障期间手动出粮不再误报「错误码 NaN」。
- 宝石版本解耦：内置目录的 `version` 改为最低版本 floor，安装/升级目标 = max(floor, registry `latest`)，永不自动降级；宝石修复不必再随 core 发版。
- 夜间睡眠新增「检查宝石更新」步骤：自动升级已装宝石到 latest，写静默事件；单个失败不打断睡眠；升级代码在下次宿主重启后生效。
- 兼容契约：`worldgem.json` 支持 `engines.dsh-living` 版本范围，安装/加载时校验；不兼容则拒绝并恢复旧版。`dsh-gem-petkit` 0.1.1 已声明 `>=0.3.0 <0.4.0`。
- 宝石页显示 registry 最新、可升级与待重启状态，支持手动升级。
- `dsh-gem-petkit` 新增 `petkit_skip_meal` / `petkit_restore_meal`：只停/恢复今天某一顿计划餐（`removeDailyFeed` / `restoreDailyFeed`），不改周计划；已出粮或时间已过拒绝，恢复后重读记录确认 `status`；小佩 1514 限流有明确提示。
- 测试：core 361 / gem-petkit 28（全仓 479）。

## 0.3.12 — 2026-11-19

- 日程：`living_plan` 的 `at` 必须是 13 位 epoch 毫秒，秒级时间戳大声失败；启动时把已存的秒级值修成毫秒，并清掉因此误标的 `missed`。
- 日程闭环：新增 `living_schedule`（按时间读，可含 done/missed）与 `living_unschedule`（按 id 删除，返回 removed/missing）；时间轴每行可取消/移除，取消写 `schedule_cancelled` 事件。
- 状态页：日程改为按时间排序的时间轴，默认今天；有未来日程时显示日期 tab（今天/明天/MM-DD）可切换查看；完成/错过有状态色，hover 显示完整 intent。
- 配置页：自动唤醒字段防横向溢出；高热/低热改整行两行文本域，字段行不再高低错位；图表 24h 完整显示，夜睡窗口改斜纹填充 + 亮虚线，顶部“夜睡/现在”标签不再被裁切。
- 主会话恢复：被 UI/其他消费者占用（active write handle）时，先归档、短暂等待后重试一次，仍失败才新建会话；日志写明占用原因。
- 测试：core 353。

## 0.3.11 — 2026-11-19

- 记忆策略卡：Living「配置」页新增 `memoryParamsJson` JSON 文本域，保存前校验对象，可格式化、恢复默认；坏 JSON 拒绝写入。
- 作息可配：Config 新增 `nightAt`（默认 `03:30`）与 `nightWindowMinutes`（默认 `360`）；「作息与自动唤醒」卡加时间/窗口输入，24h 图上实线=触发点、虚框=补睡窗口。
- 夜睡不再有固定 90 分钟时长；实际耗时记录到 `state['sleep.last']` 并写 `sleep` 事件，状态页显示“上次睡眠 X 分钟”；修复睡眠完成后用时继续增长。
- 状态页：12 栏布局（宽屏前三卡 + 下一次醒来 8/4 + 宝石），日程默认 3 条可展开，工具面并入主会话，时间统一为 24h / 今天·明天格式；睡眠中主会话显示“睡眠中，唤醒后新建”。
- 测试：core 350。

## 0.3.10 — 2026-11-19

- 召回：meta 不再降到最低档，改为只降一档（相关度 −0.05）；“旧结论不再成立”这类只剩 meta 副本的更正回到前排，9 个真实 cue 的 gold@8/MRR 不变。
- 记忆策略参数开放：Config `memoryParamsJson`（volatile）覆盖 24 个召回/衰减/抽取参数，越界钳制、未知键忽略、坏 JSON 大声失败；默认值与 0.3.9 行为一致，改参数不需要发版。
- 测试：core 348。

## 0.3.9 — 2026-11-19

- 召回排序重做：单 token 线索按字段/位置分级（title/subject/target 1.0、正文前 40 字 0.75、正文其余 0.45），多 token 用 idf 加权；相关度按 0.05 分带，sal/rec/strength/journal 只进带内有界 tie-break。
- 元记忆（自检/校准/记忆整合等）由强字段判定，降到最低档但保留；G1 关系边不再回捞 meta 条目。
- 实测 9 个真实 cue：gold@8 与 MRR 无一下降，无 cue L0 逐条不变；cue recall 583 条候选多 ~0.6ms。
- 测试：全仓 449（core 338）。

## 0.3.8 — 2026-11-19

- L0/记忆事件文本带上 `meta.reply_to`（`（回复目标: …）`），agent 不再丢失 @/回复通知里的 root rpid。
- `dsh-gem-bili` 0.2.2：新增 `bili_comment_tree`（root/reply_to → 根评论 + 嵌套子回复 `children`，含 `parentAuthor`/`depth`/每条 `reply_to`，默认 50 上限 100）与 `bili_notifications`（最近 @/回复通知及 reply_to）。
- 测试：core 330 / gem-bili 39。

## 0.3.7 — 2026-11-19

- 外发 ack 失败写入 silent `change` 事件（含 gem/目标/错误码/是否重试），agent 下一轮可见，不再把 approved 当已发送。
- `dsh-gem-bili` 0.2.1：分享视频不再误判为系统通知（保留主人/trusted）；`at/reply` 通知读 `at_time`/`reply_time` 并修正 rpid 回退；`comment:BV...` 自动解析为视频评论；私信轮询默认 60s。
- 测试：core 329 / gem-bili 35。

## 0.3.6 — 2026-11-19

- 白名单改为单级：任何 visibility 命中白名单都直接发，规则表与限制层都跳过。
- 非白名单仍走合规审核：规则表；public/group 再过限制层；通过即发，拒绝/异常/缺席直接拦截，无人工待审。
- 测试：core 329。

## 0.3.5 — 2026-11-19

- 外发取消人工待审：规则表 + 限制层 + 预算即最终闸门，不再产生新的 `review` 记录。
- private 非白名单目标：规则表通过即发；public/group：限制层 pass 即发。
- 限制层拒绝/异常/缺席 → 直接拦截，不排队等人工；`living_send` 与配置文案同步。
- 测试：core 328。

## 0.3.4 — 2026-11-19

- 向量库身份改为模型签名：`embed.index` 记录 `{model, digest, signature, url, dim}`，`memory_vectors.model` 存签名（digest；没有 digest 时 `模型名@URL`）；同名模型重新 pull 导致 digest 变化时，旧向量失效并重建。
- URL 变化但 digest 相同视为同一套权重，沿用现有向量；选模型/保存时只在签名变化时弹窗询问是否立即重建。
- 解析不到 digest（非 Ollama 端点或 `/api/tags` 不可用）时退回 `模型名@URL`；暂时读不到签名则不误清，等下次索引校验。
- UI 显示索引签名前 12 位；保存后提示“签名未变 / 无法读取签名”。
- 旧 `embed.index` 没有签名时自动补签名并保留现有向量，不因升级重建。
- 测试：core 328。

## 0.3.3 — 2026-11-19

- 回想倒置：`living_recollect` 不收 from/to；子 agent 先调 `living_memory_segments` 预测 0–3 个时间区段，再用 `living_memory_scan({from,to})` 扫描。区段按 6h 聚类，单段 ≤ `maxSegmentDays`（默认 7），低于 `minConfidence`（默认 0.35）不返回。
- embedding 不可用或区段为空时扫最近 `fallbackDays` 天（默认 3）；无 embed 环境可在 UI 调大，不写死。
- 新增 Ollama embedding 配置与 `memory_vectors` 索引：默认 URL `http://127.0.0.1:11434`，模型默认第一个有 embedding 能力的；支持刷新模型、测试、保存、校验补齐。`embed.index` 记录模型/URL/维度，模型变更即清空旧索引。
- 子 agent 工具面收口到 `living_memory_segments` / `overview` / `scan` / `get`，MCP、文件与网页工具全部拒绝；主 agent 收掉 `living_recall` 与 `living_memory_*`，只留 `living_recollect`。
- sleep 全量补齐向量：扫描 30 天窗口，按 hash 跳过未变行，每 16 条一批落库；完成后清理窗口外旧向量。embedding 失败只记录，不拖死 sleep。
- 手动 sleep 增加进度弹窗（采集 → 整理 → 向量补齐 → 演化 → 收尾，含向量进度条）；人格演化独立按钮移除，演化只在 sleep 内运行。
- 选择/保存新 embedding 模型时，若检测到变更，弹窗询问是否立即全量重建（带进度条）；不立即重建则等 sleep 补齐。
- 记忆页新增 Embedding 配置卡；回想 token 计入当日预算，并写 `recollect` 轨迹事件。
- schema v10：新增 `memory_vectors` 与 `embed.index` 元数据。
- 测试：core 326。

## 0.3.2 — 2026-11-19

- 新增 `living_recollect`：慢路径只读子 agent 做自然语言回想，返回 summary / primary / backup / 证据 / 扫描覆盖；失败合法。
- sleep/rest 采集缺少 session 文件时写 `raw_fallback` 轨迹事件，不再静默降级。
- night 不再固定 12 条：一次处理全部 pending raw（journal 6 条/批，其余 3 条/批）；单批卡住跳过并记录，raw 未清空时跳过自动演化，等 UI 手动触发。状态页新增“手动睡一觉”。
- 人格演化改用新鲜归一化 digest + 最近 journal 片段，上下文守卫提升到 32k，避免大 journal 日必失败。
- 状态页新增“手动睡一觉”：异步启动，状态卡显示上次整理成功 / 失眠（raw 剩余 N）/ 演化失败；失眠或失败写 silent `change` 事件给 agent。手动 sleep 可选不限制 token（跳过预算闸、仍计 token）。
- 修正 `lastConsolidation` / persona 最近事件的排序（用 desc 取最新）。
- 测试：core 310。

## 0.3.1 — 2026-11-19

- 外发：私聊 + 白名单目标跳过整张规则表（public/group 仍走规则表与限制层）；非白名单私聊不变。
- 情境行只保留本地时间；状态、剩余 token/轮次、下次硬唤醒不再注入，需要时由 `living_state` 查询。
- 时间修正：下次唤醒与 `living_events` 改用本地时区；记忆条目/冷区日期按本地时区取。
- 账本：轮次超时的失败码不再记为 `unknown`，按 `provider_timeout` 落库。
- 测试：core 295。

## 0.3.0 — 2026-11-19

- 登录通道支持 `prompt` / `input`：宝石页可以渲染账号、密码等输入；core 只转发，不保存密码。
- 宝石页改为二级下划线子页，一次显示一颗宝石；添加宝石移到右侧按钮 + 弹窗。
- 新增 `dsh-gem-petkit` 0.1.0：小佩 D4H 状态/出粮/记录/计划/看图；只推重要异常，出粮有单次/日上限与确认等待；channel 与 feed state 分离。
- 内置宝石目录加入小佩喂食器。
- 测试：core 293 / protocol 24 / gem-bili 34 / gem-wechat 27 / gem-petkit 21。

## 0.2.0 — 2026-11-19

- 会话标题改为 `living-YYYY-MM-DD-N`，按本地日序号；恢复会话不占号。
- 事件行不再打印原始 ID；B站主人私信用 `me`，通道按 `ownerUid` 解析。
- 自动唤醒只保留一句戳醒，不再注入网格窗口与顺序。
- 移除工具软屏蔽；记忆隔离改为静态 prelude 约定。
- 召回池只收 `message` / `notice` / `agent_mark` / `import` 与未整理的 journal；运行流水与审计 JSON 不再进召回。
- journal 直接召回 + 夜睡独立 raw 整理，归一化后直接条目让位去重；整理提示词禁止元记忆。
- 有 cue 时近因/显著不能单独让条目浮现；journal 叙事排序低于归一化记忆。

## 0.1.0 — 2026-11-18

首个公开版本。

- 时钟：10–60min 自动唤醒网格、热冷时域、日程、rest 与 03:30 夜睡。
- 记忆：raw / episodes+facts+facets / memory_edges 三层同库；夜睡无工具 preset 整理；G1 图召回；降维遗忘。
- 人格：`charter` 只读、`self` 夜睡重写并版本化、`journal`；全部存 `life.db`。
- 审计与外发：日预算、上下文保险 handoff、公开发言限制层、外发待审/ack/重投。
- 观测：轮次锚点、时间轴、日报（存 DB）、人设/记忆/外发面板。
- WorldGem：宝石协议 + B站/微信两颗宝石；宝石由 living 从 npm 安装到自己的目录，不进入 DSH 插件列表。
- 目录：`$DSH_HOME/living/{data,workspace,gems}`；旧布局启动时幂等迁移。
- 备份：`VACUUM INTO` 快照导出；导入校验后下次启动替换，替换前自动备份当前库。
- 测试：core 283 / protocol 24 / gem-bili 32 / gem-wechat 27。
