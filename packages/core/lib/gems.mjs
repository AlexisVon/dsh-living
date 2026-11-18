/** WorldGem loading: manifest validation, skill injection, MCP declarations. */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { validateWorldGem } from 'dsh-living-protocol'

export function loadGem(dir, { readFile = readFileSync } = {}) {
  const root = resolve(dir)
  const manifestPath = join(root, 'worldgem.json')
  if (!existsSync(manifestPath)) throw new RangeError(`找不到 worldgem.json: ${manifestPath}`)

  let manifest
  try {
    manifest = JSON.parse(readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new RangeError(`worldgem.json 解析失败 (${manifestPath}): ${error.message}`)
  }

  const result = validateWorldGem(manifest)
  if (!result.ok) {
    const error = new RangeError(
      `宝石清单不合法 (${root}): ${result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')}`,
    )
    error.errors = result.errors
    throw error
  }

  let skill = ''
  if (manifest.skill) {
    const skillPath = resolve(root, manifest.skill)
    if (!skillPath.startsWith(root + sep)) throw new RangeError(`skill 路径越界: ${manifest.skill}`)
    if (!existsSync(skillPath)) throw new RangeError(`skill 文件不存在: ${skillPath}`)
    skill = readFile(skillPath, 'utf8')
  }

  return { dir: root, manifest, skill }
}

export function loadGems(dirs) {
  return dirs.map((dir) => loadGem(dir))
}

/** Skill + limits + etiquette + failure hints, for the stable prompt prefix. */
export function buildSkillSection(gems, { maxChars = 6000 } = {}) {
  const parts = []
  for (const gem of gems) {
    const m = gem.manifest
    const lines = [`### 宝石 ${m.id}（${m.name} v${m.version}）`]
    if (m.description) lines.push(m.description)
    if (gem.skill) lines.push(gem.skill.trim())
    if (m.capabilities) lines.push(`能力：${Object.entries(m.capabilities).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    if (m.limits) lines.push(`限制：${Object.entries(m.limits).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    if (m.etiquette?.length) lines.push(`礼仪：\n${m.etiquette.map((line) => `- ${line}`).join('\n')}`)
    if (m.failure_hints) {
      lines.push(`失败语义：\n${Object.entries(m.failure_hints).map(([code, text]) => `- ${code}: ${text}`).join('\n')}`)
    }
    parts.push(lines.join('\n'))
  }
  const text = parts.join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

export function gemToolNames(gems) {
  return gems.flatMap((gem) => gem.manifest.mcp?.tools ?? [])
}

/** Mount each gem's MCP server inside the living preset, scoped to its own directory. */
export function gemPresetPlugins(gems) {
  return gems
    .filter((gem) => gem.manifest.mcp)
    .map((gem) => ({
      id: `gem-mcp-${gem.manifest.id}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'stdio',
        serverName: gem.manifest.id,
        command: gem.manifest.mcp.command,
        args: gem.manifest.mcp.args ?? [],
        env: gem.manifest.mcp.env ?? {},
        cwd: gem.dir,
        failOnStartupError: false,
      },
    }))
}

export function gemTokens(gems, tokens = {}) {
  const out = {}
  for (const gem of gems) {
    const id = gem.manifest.id
    if (typeof tokens[id] === 'string' && tokens[id] !== '') out[id] = tokens[id]
  }
  return out
}

export function gemLimits(gems) {
  const out = {}
  for (const gem of gems) out[gem.manifest.id] = gem.manifest.limits ?? {}
  return out
}

export const NOTIFY_DEFAULTS = Object.freeze({
  mode: 'ring',
  budget: Object.freeze({ limit: true, count: true }),
})

function normalizeNotifyPolicy(policy = {}) {
  return {
    mode: policy.mode ?? NOTIFY_DEFAULTS.mode,
    budget: {
      limit: policy.budget?.limit ?? NOTIFY_DEFAULTS.budget.limit,
      count: policy.budget?.count ?? NOTIFY_DEFAULTS.budget.count,
    },
  }
}

const DEFAULT_NOTIFY = Object.freeze({
  push: Object.freeze(normalizeNotifyPolicy()),
  trusted: Object.freeze(normalizeNotifyPolicy()),
})

/** Per-gem notification policy; `trusted` inherits `push` field by field. */
export function gemNotifyPolicies(gems) {
  const out = {}
  for (const gem of gems) {
    const notify = gem.manifest.notify ?? {}
    const push = normalizeNotifyPolicy(notify.push)
    const trusted = notify.trusted === undefined
      ? push
      : {
          mode: notify.trusted.mode ?? push.mode,
          budget: {
            limit: notify.trusted.budget?.limit ?? push.budget.limit,
            count: notify.trusted.budget?.count ?? push.budget.count,
          },
        }
    out[gem.manifest.id] = { push, trusted }
  }
  return out
}

export function notifyPolicyFor(policies, gem, trusted = false) {
  const entry = policies?.[gem] ?? DEFAULT_NOTIFY
  return trusted ? entry.trusted : entry.push
}
