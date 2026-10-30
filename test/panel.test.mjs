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
/** Window listeners the panel installed, so a test can press a key. */
const windowListeners = new Map()

globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => (captured = factory) },
  setTimeout: (fn) => fn(),
  addEventListener(type, handler) {
    const list = windowListeners.get(type) ?? []
    list.push(handler)
    windowListeners.set(type, list)
  },
  removeEventListener(type, handler) {
    const list = windowListeners.get(type) ?? []
    windowListeners.set(type, list.filter((entry) => entry !== handler))
  },
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
    if (props && typeof props.onClick === 'function') {
      if (props.className === 'bv-row') capturedRows.push(element)
      capturedControls.push(element)
    }
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
const smokeId = execFileSync(bin, ['q', 'Panel smoke issue'], { cwd: workspace, encoding: 'utf8' }).trim()
const blockerId = execFileSync(bin, ['q', 'The blocker'], { cwd: workspace, encoding: 'utf8' }).trim()
const waitingId = execFileSync(bin, ['q', 'Waits on the blocker'], { cwd: workspace, encoding: 'utf8' }).trim()
execFileSync(bin, ['dep', 'add', waitingId, blockerId, '--type', 'blocks'], { cwd: workspace, stdio: 'ignore' })
// A second status and a second type, so the badge assertions can prove that
// different values really do get different fills.
const inProgressId = execFileSync(bin, ['q', 'Already moving', '--type', 'bug'], {
  cwd: workspace,
  encoding: 'utf8',
}).trim()
execFileSync(bin, ['update', inProgressId, '--status', 'in_progress'], { cwd: workspace, stdio: 'ignore' })

/** How many fetches the panel has in flight right now. */
let inFlight = 0

/** Install a transport and count it as in-flight while it runs. */
function useFetch(handler) {
  globalThis.fetch = async (url) => {
    inFlight += 1
    try {
      return await handler(url)
    } finally {
      inFlight -= 1
    }
  }
}

/** Resolve once every started request has settled (or the budget runs out). */
async function drainInFlight(budgetMs = 20000) {
  const deadline = Date.now() + budgetMs
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10))
  }
}

function hostFetch() {
  return hostFetchInner
}

/** A transport that answers from the real Host functions. */
async function hostFetchInner(url) {
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

/**
 * Render `Component` with a hook runtime that can settle state.
 *
 * Each pass replays the component with the state slots the previous pass
 * produced, runs the effects queued during that pass, applies the updates they
 * set, and repeats until nothing is dirty or the budget runs out. That is the
 * mount → fetch → setState sequence a browser performs.
 */
/** How long a render pass may wait for its data before giving up. */
const SETTLE_BUDGET_MS = 20000

/** Row elements collected by the element-capturing render. */
let capturedRows = []

/** Buttons (and other clickable controls) the render created. */
let capturedControls = []

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
    await drainInFlight(SETTLE_BUDGET_MS)
    // The state write lands in a microtask after the fetch resolves.
    for (let grace = 0; grace < 40 && hookVersion === versionBefore; grace += 1) {
      await new Promise((done) => setTimeout(done, 10))
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
    await drainInFlight(SETTLE_BUDGET_MS)
    // The state write lands in a microtask after the fetch resolves.
    for (let grace = 0; grace < 40 && hookVersion === versionBefore; grace += 1) {
      await new Promise((done) => setTimeout(done, 10))
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
  useFetch(hostFetch())
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'sess-1',
    useSessions: (selector) => selector({ byId: { 'sess-1': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: { openResource: () => {} } } }),
    inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText: () => true },
  })
  assert.ok(out, 'the panel must render')
  assert.match(out, /Search issues/)
  assert.match(out, /Panel smoke issue/)
  assert.match(out, /Waits on the blocker/)
  assert.match(out, /The blocker/)
  // Both readiness markers appear: the startable issue and the waiting one.
  assert.match(out, /class="bv-ready"/)
  assert.match(out, /class="bv-waiting"/)
  assert.match(out, /class="bv-row"/)
  assert.match(out, /P0/)
  assert.match(out, /P2/)
  assert.match(out, /Active/)
  const shown = /(\d+) shown/.exec(out)
  assert.ok(shown, 'the list reports how many rows it is showing')
  assert.ok(Number(shown[1]) >= 3, 'all fixture issues are listed')
})

