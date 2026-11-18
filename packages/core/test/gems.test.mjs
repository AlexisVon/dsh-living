import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGem, loadGems, buildSkillSection, gemToolNames, gemPresetPlugins } from '../lib/gems.mjs'

function makeGem(t, manifest = {}, skill = '# 说明\n\n只做示例。') {
  const dir = mkdtempSync(join(tmpdir(), 'living-gem-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const full = {
    id: 'demo',
    name: '示例',
    version: '0.1.0',
    skill: 'skill/SKILL.md',
    mcp: { command: 'node', args: ['mcp/server.js'], tools: ['demo_ping'] },
    event: { protocol: ['ingest', 'outbox', 'ack'], visibility: 'private' },
    capabilities: { text: true, voice: false },
    limits: { maxChars: 100, perMinute: 5 },
    etiquette: ['不对外发言'],
    failure_hints: { gem_unavailable: '不可用' },
    ...manifest,
  }
  writeFileSync(join(dir, 'worldgem.json'), JSON.stringify(full), 'utf8')
  if (skill !== null) {
    mkdirSync(join(dir, 'skill'), { recursive: true })
    writeFileSync(join(dir, 'skill', 'SKILL.md'), skill, 'utf8')
  }
  return dir
}

test('加载合法宝石：清单、skill、MCP 声明', (t) => {
  const dir = makeGem(t)
  const gem = loadGem(dir)
  assert.equal(gem.manifest.id, 'demo')
  assert.ok(gem.skill.includes('只做示例'))
  assert.deepEqual(gemToolNames([gem]), ['demo_ping'])
  const [plugin] = gemPresetPlugins([gem])
  assert.equal(plugin.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(plugin.config.serverName, 'demo')
  assert.equal(plugin.config.cwd, gem.dir)
  assert.deepEqual(plugin.config.args, ['mcp/server.js'])
})

test('skill 段包含能力、限制、礼仪、失败语义', (t) => {
  const gem = loadGem(makeGem(t))
  const section = buildSkillSection([gem])
  assert.ok(section.includes('text=true'))
  assert.ok(section.includes('perMinute=5'))
  assert.ok(section.includes('不对外发言'))
  assert.ok(section.includes('gem_unavailable: 不可用'))
})

test('清单不合法 → 抛错并带 errors', (t) => {
  const dir = makeGem(t, { name: '' })
  assert.throws(
    () => loadGem(dir),
    (error) => error instanceof RangeError && Array.isArray(error.errors),
  )
})

test('skill 缺失或越界 → 大声失败', (t) => {
  const missing = makeGem(t, {}, null)
  assert.throws(() => loadGem(missing), RangeError)

  const escape = makeGem(t, { skill: '../outside.md' })
  assert.throws(() => loadGem(escape), /越界/)
})

test('仓库里的宝石声明了 channel 入口', () => {
  for (const id of ['gem-wechat', 'gem-bili']) {
    const gem = loadGem(fileURLToPath(new URL(`../../${id}/`, import.meta.url)))
    assert.equal(gem.manifest.channel.command, 'node', `${id} 缺少 channel.command`)
    assert.deepEqual(gem.manifest.channel.args, ['channel/run.mjs'], `${id} 的 channel 入口不对`)
  }
})

test('多颗宝石按输入顺序加载', (t) => {
  const a = loadGem(makeGem(t, { id: 'a1' }))
  const b = loadGem(makeGem(t, { id: 'b1' }))
  assert.deepEqual(loadGems([a.dir, b.dir]).map((g) => g.manifest.id), ['a1', 'b1'])
})

test('仓库自带示例宝石可加载', () => {
  const dir = fileURLToPath(new URL('../../gem-example/', import.meta.url))
  const gem = loadGem(dir)
  assert.equal(gem.manifest.id, 'example')
  assert.ok(gem.skill.includes('示例宝石'))
})

test('仓库自带 B站 / 微信宝石清单合法', () => {
  const bili = loadGem(fileURLToPath(new URL('../../gem-bili/', import.meta.url)))
  const wechat = loadGem(fileURLToPath(new URL('../../gem-wechat/', import.meta.url)))
  assert.equal(bili.manifest.id, 'bili')
  assert.equal(wechat.manifest.id, 'wechat')
  assert.ok(bili.skill.includes('回复目标'))
  assert.ok(wechat.skill.includes('24 小时窗口'))
})
