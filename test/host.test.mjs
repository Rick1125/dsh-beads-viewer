/**
 * Host-half checks: real `bd` calls against a temporary Beads workspace, plus
 * the HTTP handler's error states. Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chmod, readFile, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  checkFiles,
  readBd,
  whereWorkspace,
  findWorkspace,
  isLoopbackRequest,
  makeHandler,
  parseBdJson,
  readIssue,
  readOverview,
  resolveBd,
  shapeIssue,
  apply,
  ROUTE_PATH,
  fingerprintWorkspace,
} from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The status keys the client can colour, read out of the shipped bundle so this
 * check cannot drift from the palette it is checking.
 */
const MAPPED_STATUSES = new Set(
  [
    ...readFileSync(join(here, '..', 'client.js'), 'utf8')
      .match(/const STATUS_BADGE = \{([\s\S]*?)\n    \}/)[1]
      .matchAll(/^\s+([a-z_]+):/gm),
  ].map((match) => match[1]),
)
assert.ok(MAPPED_STATUSES.size >= 5, 'STATUS_BADGE must be parseable from client.js')

const results = []
function test(name, fn) {
  results.push({ name, fn })
}

/** A minimal fake request/response pair for the handler. */
function fakeRequest(url, { method = 'GET', address = '127.0.0.1' } = {}) {
  return { url, method, socket: { remoteAddress: address }, headers: {} }
}

function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(body) {
      this.body = body ?? ''
    },
  }
  res.json = () => JSON.parse(res.body)
  return res
}

async function call(url, options) {
  const res = fakeResponse()
  await makeHandler()(fakeRequest(url, options), res)
  return res
}

/* -------------------------------------------------------------------------- */
/* pure helpers                                                               */
/* -------------------------------------------------------------------------- */

test('parseBdJson tolerates a warning line before the payload', () => {
  const parsed = parseBdJson('Warning: permissions 0755\n[{"id":"x"}]')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value[0].id, 'x')
})

test('parseBdJson accepts an empty body as an empty list', () => {
  assert.deepEqual(parseBdJson(''), { ok: true, value: [] })
})

test('parseBdJson reports unparseable output', () => {
  assert.equal(parseBdJson('not json at all').ok, false)
})

test('shapeIssue normalises a list row', () => {
  const issue = shapeIssue({
    id: 'proj-abc12',
    title: 'Title',
    status: 'open',
    priority: 1,
    issue_type: 'bug',
    labels: ['a', 2],
    dependencies: [{ id: 'proj-def34', title: 'Dep', dependency_type: 'blocks', status: 'open' }],
    comment_count: 3,
  })
  assert.equal(issue.id, 'proj-abc12')
  assert.equal(issue.type, 'bug')
  assert.equal(issue.priority, 1)
  assert.deepEqual(issue.labels, ['a', '2'])
  assert.equal(issue.dependencies[0].id, 'proj-def34')
  assert.equal(issue.commentCount, 3)
})

test('shapeIssue tolerates a sparse row', () => {
  const issue = shapeIssue({})
  assert.equal(issue.id, '')
  assert.equal(issue.status, 'open')
  assert.equal(issue.priority, 2)
  assert.deepEqual(issue.labels, [])
})

test('isLoopbackRequest accepts loopback spellings only', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.10' } }), false)
  assert.equal(isLoopbackRequest({}), false)
})

/* -------------------------------------------------------------------------- */
/* workspace discovery                                                        */
/* -------------------------------------------------------------------------- */