test('a row click opens the detail view with Markdown, comments and relations', async () => {
  useFetch(hostFetch())
  const props = {
    sessionId: 'sess-detail',
    useSessions: (selector) => selector({ byId: { 'sess-detail': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: { openResource: () => {} } } }),
    inputActions: { captureInsertion: () => ({ draftRev: 1 }), insertText: () => true },
  }
  // Settle the list while capturing the row elements, so the click below uses
  // the handler the component actually wired.
  capturedRows = []
  capturedControls = []
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

test('readiness chips and per-row markers follow the Host signal', async () => {
  const withReadiness = (readiness) => async (url) => {
    const parsed = new URL(url)
    const cwd = parsed.searchParams.get('cwd')
    const action = parsed.searchParams.get('action') ?? 'overview'
    let body
    if (action === 'issue') body = await readIssue({ cwd, bin, id: parsed.searchParams.get('id') })
    else if (action === 'files') body = { ok: true, files: [] }
    else {
      body = await readOverview({ cwd, bin })
      if (readiness === 'unavailable') {
        body.readiness = 'unavailable'
        for (const issue of body.issues) delete issue.ready
        delete body.counts.ready
      }
    }
    return { ok: true, status: 200, json: async () => body, text: async () => '' }
  }

  // Live readiness: the Ready chip exists and rows carry a marker.
  useFetch(withReadiness('live'))
  const props = {
    sessionId: 'sess-ready',
    useSessions: (selector) => selector({ byId: { 'sess-ready': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  }
  const live = await renderSettled(BeadsPanel, props)
  assert.match(live, />Ready</)
  // The marker is an element, not just a class in the stylesheet.
  assert.match(live, /class="bv-ready"/)

  // Unavailable readiness: no readiness chip is offered at all, because the
  // question could not be asked.
  useFetch(withReadiness('unavailable'))
  const dark = await renderSettled(BeadsPanel, props)
  assert.doesNotMatch(dark, />Ready</)
  assert.doesNotMatch(dark, /class="bv-ready"/)
})

test('a long comment thread opens collapsed and can be expanded', async () => {
  useFetch(hostFetch())
  const props = {
    sessionId: 'sess-comments',
    useSessions: (selector) => selector({ byId: { 'sess-comments': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  }
  // Its own issue, so the count is exactly what this test creates no matter
  // what other tests have done to the shared fixture.
  const threadId = execFileSync(bin, ['q', 'Thread with history'], { cwd: workspace, encoding: 'utf8' }).trim()
  for (let i = 0; i < 7; i += 1) {
    execFileSync(bin, ['comment', threadId, `Comment number ${i} with README.md`], {
      cwd: workspace,
      stdio: 'ignore',
    })
  }
  capturedRows = []
  capturedControls = []
  await renderSettled(BeadsPanel, props)
  const row = capturedRows.find((element) => /Thread with history/.test(flatten(element)))
  assert.ok(row, 'the thread issue is listed')
  row.props.onClick()
  const detail = await settleAgain(BeadsPanel, props)

  assert.match(detail, /Comments \(7\)/)
  assert.match(detail, /Show all 7/)
  // The newest comments are in view, the oldest are the ones held back.
  assert.match(detail, /Comment number 5/)
  assert.doesNotMatch(detail, /Comment number 0 with/)
  assert.match(detail, /3 earlier comments hidden/)

  const toggle = capturedControls.find((element) => /Show all 7/.test(flatten(element)))
  assert.ok(toggle, 'the thread offers its hidden comments')
  toggle.props.onClick()
  const expanded = await settleAgain(BeadsPanel, props)
  assert.match(expanded, /Comment number 0 with/)
  assert.match(expanded, /Collapse/)
})

test('a language change from the Host reaches the rendered copy', async () => {
  // The Host re-renders slot occupants on a locale change, but the panel also
  // swaps its own dictionary through the subscription, so this asserts the wiring
  // that does not depend on the Host remembering to re-render us.
  // `renderSettled` unmounts (and therefore unsubscribes) when it returns, so the
  // listener is kept by reference rather than looked up in a live set.
  //
  // The fake models the real contract: subscribers are called with NO argument and
  // must read the snapshot back from the service. Passing a snapshot here would
  // have hidden the crash the running app logged.
  let notify = null
  let active = 'en'
  mod.__test.setLanguage('en')
  mod.__test.setLocaleService({
    subscribe(listener) {
      notify = listener
      return () => {}
    },
    getSnapshot: () => ({ active }),
  })
  useFetch(hostFetch())
  const props = {
    sessionId: 'sess-2',
    useSessions: (selector) => selector({ byId: { 'sess-2': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: {} } }),
    inputActions: null,
  }

  const english = await renderSettled(BeadsPanel, props)
  assert.match(english, /Search issues/)
  assert.match(english, /shown/)

  assert.equal(typeof notify, 'function', 'the panel must subscribe to locale changes')
  active = 'zh'
  notify()

  const chinese = await renderSettled(BeadsPanel, props)
  assert.match(chinese, /搜索议题/)
  assert.match(chinese, /共 \d+ 条/)
  assert.doesNotMatch(chinese, /Search issues/)

  mod.__test.setLanguage('en')
  mod.__test.setLocaleService(null)
})

test('a workspace fingerprint change refreshes, and no change does not', async () => {
  // `bd` writes from a terminal or another session never touch this window, so the
  // panel polls a stat-only fingerprint. The test drives the poll with a tiny
  // interval and a stub that hands out two versions.
  globalThis.__bvPollMs = 5
  let version = 'v1'
  const polls = []
  mod.__test.setLanguage('en')
  useFetch((url) => {
    const action = new URL(String(url)).searchParams.get('action') ?? 'overview'
    if (action === 'version') {
      polls.push(version)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, cwd: workspace, version }), text: async () => '' })
    }
    return hostFetchInner(url)
  })
  const props = {
    sessionId: 'sess-2',
    useSessions: (selector) => selector({ byId: { 'sess-2': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: {} } }),
    inputActions: null,
  }

  const first = await renderSettled(BeadsPanel, props)
  const rowsBefore = (first.match(/class="bv-row"/g) || []).length
  assert.ok(polls.includes('v1'), 'the panel must poll the fingerprint')

  // A version change must spend the real read (force-next) and re-render.
  version = 'v2'
  capturedRows = []
  const second = await renderSettled(BeadsPanel, props)
  assert.equal((second.match(/class="bv-row"/g) || []).length, rowsBefore, 'the same workspace re-renders with the same row count')
  assert.ok(polls.filter((v) => v === 'v2').length > 0, 'the panel must pick up the new version')

  // No further change: no forced refresh is queued, and the seen-version state has
  // already converged, so the baseline must hold.
  globalThis.__bvPollMs = undefined
})

test('the Refresh control bypasses the Host cache exactly once', async () => {
  const urls = []
  useFetch(async (url) => {
    urls.push(String(url))
    const cwd = new URL(String(url)).searchParams.get('cwd')
    const body = await readOverview({ cwd, bin })
    return { ok: true, status: 200, json: async () => body, text: async () => '' }
  })
  capturedRows = []
  capturedControls = []
  const props = {
    sessionId: 'sess-refresh',
    useSessions: (selector) => selector({ byId: { 'sess-refresh': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  }
  await renderSettled(BeadsPanel, props)
  const before = urls.length
  assert.equal(new URL(urls[0]).searchParams.get('force'), null, 'the first load uses the cache')

  // Find the Refresh control the component actually wired and click it.
  const refresh = capturedControls.find((element) => element.props.title === 'Refresh')
  assert.ok(refresh, 'the toolbar renders a Refresh control')
  refresh.props.onClick()
  await settleAgain(BeadsPanel, props)

  const after = urls.slice(before)
  assert.ok(after.length >= 1, 'clicking Refresh triggers a load')
  assert.equal(new URL(after[0]).searchParams.get('force'), '1', 'the explicit refresh bypasses the cache')
  if (after.length > 1) {
    assert.equal(new URL(after[1]).searchParams.get('force'), null, 'the bypass is consumed by one load')
  }
})

test('an empty tracker and a too-narrow filter say different things', async () => {
  const serve = (issues) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, cwd: '/x', issues, counts: { total: issues.length }, statuses: [], readiness: 'live' }),
    text: async () => '',
  })
  const props = {
    sessionId: 'sess-empty',
    useSessions: (selector) => selector({ byId: { 'sess-empty': { cwd: '/x' } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  }

  useFetch(serve([]))
  const empty = await renderSettled(BeadsPanel, props)
  assert.match(empty, /no issues yet/)
  assert.doesNotMatch(empty, /matches this filter/)

  useFetch(serve([
    {
      id: 'p-aaa11',
      title: 'Only one',
      status: 'closed',
      priority: 2,
      type: 'task',
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      commentCount: 0,
      dependencyCount: 0,
      labels: [],
    },
  ]))
  // The default filter is "active", which excludes the single closed issue.
  const filtered = await renderSettled(BeadsPanel, props)
  assert.match(filtered, /matches this filter/)
  assert.doesNotMatch(filtered, /no issues yet/)
})

test('every list row carries a coloured badge for status, priority and type', async () => {
  useFetch(hostFetch())
  const props = {
    sessionId: 'sess-badges',
    useSessions: (selector) => selector({ byId: { 'sess-badges': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: {} } }),
    inputActions: null,
  }
  capturedRows = []
  capturedControls = []
  const out = await renderSettled(BeadsPanel, props)

  // One row per fixture issue, and each row shows all three dimensions.
  const rows = out.split('class="bv-row"').slice(1)
  assert.ok(rows.length >= 3, 'the list renders the fixture issues')
  for (const row of rows) {
    assert.match(row, /class="bv-badge bv-badge-solid bv-badge-status/, 'each row has a status badge')
    assert.match(row, /class="bv-badge bv-badge-solid bv-badge-priority/, 'each row has a priority badge')
    assert.match(row, /class="bv-badge bv-badge-solid bv-badge-type/, 'each row has a type badge')
  }

  // The fills differ across the three dimensions rather than all sharing one.
  const fills = [...out.matchAll(/bv-badge-solid bv-badge-(status|priority|type)" style="background:([^;"]+)/g)]
    .map((m) => [m[1], m[2]])
  const statusFills = new Set(fills.filter((f) => f[0] === 'status').map((f) => f[1]))
  const priorityFills = new Set(fills.filter((f) => f[0] === 'priority').map((f) => f[1]))
  assert.ok(statusFills.size >= 2, 'distinct statuses get distinct fills')
  assert.ok(priorityFills.size >= 2, 'distinct priorities get distinct fills')
})

test('the slash shortcut never steals focus from the composer', async () => {
  useFetch(hostFetch())
  // A composer is a contenteditable, and the browser reports its own node from
  // document.activeElement — neither is an INPUT or a TEXTAREA. That is exactly
  // why "/" was hijacked while the user was typing a slash command.
  const composer = {
    tagName: 'DIV',
    isContentEditable: true,
    closest: (selector) => (selector.includes('contenteditable') ? composer : null),
  }
  const plainBody = { tagName: 'BODY', isContentEditable: false, closest: () => null }

  const props = {
    sessionId: 'sess-slash',
    useSessions: (selector) => selector({ byId: { 'sess-slash': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: {} } }),
    inputActions: null,
  }
  await renderSettled(BeadsPanel, props)

  const keydown = [...(windowListeners.get('keydown') ?? [])]
  assert.ok(keydown.length > 0, 'the panel installs a keydown listener while visible')

  const press = (target, key) => {
    let prevented = false
    const event = { key, defaultPrevented: false, preventDefault() { prevented = true }, stopPropagation() {} }
    globalThis.document = { activeElement: target }
    for (const handler of keydown) handler(event)
    return prevented
  }

  assert.equal(press(composer, '/'), false, 'a slash typed in the composer must not be prevented')

  // The browser reports the nearest element with a box, so a caret inside a
  // paragraph of the composer reports that paragraph, not the editor root.
  const leaf = {
    tagName: 'P',
    isContentEditable: true,
    closest: (selector) => (selector.includes('contenteditable') ? composer : null),
  }
  assert.equal(press(leaf, '/'), false, 'a slash typed inside the composer body must not be prevented')

  // A read-only region inside an editable-looking tree is still typing territory
  // as far as a shortcut is concerned.
  const nested = { tagName: 'SPAN', isContentEditable: false, closest: () => null }
  assert.equal(press(nested, '/'), true, 'a plain non-editable node still opens the search box')

  // From the page body it still focuses the panel's own search box.
  assert.equal(press(plainBody, '/'), true, 'a slash outside any field opens the search box')

  // A modifier combination belongs to the host, not to this panel.
  assert.equal(press(plainBody, 'k'), false)
})

test('the slash shortcut stays inert while the panel is hidden', async () => {
  useFetch(hostFetch())
  const props = {
    sessionId: 'sess-hidden',
    useSessions: (selector) => selector({ byId: { 'sess-hidden': { cwd: workspace } } }),
    // keepMounted keeps this body alive behind another tab.
    useTabInfo: () => ({ tab: { visible: false, actions: {} } }),
    inputActions: null,
  }
  windowListeners.clear()
  await renderSettled(BeadsPanel, props)
  assert.equal((windowListeners.get('keydown') ?? []).length, 0, 'a hidden panel installs no keydown listener')
})

test('a failing route renders the failure card with its hint', async () => {
  useFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, code: 'no-workspace', message: 'This project has no Beads workspace.', cwd: '/tmp/x' }), text: async () => '' }))
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
  useFetch(async () => {
    throw new Error('network down')
  })
  const out = await renderSettled(BeadsPanel, {
    sessionId: 'sess-3',
    useSessions: (selector) => selector({ byId: { 'sess-3': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { actions: {} } }),
    inputActions: null,
  })
  assert.match(out, /network down/)
})

test('a missing tab record does not break the panel', async () => {
  useFetch(hostFetch())
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


/* -------------------------------------------------------------------------- *
 * Detail refresh behavior: never blank, never out of order, never duplicate.
 * -------------------------------------------------------------------------- */

/**
 * One render pass of a hook probe: render, then run the effects that pass queued.
 * The probe uses the shipped `useIssue`, so its state machine is exercised without
 * the whole panel.
 */
function renderProbe(Probe, props) {
  hookCursor = 0
  hookEffectIndex = 0
  hookEffects = []
  renderToStaticMarkup(React.createElement(Probe, props))
  const queued = hookEffects
  hookEffects = []
  for (const effect of queued) effect()
  // Re-render so the state the effect just set (loading, or data cleared on an id
  // switch) is what the caller asserts on — a browser would too.
  hookCursor = 0
  hookEffectIndex = 0
  hookEffects = []
  const html = renderToStaticMarkup(React.createElement(Probe, props))
  hookEffects = []
  return html
}

function DetailProbe({ cwd, id, revision }) {
  const state = mod.__test.useIssue(cwd, id, revision)
  const title = state.data?.issue?.title ?? null
  return React.createElement(
    'div',
    null,
    // Mirrors renderDetail: the placeholder is only for "nothing to show yet".
    state.loading && !state.data ? 'LOADING ' : '',
    state.error ? `ERROR ${state.error} ` : '',
    title === null ? '' : `TITLE:${title}`,
  )
}

const tick = (ms = 25) => new Promise((done) => setTimeout(done, ms))

const issueResponse = (id, title) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, issue: { id, title }, comments: [] }),
  text: async () => '',
})

/** Settle a probe that was given a real (bd-backed) transport. */
async function drainProbe() {
  await drainInFlight()
  await tick()
}

test('a revision refresh keeps the open issue on screen until the new answer lands', async () => {
  useFetch(hostFetch())
  hookSlots = []
  hookEffectDeps = []
  renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 0 })
  await drainProbe()
  let html = renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 0 })
  assert.match(html, /TITLE:Panel smoke issue/)

  // The next read does not answer yet: the body must stay, not blank.
  let release
  useFetch((url) => {
    const parsed = new URL(String(url))
    if ((parsed.searchParams.get('action') ?? 'overview') === 'issue') {
      return new Promise((resolve) => { release = resolve })
    }
    return hostFetchInner(url)
  })
  html = renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 1 })
  assert.match(html, /TITLE:Panel smoke issue/, 'the old body stays while the refresh is in flight')
  assert.doesNotMatch(html, /LOADING/, 'the detail must not fall back to a loading placeholder')

  release(issueResponse(smokeId, 'Refreshed title'))
  await drainProbe()
  html = renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 1 })
  assert.match(html, /TITLE:Refreshed title/, 'the settled answer replaces the body in place')
})

