# Changelog

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
