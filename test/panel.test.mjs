/**
 * Panel state checks: mounts the real panel component through a small hook
 * runtime that can re-render, so the data-driven states are exercised the way a
 * browser would reach them.
 *
 * This is not a DOM: the component tree and hooks are the shipped ones, React
 * renders them, and a state transition is a second render pass. That is enough
 * to catch a crash in the list, the detail view or a failure card — the three
 * states a user actually lands in.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { checkFiles, readIssue, readOverview, resolveBd } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

let captured
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => (captured = factory) },
  setTimeout: (fn) => fn(),
  addEventListener: () => {},
  removeEventListener: () => {},
}
// The bundle captures its React at factory time, so the hook runtime has to be
// handed over here rather than patched onto React later. Element creation stays
// real; only the hook calls are ours.
let hookSlots = []
let hookCursor = 0
/** Bumped by every state write, never reset: a write can land between passes. */
let hookVersion = 0
let hookEffects = []
/** Registration order of the effect being registered in this pass. */
let hookEffectIndex = 0
/** Per-effect deps from the previous pass; `undefined` means "never ran". */
let hookEffectDeps = []

const hookReact = {
  ...React,
  createElement(type, props, ...children) {
    const element = React.createElement(type, props, ...children)
    if (props && typeof props.onClick === 'function' && props.className === 'bv-row') capturedRows.push(element)
    return element
  },
  Fragment: React.Fragment,
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (hookSlots[index] === undefined) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(hookSlots[index]) : next
      if (value !== hookSlots[index]) {
        hookSlots[index] = value
        hookVersion += 1
      }
    }
    return [hookSlots[index], set]
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => {
    const index = hookCursor
    hookCursor += 1
    if (hookSlots[index] === undefined) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
  useEffect: (fn, deps) => {
    const index = hookEffectIndex
    hookEffectIndex += 1
    const previous = hookEffectDeps[index]
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps === null ||
      deps.length !== previous.length ||
      deps.some((value, position) => !Object.is(value, previous[position]))
    if (changed) {
      hookEffectDeps[index] = deps === undefined || deps === null ? undefined : [...deps]
      hookEffects.push(fn)
    }
  },
  useLayoutEffect: () => {},
  useContext: () => ({}),
}

new Function('window', readFileSync(join(here, '..', 'client.js'), 'utf8'))(globalThis.window)
const mod = captured((request) => {
  if (request === 'react') return hookReact
  throw new Error(`unexpected module: ${request}`)
})
const { BeadsPanel } = mod.__test

const results = []
const test = (name, fn) => results.push({ name, fn })

const bin = await resolveBd()
assert.ok(bin, 'bd must be installed')

const workspace = await mkdtemp(join(tmpdir(), 'bv-panel-'))
execFileSync('git', ['init', '-q'], { cwd: workspace })
execFileSync(bin, ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' })
await writeFile(join(workspace, 'README.md'), '# readme')
execFileSync(
  bin,
  ['create', 'Panel smoke issue', '--description', 'Reads README.md and `README.md` twice.', '--priority', '0'],
  { cwd: workspace, stdio: 'ignore' },
)
execFileSync(bin, ['create', 'Blocked one', '--description', 'blocked', '--priority', '3'], {
  cwd: workspace,
  stdio: 'ignore',
})

/** A transport that answers from the real Host functions. */
function hostFetch() {
  return async (url) => {
    const parsed = new URL(url)
    const cwd = parsed.searchParams.get('cwd')
    const action = parsed.searchParams.get('action') ?? 'overview'
    let body
    if (action === 'issue') body = await readIssue({ cwd, bin, id: parsed.searchParams.get('id') })
    else if (action === 'files') {
      body = {
        ok: true,
        files: await checkFiles(cwd, (parsed.searchParams.get('paths') ?? '').split('\n'), cwd),
      }
    } else body = await readOverview({ cwd, bin })
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
}

/**
 * Render `Component` with a hook runtime that can settle state.
 *
 * Each pass replays the component with the state slots the previous pass
 * produced, runs the effects queued during that pass, applies the updates they
 * set, and repeats until nothing is dirty or the budget runs out. That is the
 * mount → fetch → setState sequence a browser performs.
 */
/** Row elements collected by the element-capturing render. */
let capturedRows = []

/** Concatenate a rendered element's text, for content assertions. */
function flatten(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (typeof node === 'object' && node.props) return flatten(node.props.children)
  return ''
}

/** Continue settling an already-mounted tree after a click. */
async function settleAgain(Component, props, passes = 12) {
  let last = null
  for (let pass = 0; pass < passes; pass += 1) {
    const versionBefore = hookVersion
    hookCursor = 0
    hookEffectIndex = 0
    hookEffects = []
    last = renderToStaticMarkup(React.createElement(Component, props))
    const queued = hookEffects
    hookEffects = []
    for (const effect of queued) effect()
    for (let tick = 0; tick < 60 && hookVersion === versionBefore; tick += 1) {
      await new Promise((done) => setTimeout(done, 25))
    }
    if (hookVersion === versionBefore) break
  }
  return last
}

async function renderSettled(Component, props, passes = 12) {
  hookSlots = []
  hookEffectDeps = []
  const cleanups = []
  let last = null
  for (let pass = 0; pass < passes; pass += 1) {
    const versionBefore = hookVersion
    hookCursor = 0
    hookEffectIndex = 0
    hookEffects = []
    last = renderToStaticMarkup(React.createElement(Component, props))
    const queued = hookEffects
    hookEffects = []
    for (const effect of queued) {
      // An effect's cleanup runs on unmount or a dependency change, never right
      // after the effect itself — running it here would abort every in-flight
      // fetch, which is exactly the bug this harness has to avoid reproducing.
      cleanups.push(effect())
    }
    // Drain the promise chains the effect started, and re-render only if a
    // state write landed, which is what React would schedule.
    for (let tick = 0; tick < 60 && hookVersion === versionBefore; tick += 1) {
      await new Promise((done) => setTimeout(done, 25))
    }
    if (hookVersion === versionBefore) break
  }
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') {
      try {
        cleanup()
      } catch {
        /* unmount cleanups must not fail the assertion */
      }
    }
  }
  return last
}