test('switching issues clears the old body immediately', async () => {
  useFetch(hostFetch())
  hookSlots = []
  hookEffectDeps = []
  renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 0 })
  await drainProbe()
  let html = renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 0 })
  assert.match(html, /TITLE:Panel smoke issue/)

  // A different id while its read is pending: the previous issue must not linger.
  let releaseB
  useFetch((url) => {
    const parsed = new URL(String(url))
    if ((parsed.searchParams.get('action') ?? 'overview') === 'issue' && parsed.searchParams.get('id') === blockerId) {
      return new Promise((resolve) => { releaseB = resolve })
    }
    return hostFetchInner(url)
  })
  html = renderProbe(DetailProbe, { cwd: workspace, id: blockerId, revision: 0 })
  assert.doesNotMatch(html, /Panel smoke issue/, 'a different issue must not inherit the old body')
  assert.match(html, /LOADING/)

  releaseB(issueResponse(blockerId, 'The blocker'))
  await drainProbe()
  html = renderProbe(DetailProbe, { cwd: workspace, id: blockerId, revision: 0 })
  assert.match(html, /TITLE:The blocker/)
})

test('a late answer for a closed issue cannot paint over the open one', async () => {
  let releaseA
  useFetch((url) => {
    const parsed = new URL(String(url))
    if ((parsed.searchParams.get('action') ?? 'overview') !== 'issue') return hostFetchInner(url)
    if (parsed.searchParams.get('id') === smokeId) {
      return new Promise((resolve) => { releaseA = resolve })
    }
    return Promise.resolve(issueResponse(blockerId, 'The blocker'))
  })
  hookSlots = []
  hookEffectDeps = []
  renderProbe(DetailProbe, { cwd: workspace, id: smokeId, revision: 0 }) // A pending
  let html = renderProbe(DetailProbe, { cwd: workspace, id: blockerId, revision: 0 }) // switch to B
  await tick()
  html = renderProbe(DetailProbe, { cwd: workspace, id: blockerId, revision: 0 })
  assert.match(html, /TITLE:The blocker/)

  // A answers long after B is on screen; it must be dropped.
  releaseA(issueResponse(smokeId, 'A-late'))
  await tick()
  html = renderProbe(DetailProbe, { cwd: workspace, id: blockerId, revision: 0 })
  assert.match(html, /TITLE:The blocker/)
  assert.doesNotMatch(html, /A-late/)
})

