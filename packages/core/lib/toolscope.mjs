/**
 * 工具面策略（软屏蔽）。
 *
 * 不调用 tools.restrict()，只把禁用清单写进轮次提示，由模型自律。
 * 起因见 docs/R9-OPEN-ISSUES.md G-1：结构收口会把 agent 自己的 living_* 一起摘掉，
 * 结果是"能收消息、不能回"。用户决定：一律软屏蔽。
 *
 * 规则写法：`toolDenyJson` 是字符串数组，每条形如
 *   "mnemon_*"          → 前缀
 *   "working_directory" → 精确名字（这里只用于生成文案，不做匹配）
 */

/** 开箱默认：profile 级工具族 + MCP 资源三件套 + 侧栏操作。 */
export const DEFAULT_DENY_RULES = Object.freeze([
  'mnemon_*',
  'mcp__codebase__*',
  'working_directory',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'sidebar_open',
])

/** 解析规则数组；非法项静默跳过（配置错误不该让整轮崩掉）。 */
export function parseDenyRules(entries) {
  if (!Array.isArray(entries)) return []
  const rules = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text === '') continue
    if (text.endsWith('*')) {
      const prefix = text.slice(0, -1)
      if (prefix !== '') rules.push({ kind: 'prefix', value: prefix })
    } else {
      rules.push({ kind: 'exact', value: text })
    }
  }
  return rules
}

/** 由规则生成轮次提示里的软屏蔽段；没有规则时返回空串。 */
export function softBanNotice(rules = []) {
  if (!Array.isArray(rules) || rules.length === 0) return ''
  const listed = rules.map((rule) => (rule.kind === 'prefix' ? `${rule.value}*` : rule.value)).join('、')
  return [
    '## 本轮不要使用的工具',
    listed,
    '这些是 profile 级工具（记忆、代码索引、执行器等），不在你的职责范围内：'
      + '记忆只由 living_* 管理，代码索引与执行不该由你碰。不要调用它们，也不要在回答里假装调用过。',
  ].join('\n')
}
