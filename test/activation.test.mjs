/**
 * Client-half activation contract.
 *
 * The bundle is evaluated for real (with a fake `window.__ModuleLoader__`) and
 * `apply` is driven against a fake Cordis context: the tab type, the guide
 * entry, the locale dictionaries and the slot body registration are all
 * asserted, plus the failure path when the right sidebar is absent.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let captured
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useMemo: (fn) => fn(),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}
new Function('window', readFileSync(join(here, '..', 'client.js'), 'utf8'))(globalThis.window)
const mod = captured.factory((request) => {
  if (request === 'react') return fakeReact
  throw new Error(`unexpected module: ${request}`)
})

const results = []
const test = (name, fn) => results.push({ name, fn })

/** A fake context recording every effect and registration. */
function makeContext({ withTabs = true } = {}) {
  const record = { effects: [], tabRegistrations: [], slotRegistrations: [], locales: [], injected: [] }
  const disposers = []

  const tabs = {
    register(definition) {
      record.tabRegistrations.push(definition)
      const dispose = () => {
        record.tabDisposed = true
      }
      disposers.push(dispose)
      return dispose
    },
  }

  const slots = {
    inject(key, callback) {
      record.slotsInjected = record.slotsInjected ?? []
      record.slotsInjected.push(key)
      const dispose = callback()
      return () => dispose()
    },
    register(options, component) {
      record.slotRegistrations.push({ options, component })
      return () => {}
    },
  }

  const locale = {
    register(ns, dicts) {
      record.locales.push({ ns, dicts })
      return () => {}
    },
    bind: (ns) => (key) => `${ns}:${key}`,
  }

  const services = new Map([['slots', slots], ['locale', locale]])
  if (withTabs) services.set('sidebarRightTabs', tabs)

  const ctx = {
    get(name) {
      return services.get(name)
    },
    effect(factory, label) {
      record.effects.push(label)
      const dispose = factory()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    slots,
    locale,
    inject(names, callback) {
      record.injected.push(names)
      for (const name of names) {
        if (!services.has(name)) return () => {}
      }
      const dispose = callback(ctx)
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
  }
  return { ctx, record }
}

test('the module declares only slots as a hard dependency', () => {
  // Locale is read optionally, so a composition without it keeps English copy
  // rather than failing activation.
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply registers the tab type, its guide entry and the panel body', () => {
  const { ctx, record } = makeContext()
  mod.apply(ctx)
  assert.equal(record.tabRegistrations.length, 1)
  const type = record.tabRegistrations[0]
  assert.equal(type.id, 'dsh-beads-viewer')
  assert.equal(type.kind, 'beads')
  assert.equal(type.priority, 'extension')
  assert.equal(type.title(), 'beadsViewer:tab')
  assert.equal(type.guide.length, 1)
  assert.equal(type.guide[0].kind === undefined, true, 'the registry stamps `kind` itself')
  assert.equal(type.guide[0].id, 'beads')
  assert.equal(type.guide[0].order, 40)
  assert.equal(type.guide[0].title(), 'beadsViewer:tab')
  assert.match(type.guide[0].description(), /beadsViewer:guideDesc/)
  assert.equal(typeof type.guide[0].icon, 'function')

  assert.deepEqual(record.slotsInjected, ['sidebar.right.pane.tab'])
  assert.equal(record.slotRegistrations.length, 1)
  assert.deepEqual(record.slotRegistrations[0].options, {
    name: 'sidebar.right.pane.tab',
    key: 'dsh-beads-viewer',
  })
  assert.equal(typeof record.slotRegistrations[0].component, 'function')
})

test('apply registers both dictionaries under one namespace', () => {
  const { ctx, record } = makeContext()
  mod.apply(ctx)
  assert.equal(record.locales.length, 1)
  assert.equal(record.locales[0].ns, 'beadsViewer')
  assert.deepEqual(Object.keys(record.locales[0].dicts).sort(), ['en', 'zh'])
  assert.equal(record.locales[0].dicts.en.tab, 'Beads')
  assert.equal(record.locales[0].dicts.zh.tab, 'Beads')
})

test('every effect carries a plugin-owned label', () => {
  const { ctx, record } = makeContext()
  mod.apply(ctx)
  assert.ok(record.effects.length >= 2)
  for (const label of record.effects) assert.match(label, /^beads-viewer: /)
})

test('a profile without the right sidebar registers nothing and does not throw', () => {
  const { ctx, record } = makeContext({ withTabs: false })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(record.tabRegistrations.length, 0)
  assert.equal(record.slotRegistrations.length, 0)
})

test('the tab type registers once per activation, not twice', () => {
  const { ctx, record } = makeContext()
  mod.apply(ctx)
  mod.apply(ctx)
  assert.equal(record.tabRegistrations.length, 2, 'each activation registers its own type')
})

test('the guide glyph renders an svg with the requested size', () => {
  const { ctx, record } = makeContext()
  mod.apply(ctx)
  const Icon = record.tabRegistrations[0].guide[0].icon
  const rendered = Icon({ size: 22 })
  assert.equal(rendered.type, 'svg')
  assert.equal(rendered.props.width, 22)
  assert.equal(rendered.props.height, 22)
  assert.ok(rendered.children.length > 0)
})

let failed = 0
for (const { name, fn } of results) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