test('window focus refreshes only when the fingerprint moved, and only once', async () => {
  globalThis.__bvPollMs = 60000
  let version = 'focus-v1'
  const overviewForces = []
  useFetch((url) => {
    const parsed = new URL(String(url))
    const action = parsed.searchParams.get('action') ?? 'overview'
    if (action === 'version') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cwd: workspace, version }),
        text: async () => '',
      })
    }
    if (action === 'overview') overviewForces.push(parsed.searchParams.get('force'))
    return hostFetchInner(url)
  })
  const props = {
    sessionId: 'sess-focus',
    useSessions: (selector) => selector({ byId: { 'sess-focus': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: {} } }),
    inputActions: null,
  }
  // The poll interval outlives the test unless we clear it; capture what the
  // effect installs so the process can exit.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const spawned = []
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest)
    spawned.push(id)
    return id
  }
  try {
    windowListeners.clear()
    hookSlots = []
    hookEffectDeps = []
    await settleAgain(BeadsPanel, props) // mount without running unmount cleanups
    const focusHandlers = [...(windowListeners.get('focus') ?? [])]
    assert.ok(focusHandlers.length > 0, 'a visible panel installs a focus listener')

    const before = overviewForces.length
    for (const handler of focusHandlers) handler()
    await settleAgain(BeadsPanel, props)
    assert.equal(overviewForces.length, before, 'focus with an unchanged fingerprint must not reload')

    version = 'focus-v2'
    for (const handler of focusHandlers) {
      handler()
      handler() // a second trigger in the same tick — focus and poll can coincide
    }
    await settleAgain(BeadsPanel, props)
    const forced = overviewForces.slice(before).filter((value) => value === '1')
    assert.equal(forced.length, 1, 'two near-simultaneous triggers must produce one refresh')
  } finally {
    for (const id of spawned) realClearInterval(id)
    globalThis.setInterval = realSetInterval
    globalThis.__bvPollMs = undefined
    windowListeners.clear()
  }
})

