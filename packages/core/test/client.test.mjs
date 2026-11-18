import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** Load client.js the way the browser module loader does and return its exports. */
function loadClient() {
  let plugin = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    createContext: (value) => ({ Provider: 'provider', value }),
  }
  const component = (name) => function Primitive() { return { type: name } }
  const primitives = Object.fromEntries(
    [
      'Button', 'Input', 'Switch', 'SegmentedTabs', 'Pill', 'Modal', 'Toast', 'PathLabel',
      'MarkdownText', 'JsonBlock', 'IconRefreshOutlineRegular', 'IconSparkleRegular',
      'IconPlusOutlineRegular', 'IconSearchOutlineRegular', 'IconPlayOutlineRegular',
      'IconInfoOutlineRegular', 'IconWarningOutlineRegular',
    ].map((name) => [name, component(name)]),
  )
  const window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        plugin = factory((name) => {
          if (name === 'react') return React
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window, console })
  assert.ok(plugin, 'client.js 必须通过 ModuleLoader 注册')
  return plugin
}

test('控制页注册为主面板 + 左侧栏图标，不再挂在设置子页', () => {
  const plugin = loadClient()
  const injections = []
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: null }) } },
    configForms: { get: (id) => ({ id }) },
    slots: {
      inject: (name, factory) => {
        injections.push({ name, factory })
      },
      register: (options, component) => ({ options, component }),
    },
  }

  plugin.apply(ctx)
  assert.deepEqual(injections.map((entry) => entry.name), ['main', 'sidebar.panellist'])

  const main = injections[0].factory()
  assert.equal(main.options.key, 'living')
  assert.equal(main.options.inject().configForm.id, 'living')
  assert.equal(typeof main.component, 'function')

  const entry = injections[1].factory()
  assert.equal(entry.options.id, 'living')
  assert.equal(entry.options.label(), 'Living')
  assert.equal(typeof entry.component, 'function')
})
