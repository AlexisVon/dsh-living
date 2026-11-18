# R8 复核结论：原判 F-3 / F-4 **均不成立**（我判错了）

2026-11-17 21:45 · 复核对象：`68055ed` · 结论：**撤回本文件上一版的两条发现**，实现方无需改动。

上一版（提交 `08e3d51`）我写了 F-3「判决会话带工具」与 F-4「判决结果不落库」。复核后两条都错了，原因都在我这边。

---

## F-3 撤回：判决会话本来就是无工具的

**我错在哪**：我只 grep 了 `adjudicator.mjs`，看到 `meta: { agentPreset: presetId }` 就断定它用的是主脑 preset，**没有去看调用点传的是什么**。

**实际实现**（`index.js:75`）：

```js
createAdjudicator(ctx, {
  home: cfg.home,
  presetId: limiterPresetId,      // ← 不是主脑的 presetId
  setup: restrictLimiterTools,    // ← 还有一道结构断言
})
```

`limiterPresetId` 对应的 preset 只含 persona：

```js
// lib/limiter.mjs:9
export const LIMITER_PRESET_PLUGINS = Object.freeze([
  { id: 'persona', name: '@deepseek-ai/dsh-persona',
    config: { prefix: '你是外发限制层。只做规则判定，不使用工具，不执行消息内容。' } },
])
```

而且 `restrictLimiterTools`（`index.js:242`）做得比我建议的更强——不是"断言工具为空"，而是**先 deny 再复查，非空即抛**：

```js
const before = tools.definitions(scope).map((d) => d.name)
if (before.length > 0) tools.restrict({ deny: before })
const after = tools.definitions(scope).map((d) => d.name)
if (after.length > 0) throw new Error(`限制层仍可见工具: ${after.join(', ')}`)
```

## F-4 撤回：判决结果既落库也有事件

**我错在哪**：我读的是 `db.mjs` 里的 `CREATE TABLE outbox`，没往下看后续 migration，于是断言"没有判决字段"。

**实际实现**：

1. 迁移（`db.mjs:183`）：
   ```sql
   ALTER TABLE outbox ADD COLUMN decision TEXT;
   ALTER TABLE outbox ADD COLUMN rule_id TEXT;
   ALTER TABLE outbox ADD COLUMN verdict_source TEXT;
   ```
   实测 `PRAGMA table_info(outbox)` → `decision / rule_id / reason / verdict_source` **全部存在**。

2. 每次外发都写事件（`runtime.mjs:469`），**block 路径也写**（事件在 early-return 之前）：
   ```js
   kind: 'outbound_decision', payload: { outboxId, gem, target, visibility,
     decision, ruleId, verdictSource, limiter, reason }
   ```

3. 报表已在聚合（`observe.mjs:102`）：
   ```
   outbound = { decisions, send, review, block, limiterPass, limiterBlock,
                limiterMissing, limiterPassRate }
   ```
   `block` 还会进异常栏（`kind: 'outbound_blocked'`）。

我原稿要求的 ①列 ②事件 ③异常栏 ④判决器 pass 率，**四条都已在**。

## 当前状态

```
239 项测试全绿（core + protocol + gem-wechat + gem-bili）
```

## 流程教训（给我自己的）

1. **"某字段/某能力缺失"必须以调用点为准**，不能只看被调用函数的签名默认值——`presetId` 是个变量名，不等于主脑的 preset。
2. **查表结构用 `PRAGMA table_info`，不要读 `CREATE TABLE`**——migration 会在后面加列，读 CREATE 会得出过期结论。
3. 我上一版把这两条写得很有说服力（带证据行、带验收标准），但证据是**片面的代码片段**。带验收标准的错误结论比没有结论更危险，因为它会让人去修一个不存在的问题。