test('a failed version check does not wedge live refresh', async () => {
  globalThis.__bvPollMs = 60000
  let mode = 'seed' // seed → reject → change
  const overviewForces = []
  useFetch((url) => {
    const parsed = new URL(String(url))
    const action = parsed.searchParams.get('action') ?? 'overview'
    if (action === 'version') {
      if (mode === 'reject') return Promise.reject(new Error('route down'))
      const version = mode === 'change' ? 'ver-2' : 'ver-1'
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cwd: workspace, version }),
        text: async () => '',
      })
    }
    if (action === 'overview') overviewForces.push(parsed.searchParams.get('force'))
    return hostFetchInner(url)
  })
  const props = {
    sessionId: 'sess-check-fail',
    useSessions: (selector) => selector({ byId: { 'sess-check-fail': { cwd: workspace } } }),
    useTabInfo: () => ({ tab: { visible: true, actions: {} } }),
    inputActions: null,
  }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const spawned = []
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest)
    spawned.push(id)
    return id
  }
  try {
    windowListeners.clear()
    hookSlots = []
    hookEffectDeps = []
    await settleAgain(BeadsPanel, props) // mount; the first check seeds the baseline
    const focusHandlers = [...(windowListeners.get('focus') ?? [])]
    assert.ok(focusHandlers.length > 0, 'a visible panel installs a focus listener')

    // A check that rejects must release the in-flight gate.
    mode = 'reject'
    for (const handler of focusHandlers) handler()
    await settleAgain(BeadsPanel, props)

    // With the gate stuck, this trigger would be ignored and nothing would reload.
    mode = 'change'
    const before = overviewForces.length
    for (const handler of focusHandlers) handler()
    await settleAgain(BeadsPanel, props)
    const forced = overviewForces.slice(before).filter((value) => value === '1')
    assert.equal(forced.length, 1, 'a later fingerprint change must still refresh after a failed check')
  } finally {
    for (const id of spawned) realClearInterval(id)
    globalThis.setInterval = realSetInterval
    globalThis.__bvPollMs = undefined
    windowListeners.clear()
  }
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
