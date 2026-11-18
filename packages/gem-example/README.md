# dsh-gem-example

一颗**参考宝石**：把三件套摆齐，什么也不做。抄它来写自己的宝石。

> 状态：三件套已就位。`mcp/server.js` 是无工具的最小 MCP server，`channel/poll.mjs` 是 outbox 轮询参考。

```
worldgem.json     清单：声明你有哪几件
mcp/server.js     ① 能力（空壳 MCP server）
channel/poll.mjs  ② 事件（outbox 轮询参考）
skill/SKILL.md    ③ 给模型的说明：能做什么、不能做什么、礼仪
```

## 三件都不强制

| 类型 | MCP | 事件 | skill | 例子 |
|---|---|---|---|---|
| 纯能力 | ✅ | ❌ | ✅ | 搜索、字幕 |
| 纯事件 | ❌ | ✅ | ✅ | 网页哨兵（只推变化） |
| 完整 | ✅ | ✅ | ✅ | B站、微信 |

## 写一颗宝石的步骤

1. 建包，`worldgem.json` 填 `id` / `name` / `version`
2. 有工具就写 `mcp/server.js`，把工具名写进 `mcp.tools`
3. 能收发消息就实现 `channel/`，填 `event.protocol`
4. 写 `skill/SKILL.md`——**这一步最容易漏，但漏了模型就是瞎的**
5. 把限制（字数、频率、可见性、礼仪）全部写进清单，别写在 skill 里

## skill 必须写什么

| 必写 | 不写会怎样 |
|---|---|
| 能力边界（能发图？能发语音？） | 发了渲染不出来的东西，静默丢弃 |
| 频率与窗口限制 | 一口气发 15 条，后 5 条卡在队列 |
| 礼仪（什么时候不该说话） | 半夜主动汇报，发不出去还以为成功 |
| 失败语义 | 失败就无脑重试，越试越糟 |