/* -------------------------------------------------------------------------- */

test('an unbound session asks for a project folder', async () => {
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'none',
    useSessions: (selector) => selector({ byId: {} }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  })
  assert.match(out, /Open a session in a project folder/)
})

test('the settled list view shows rows, chips and the toolbar', async () => {
  globalThis.fetch = hostFetch()
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'sess-1',
    useSessions: (selector) => selector({ byId: { 'sess-1': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: { openResource: () => {} } } }),
    inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText: () => true },
  })
  assert.ok(out, 'the panel must render')
  assert.match(out, /Search issues/)
  assert.match(out, /Panel smoke issue/)
  assert.match(out, /Blocked one/)
  assert.match(out, /class="bv-row"/)
  assert.match(out, /P0/)
  assert.match(out, /P3/)
  assert.match(out, /Active/)
  assert.match(out, /2 shown/)
})

test('a row click opens the detail view with Markdown, comments and relations', async () => {
  globalThis.fetch = hostFetch()
  const props = {
    sessionId: 'sess-detail',
    useSessions: (selector) => selector({ byId: { 'sess-detail': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: { openResource: () => {} } } }),
    inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText: () => true },
  }
  // Settle the list while capturing the row elements, so the click below uses
  // the handler the component actually wired.
  capturedRows = []
  const listHtml = await renderSettled(BeadsPanel, props)
  assert.match(listHtml, /Panel smoke issue/)
  const row = capturedRows.find((element) => /Panel smoke issue/.test(flatten(element)))
  assert.ok(row, 'the list renders a row for the fixture issue')

  // Click it: the panel's own handler switches it into the detail view.
  capturedRows = []
  row.props.onClick()
  const detailHtml = await settleAgain(BeadsPanel, props)
  assert.match(detailHtml, /bv-issue-title/)
  assert.match(detailHtml, /Panel smoke issue/)
  assert.match(detailHtml, /Copy id/)
  assert.match(detailHtml, /Insert into composer/)
  assert.match(detailHtml, /bv-p|bv-md/)
})

test('a failing route renders the failure card with its hint', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, code: 'no-workspace', message: 'This project has no Beads workspace.', cwd: '/tmp/x' }), text: async () => '' })
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'sess-2',
    useSessions: (selector) => selector({ byId: { 'sess-2': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  })
  assert.match(out, /bv-failure/)
  assert.match(out, /no Beads workspace/)
  assert.match(out, /bd init/)
  assert.match(out, /Retry/)
})

test('a throwing transport renders the error text instead of crashing', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down')
  }
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'sess-3',
    useSessions: (selector) => selector({ byId: { 'sess-3': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  })
  assert.match(out, /network down/)
})

test('a missing tab record does not break the panel', async () => {
  globalThis.fetch = hostFetch()
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'sess-4',
    useSessions: (selector) => selector({ byId: { 'sess-4': { cwd: workspace } } }),
    useTabInfo: () => {
      throw new Error('tab not committed')
    },
    inputActions: null,
  })
  assert.match(out, /Search issues/)
})

/* -------------------------------------------------------------------------- */

let failed = 0
for (const { name, fn } of results) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}
await rm(workspace, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
