# R15 · 上下文保险、rest 与 handoff

2026-11-18 · 替代午睡机制；`roundTokens` 从“单轮 token 上限”改为“上下文保险”。

## 1. 触发

- 只看**最后一次模型调用**的 `input + cacheRead + output`（`totalTokens` 优先），不累加整轮。
- 阈值是模型上下文 1M 的 50%–80%，默认 70% = 700k；配置项仍是 `roundTokens`，UI 用 50/60/70/80 四档。
- 超限时 `waitForTurn` cancel，结果 `outcome=error, errorCode=context_guard`。

## 2. rest 流程

1. 本轮正常记账（tokens 仍计入日预算），anchor 记 `error/context_guard`。
2. **handoff**：同一会话追加一次短模型调用，提示见 `HANDOFF_PROMPT`；输出上限 2000 字符。
   - 硬顶 `roundTokens × 1.2`，不再受 70% 保险影响。
   - 计入日预算；日预算已 HOLD 时跳过。
   - 失败写 `session_handoff_failed`，不阻塞 rest。
3. 成功写 `session.handoff = { text, fromSessionId, at }`，写 `session_handoff` 事件。
4. `consolidate('rest')`：episodes 聚类 → 换会话；不做降级、人格、日报。
5. 写 `context_guard` 事件。

## 3. handoff 的生命周期

- **不是记忆**：不写 episodes、facts、facets；不进 L0 召回。
- 新会话首轮注入一次（`## 上一段会话交接`），注入时清除。
- 24h 过期自动丢弃。
- 会话中途失败不会重复注入；桥只负责跨会话那一下。

## 4. 午睡移除

- 删除 `napAtMinutes / napWindowMinutes / napSkipBelowEvents / napDurationMinutes / napDay`。
- `lastNapAt` → `lastConsolidationAt`；旧 life.db 在加载时迁移。
- 13:00 只保留为标题“上午/下午”的边界，不再触发睡眠。
- `living_sleep` 工具已移除：睡眠只由 03:30 调度触发，模型不能手动 sleep。
- 人格模式 `off/night`；旧 `all` 按 `night` 处理。

## 5. 夜睡保留

夜睡仍做：episodes、降级到冷区、人格演化、换会话、日报。睡眠本身不由上下文余量触发。

## 6. 配置与 UI

- `roundTokens`：500000–800000，默认 700000。
- 配置页“上下文保险”卡片：50/60/70/80% 四档，显示当前绝对 token 数。
- `snapshot().budget.limits.roundTokens` 保留原名，语义为上下文保险。

## 7. 测试

- `waitForTurn` 只看最后一次调用；整轮累加超限但单次未超时不取消。
- context guard → handoff → rest → rotate；handoff 失败仍 rotate。
- 新会话 handoff 只注入一次。
- clock 不再有 nap 分支；13:00 不是睡眠边界。
