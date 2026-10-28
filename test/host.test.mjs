/**
 * Host-half checks: real `bd` calls against a temporary Beads workspace, plus
 * the HTTP handler's error states. Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  checkFiles,
  findWorkspace,
  isLoopbackRequest,
  makeHandler,
  parseBdJson,
  readIssue,
  readOverview,
  resolveBd,
  shapeIssue,
} from '../index.js'

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