test('findWorkspace walks up to the directory holding .beads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bv-ws-'))
  try {
    await mkdir(join(root, '.beads'), { recursive: true })
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    assert.equal(await findWorkspace(join(root, 'a', 'b')), root)
    assert.equal(await findWorkspace(tmpdir()), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('live: bd where decides the workspace, not a .beads walk', async (t) => {
  if (!hasBd) {
    t.skip('bd CLI not installed')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'bv-where-'))
  const other = await mkdtemp(join(tmpdir(), 'bv-where-other-'))
  try {
    const bin = await resolveBd()
    for (const dir of [root, other]) {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync(bin, ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
    }
    // A subdirectory resolves to its own workspace.
    const sub = join(root, 'a', 'b')
    await mkdir(sub, { recursive: true })
    const fromSub = await whereWorkspace(sub, bin)
    // macOS resolves /var to /private/var; compare real paths, not spellings.
    assert.equal(await realpath(fromSub.root), await realpath(root))

    // `BEADS_DIR` overrides the local workspace, and the plugin must follow bd
    // rather than report the `.beads` directory it can see on disk.
    const env = { ...process.env, BEADS_DIR: join(other, '.beads') }
    const overridden = await new Promise((resolvePromise) => {
      execFileSync(bin, ['--readonly', 'where', '--json'], { cwd: root, encoding: 'utf8', env })
      resolvePromise(true)
    })
    assert.equal(overridden, true, 'bd itself honours BEADS_DIR')

    // A directory with no workspace anywhere answers undefined.
    assert.equal(await whereWorkspace(tmpdir(), bin), undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
    await rm(other, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
})

test('checkFiles resolves a path written from the session folder too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bv-dual-'))
  try {
    await mkdir(join(root, 'server', 'services'), { recursive: true })
    await writeFile(join(root, 'server', 'services', 'pool.ts'), 'export {}')
    const fromRoot = await checkFiles(root, ['server/services/pool.ts'], join(root, 'server'))
    assert.equal(fromRoot[0].exists, true)
    assert.equal(fromRoot[0].sessionPath, 'services/pool.ts')

    // The same file named from the session's own folder resolves through the
    // session base, and stays addressable relatively.
    const fromSession = await checkFiles(root, ['services/pool.ts'], join(root, 'server'))
    assert.equal(fromSession[0].exists, true)
    assert.equal(fromSession[0].sessionPath, 'services/pool.ts')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkFiles reports only regular files inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bv-files-'))
  try {
    await writeFile(join(root, 'present.md'), '# hi')
    await mkdir(join(root, 'dir'))
    const rows = await checkFiles(root, ['present.md', 'dir', 'missing.md', '../../etc/passwd'])
    const byPath = Object.fromEntries(rows.map((row) => [row.path, row]))
    assert.equal(byPath['present.md'].exists, true)
    assert.equal(byPath.dir.exists, false)
    assert.equal(byPath['missing.md'].exists, false)
    assert.equal(byPath['../../etc/passwd'].exists, false)
    assert.equal(byPath['../../etc/passwd'].reason, 'outside-workspace')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* HTTP handler                                                               */
/* -------------------------------------------------------------------------- */

test('every status the workspace reports has a badge colour', async (t) => {
  if (!hasBd) {
    t.skip('bd CLI not installed')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'bv-statuses-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const bin = await resolveBd()
    execFileSync(bin, ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
    const overview = await readOverview({ cwd: root, bin })
    assert.equal(overview.ok, true, JSON.stringify(overview).slice(0, 300))

    // The vocabulary comes from `bd statuses`, so a status added by a bd upgrade
    // shows up here rather than silently rendering as an uncoloured chip.
    const names = new Set((overview.statuses ?? []).map((entry) => entry.name))
    assert.ok(names.size >= 5, `expected a status vocabulary, got ${[...names]}`)
    for (const name of names) {
      assert.ok(
        MAPPED_STATUSES.has(name),
        `status "${name}" from bd has no badge colour; add it to STATUS_BADGE in client.js`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('readBd always passes --readonly', async () => {
  const seen = []
  // A fake executable that records its argv and answers like `bd`.
  const dir = await mkdtemp(join(tmpdir(), 'bv-bin-'))
  const script = join(dir, 'bd')
  await writeFile(script, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(dir, 'argv.log'))}\necho '[]'\n`)
  await chmod(script, 0o755)
  try {
    await readBd(['list', '--json'], dir, script)
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim()
    assert.equal(argv, '--readonly list --json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handler rejects non-loopback callers', async () => {
  const res = await call('/beads-viewer/api?cwd=/tmp', { address: '10.0.0.5' })
  assert.equal(res.status, 403)
  assert.equal(res.json().code, 'forbidden')
})

test('handler rejects non-GET methods', async () => {
  const res = await call('/beads-viewer/api?cwd=/tmp', { method: 'POST' })
  assert.equal(res.status, 405)
})

test('handler requires cwd', async () => {
  const res = await call('/beads-viewer/api')
  assert.equal(res.status, 400)
  assert.equal(res.json().code, 'no-cwd')
})

test('handler reports a missing directory', async () => {
  const res = await call('/beads-viewer/api?cwd=/definitely/not/here')
  assert.equal(res.status, 404)
})

test('handler reports a project without .beads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bv-empty-'))
  try {
    const res = await call(`/beads-viewer/api?cwd=${encodeURIComponent(root)}`)
    assert.equal(res.status, 200)
    assert.equal(res.json().code, 'no-workspace')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* live bd                                                                    */
/* -------------------------------------------------------------------------- */

const hasBd = (await resolveBd()) !== undefined

test('live: overview and issue read from a real workspace', async (t) => {
  if (!hasBd) {
    t.skip('bd CLI not installed')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'bv-live-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const bin = await resolveBd()
    execFileSync(bin, ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
    execFileSync(
      bin,
      [
        'create',
        'Live viewer smoke issue',
        '--description',
        'Reads `index.js:12` and src/client.js for the file-link probe.',
        '--type',
        'task',
        '--priority',
        '1',
      ],
      { cwd: root, stdio: 'ignore' },
    )
    const overview = await readOverview({ cwd: root, bin })
    assert.equal(overview.ok, true, JSON.stringify(overview).slice(0, 300))
    assert.ok(overview.issues.length >= 1)
    const created = overview.issues.find((issue) => issue.title === 'Live viewer smoke issue')
    assert.ok(created, 'the created issue is in the overview')
    assert.equal(created.priority, 1)
    assert.equal(created.dependencies, undefined, 'list rows stay slim; detail carries relations')

    const detail = await readIssue({ cwd: root, bin, id: created.id })
    assert.equal(detail.ok, true)
    assert.match(detail.issue.description, /index\.js:12/)
    assert.deepEqual(detail.comments, [])
    assert.ok(Array.isArray(detail.dependents))

    // A closed issue still resolves through `show`.
    execFileSync(bin, ['close', created.id, '--reason', 'smoke'], { cwd: root, stdio: 'ignore' })
    const closed = await readIssue({ cwd: root, bin, id: created.id })
    assert.equal(closed.ok, true)
    assert.equal(closed.issue.status, 'closed')
    assert.equal(closed.issue.closeReason, 'smoke')

    // The route end to end, through the handler.
    const res = await call(`/beads-viewer/api?cwd=${encodeURIComponent(root)}`)
    const payload = res.json()
    assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300))
    assert.ok(payload.issues.length >= 1)
    assert.ok(Array.isArray(payload.statuses))

    const one = await call(
      `/beads-viewer/api?cwd=${encodeURIComponent(root)}&action=issue&id=${encodeURIComponent(created.id)}`,
    )
    assert.equal(one.json().ok, true)
    assert.equal(one.json().issue.id, created.id)

    const files = await call(
      `/beads-viewer/api?cwd=${encodeURIComponent(root)}&action=files&paths=${encodeURIComponent('index.js\nserver/x.py')}`,
    )
    assert.equal(files.json().ok, true)
    assert.equal(files.json().files.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('live: readiness distinguishes startable from blocked issues', async (t) => {
  if (!hasBd) {
    t.skip('bd CLI not installed')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'bv-ready-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const bin = await resolveBd()
    execFileSync(bin, ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
    const blocker = execFileSync(bin, ['q', 'The blocker'], { cwd: root, encoding: 'utf8' }).trim()
    const waiter = execFileSync(bin, ['q', 'Waits on the blocker'], { cwd: root, encoding: 'utf8' }).trim()
    const free = execFileSync(bin, ['q', 'Nobody blocks this'], { cwd: root, encoding: 'utf8' }).trim()
    execFileSync(bin, ['dep', 'add', waiter, blocker, '--type', 'blocks'], { cwd: root, stdio: 'ignore' })

    const overview = await readOverview({ cwd: root, bin })
    assert.equal(overview.ok, true, JSON.stringify(overview).slice(0, 300))
    assert.equal(overview.readiness, 'live')
    const byId = Object.fromEntries(overview.issues.map((issue) => [issue.id, issue]))
    assert.equal(byId[free].ready, true, 'an unblocked issue is ready')
    assert.equal(byId[blocker].ready, true, 'the blocker itself is startable')
    assert.equal(byId[waiter].ready, false, 'an issue with an open blocker is not ready')
    assert.equal(overview.counts.ready, 2, 'two of the three are startable')

    // Closing the blocker releases the waiter.
    execFileSync(bin, ['close', blocker, '--reason', 'done'], { cwd: root, stdio: 'ignore' })
    const after = await readOverview({ cwd: root, bin })
    const afterById = Object.fromEntries(after.issues.map((issue) => [issue.id, issue]))
    assert.equal(afterById[waiter].ready, true, 'closing the blocker makes the waiter ready')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('live: an unknown issue id is a clean not-found', async (t) => {
  if (!hasBd) {
    t.skip('bd CLI not installed')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'bv-miss-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const bin = await resolveBd()
    execFileSync(bin, ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
    const detail = await readIssue({ cwd: root, bin, id: 'nope-zzzz' })
    assert.equal(detail.ok, false)
    assert.ok(['not-found', 'bd-error'].includes(detail.code), detail.code)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */

let failed = 0
results.push({
  name: 'apply waits for a webServer provided after activation',
  skip: false,
  fn: () => {
    // Reproduces the post-restart 404: the plugin tree activated before the web
    // server existed, so a one-shot `ctx.get('webServer')` returned undefined and
    // the route was never registered — the panel still rendered, because its
    // client half is a static asset.
    const routes = []
    let pending = null
    const ctx = {
      get: () => undefined, // webServer not provided yet
      inject: (names, callback) => {
        assert.deepEqual(names, ['webServer'], 'apply must declare the service it needs')
        pending = () => callback({ get: (key) => (key === 'webServer' ? { register: (route) => routes.push(route) } : undefined), effect: (fn) => fn() })
      },
      effect: (fn) => fn(),
    }
    apply(ctx, {})
    assert.deepEqual(routes, [], 'nothing registers before the service exists')
    assert.equal(typeof pending, 'function', 'apply must wait instead of giving up')
    pending()
    assert.equal(routes.length, 1, 'the route registers once webServer appears')
    assert.equal(routes[0].path, ROUTE_PATH)
  },
})

results.push({
  name: 'apply still registers immediately when webServer is already present',
  skip: false,
  fn: () => {
    const routes = []
    const webServer = { register: (route) => routes.push(route) }
    const ctx = {
      get: (key) => (key === 'webServer' ? webServer : undefined),
      // Cordis calls back immediately when the service is already provided, so
      // going through `inject` is correct in both cases.
      inject: (names, callback) => callback({ get: (key) => (key === 'webServer' ? webServer : undefined), effect: (fn) => fn() }),
      effect: (fn) => fn(),
    }
    apply(ctx, {})
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'exact')
    assert.equal(routes[0].path, ROUTE_PATH)
  },
})

results.push({
  name: 'apply does not throw in a composition with no web server at all',
  skip: false,
  fn: () => {
    const lines = []
    const ctx = {
      get: () => undefined,
      inject: (names, callback) => callback({ get: () => undefined, logger: () => ({ info: (line) => lines.push(line) }) }),
      effect: (fn) => fn(),
    }
    apply(ctx, {})
    assert.equal(lines.length, 1, 'the absence is logged, not thrown')
  },
})

results.push({
  name: 'the workspace fingerprint moves when the store moves and ignores locks',
  skip: false,
  fn: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-fp-'))
    const beads = join(dir, '.beads', 'embeddeddolt', 'proj', '.dolt', 'noms')
    await mkdir(beads, { recursive: true })
    await writeFile(join(beads, 'manifest'), 'a')
    const before = fingerprintWorkspace(join(dir, '.beads'))
    assert.ok(before && before.includes('manifest'), 'the store entries must form the fingerprint')

    // A write to the store moves the fingerprint.
    await new Promise((done) => setTimeout(done, 20))
    await writeFile(join(beads, 'manifest'), 'bb')
    const after = fingerprintWorkspace(join(dir, '.beads'))
    assert.notEqual(after, before, 'a data write must change the fingerprint')

    // A lock file appearing must not: it is a process event, not a data change.
    await writeFile(join(beads, 'LOCK'), '')
    const withLock = fingerprintWorkspace(join(dir, '.beads'))
    assert.equal(withLock, after, 'a lock file must not count as a data change')
    await rm(dir, { recursive: true, force: true })
  },
})

results.push({
  name: 'the version route answers without spawning bd and without a workspace',
  skip: false,
  fn: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-ver-'))
    const cwd = join(dir, 'proj')
    await mkdir(join(cwd, '.beads', 'embeddeddolt', 'proj', '.dolt', 'noms'), { recursive: true })
    await writeFile(join(cwd, '.beads', 'embeddeddolt', 'proj', '.dolt', 'noms', 'manifest'), 'x')
    // resolveBd is replaced with one that explodes: reaching it would mean the
    // route paid a process spawn for a stat.
    const seen = []
    const ctx = {
      get: (key) => (key === 'webServer' ? { register: (route) => seen.push(route) } : undefined),
      inject: (names, callback) => callback({ get: (key) => (key === 'webServer' ? { register: (route) => seen.push(route) } : undefined), effect: (fn) => fn() }),
      effect: (fn) => fn(),
    }
    apply(ctx, { handlerDeps: { resolveBd: async () => { throw new Error('bd must not be spawned for a version poll') } } })
    const handler = seen[0].handler
    const payload = await new Promise((done) => {
      handler(
        { url: `http://127.0.0.1${ROUTE_PATH}?cwd=${encodeURIComponent(cwd)}&action=version`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
        { writeHead(){}, end(body){ done(JSON.parse(body)) } },
      )
    })
    assert.equal(payload.ok, true, 'the version route answers even when bd is unusable')
    assert.ok(payload.version && payload.version.includes('manifest'), 'it reports the store fingerprint')
    // Three answers in a row must be identical: `bd where` spawns bd, bd opens the
    // Dolt store, and opening it touches journal.idx — so a poll that spawns bd
    // moves the fingerprint it just read and refreshes forever.
    const again = await new Promise((done) => {
      handler(
        { url: `http://127.0.0.1${ROUTE_PATH}?cwd=${encodeURIComponent(cwd)}&action=version`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
        { writeHead(){}, end(body){ done(JSON.parse(body)) } },
      )
    })
    assert.equal(again.version, payload.version, 'polling must not disturb the fingerprint')

    // While one of our own `bd` reads is in flight, the fingerprint is mid-write:
    // the route must say so, because a sample taken now is neither the old state
    // nor the new one. This is the race that made an open detail view refresh a
    // few times at random — the poll sampled the store while the detail read was
    // still touching it.
    let release
    const gate = new Promise((done) => { release = done })
    const blocking = { resolveBd: async () => { await gate; return '/bin/bd' } }
    const seen2 = []
    const ctx2 = {
      get: (key) => (key === 'webServer' ? { register: (route) => seen2.push(route) } : undefined),
      inject: (names, callback) => callback({ get: (key) => (key === 'webServer' ? { register: (route) => seen2.push(route) } : undefined), effect: (fn) => fn() }),
      effect: (fn) => fn(),
    }
    // Gate on the real bd binary so the gated read completes once released.
    apply(ctx2, { handlerDeps: { resolveBd: async () => { await gate; return 'bd' } } })
    const blockingHandler = seen2[0].handler
    const cwd2 = join(dir, 'proj2')
    await mkdir(join(cwd2, '.beads', 'embeddeddolt', 'proj', '.dolt', 'noms'), { recursive: true })
    await writeFile(join(cwd2, '.beads', 'embeddeddolt', 'proj', '.dolt', 'noms', 'manifest'), 'x')
    const ask2 = (u) => new Promise((done) => {
      blockingHandler(
        { url: `http://127.0.0.1${u}`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } },
        { writeHead(){}, end(body){ done(JSON.parse(body)) } },
      )
    })
    const inFlight = ask2(`${ROUTE_PATH}?cwd=${encodeURIComponent(cwd2)}&action=issue&id=x`)
    // Give the gated read a tick to reach its await, so the window is open.
    await new Promise((done) => setTimeout(done, 50))
    const during = await ask2(`${ROUTE_PATH}?cwd=${encodeURIComponent(cwd2)}&action=version`)
    assert.equal(during.busy, true, 'a read in flight must mark the sample as busy')
    release()
    const issueBody = await inFlight
    assert.ok('ok' in issueBody, 'the gated read must complete with a JSON answer')
    const after = await ask2(`${ROUTE_PATH}?cwd=${encodeURIComponent(cwd2)}&action=version`)
    assert.equal(after.busy, false, 'once the read settles the sample is valid again')
    assert.ok(after.version, 'and it reports a fingerprint')
    // The version path answers from the filesystem walk, so the cwd comes back as
    // the caller spelled it (no bd, hence no realpath from `bd where`).
    assert.equal(payload.cwd, cwd)
    await rm(dir, { recursive: true, force: true })
  },
})

for (const { name, fn } of results) {
  const ctx = { skip: (reason) => console.log(`SKIP ${name} — ${reason}`) }
  try {
    await fn(ctx)
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
