# Changelog

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
