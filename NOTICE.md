# NOTICE

`packages/core` 与 `packages/protocol` 不含第三方源代码。

`packages/gem-bili` 与 `packages/gem-wechat` 各包含一份第三方源代码：

| 文件 | 项目 | 版权 | 许可 |
|---|---|---|---|
| `lib/vendor/qrcode.mjs` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | Copyright (c) 2009 Kazuhiko Arase | MIT |

完整许可原文在对应包的 `LICENSES/qrcode-generator.MIT.txt`，并已写进该包的 `files`。

设计上借鉴了以下项目的公开思路——版权保护表达、不保护思想与算法，因此未复制任何代码：

| 项目 | 借鉴内容 |
|---|---|
| `dsh-life` 1.0.0 | L1–L6 记忆层与半衰期取值、R1–R8 想起通道的划法、惰性衰减公式、「没有通道命中不许浮现」 |
| `dsh-anima` 2.2.3 | 待审缓冲区的状态机结构 |
| `dsh-memory` 0.1.0 | SQLite FTS5 存储布局、提示段召回思路 |

## 规则

若将来引入任何第三方代码（而非仅借鉴思路），必须：

1. 在 `LICENSES/` 保留原许可原文，文件名形如 `LICENSES/<package>.MIT.txt`
2. 在本文件登记来源包名、版本、用途与原始版权行
3. 把 `LICENSES/` **显式写进受影响包的 `files` 字段**——npm 只自动打包包根目录的 `LICENSE`，嵌套的许可文本不会自动带上
