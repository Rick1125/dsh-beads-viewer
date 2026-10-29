/**
 * dsh-beads-viewer — Host half.
 *
 * Reads a project's Beads database through the `bd` CLI and serves it to the
 * right-sidebar panel over one read-only loopback route:
 *
 *   GET /beads-viewer/api?cwd=<project dir>&action=overview
 *   GET /beads-viewer/api?cwd=<project dir>&action=issue&id=<issue id>
 *
 * Why the CLI and not the database file: a Beads workspace is either a Dolt
 * server or a SQLite file depending on how `bd` was initialised, and its schema
 * moves between bd releases. `bd --json` is the only interface that stays
 * correct across both, and it already refuses to touch a workspace it cannot
 * open (a historical SQLite workspace reports its own migration error, which is
 * surfaced verbatim rather than guessed at).
 *
 * The route is read-only, loopback-only, and runs `bd` with `--readonly` so a
 * viewer can never mutate the issue database.
 *
 * @module dsh-beads-viewer
 */
import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** The exact route this plugin owns. */
export const ROUTE_PATH = '/beads-viewer/api'

/** One `bd` invocation may not exceed this; a cold Dolt open is the slow case. */
const BD_TIMEOUT_MS = 20_000

/** How long one workspace's issue list is reused before a fresh `bd` read. */
export const OVERVIEW_TTL_MS = 4_000

/** Issue rows returned by `action=overview` (a large tracker stays bounded). */
export const MAX_ISSUES = 2000

/** Comment bodies are large; keep a readable ceiling per issue. */
export const MAX_COMMENTS = 200

/** Candidate `bd` executables, tried in order after the bare command. */
const BD_CANDIDATES = [
  'bd',
  '/opt/homebrew/bin/bd',
  '/usr/local/bin/bd',
  join(homedir(), '.local/bin/bd'),
  join(homedir(), 'go/bin/bd'),
]

/**
 * Run one `bd` command in `cwd`.
 *
 * Never throws: a missing binary, a non-zero exit, and a workspace bd refuses
 * to open all come back as a result object, because every one of them is an
 * ordinary state this viewer must render rather than a crash.
 *
 * @param {string[]} args - `bd` arguments (never a shell string).
 * @param {string} cwd - the Beads workspace directory.
 * @param {string} [bin] - a resolved executable to use first.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number | null, error?: string }>}
 */
export function runBd(args, cwd, bin = 'bd') {
  return new Promise((resolvePromise) => {
    execFile(
      bin,
      args,
      { cwd, timeout: BD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error === null || error === undefined) {
          resolvePromise({ ok: true, stdout, stderr, code: 0 })
          return
        }
        const code = typeof error.code === 'number' ? error.code : null
        resolvePromise({
          ok: false,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code,
          error: typeof error.message === 'string' ? error.message : String(error),
        })
      },
    )
  })
}

/**
 * Resolve a usable `bd` executable once per call chain.
 *
 * @returns {Promise<string | undefined>} the first candidate that answers
 *   `--version`, or undefined when Beads is not installed for this Host.
 */
export async function resolveBd() {
  for (const candidate of BD_CANDIDATES) {
    if (candidate !== 'bd') {
      try {
        await access(candidate, fsConstants.X_OK)
      } catch {
        continue
      }
    }
    const probe = await runBd(['--version'], process.cwd(), candidate)
    if (probe.ok) return candidate
  }
  return undefined
}

/**
 * Run one read-only `bd` command.
 *
 * Every read goes through here rather than through `runBd` directly, so the
 * `--readonly` guarantee is structural instead of a per-call habit: `bd` refuses
 * every write verb under that flag, and a viewer has no business writing to the
 * issue database. The version probe is the only call that skips it (it opens no
 * workspace).
 *
 * @param {string[]} args - the verb and its arguments.
 * @param {string} cwd - the Beads workspace directory.
 * @param {string} bin - a resolved executable.
 */
export function readBd(args, cwd, bin) {
  return runBd(['--readonly', ...args], cwd, bin)
}

/** Whether a directory holds a Beads workspace (`.beads` beside the project). */
async function hasBeadsDir(dir) {
  try {
    const info = await stat(join(dir, '.beads'))
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Ask `bd` which workspace it would open for `start`.
 *
 * `bd where` is the authority, not a `.beads` directory walk: `BEADS_DIR`
 * overrides a local workspace, and a worktree can route elsewhere entirely. A
 * walk would then report a workspace `bd` never opens — or miss the one it does.
 *
 * @param {string} start - session working directory.
 * @param {string} bin - a resolved executable.
 * @returns {Promise<{ root: string, beadsDir: string } | undefined>}
 */
export async function whereWorkspace(start, bin) {
  const result = await runBd(['where', '--json'], start, bin)
  if (!result.ok) return undefined
  const parsed = parseBdJson(result.stdout)
  const path = parsed.ok ? parsed.value?.path : undefined
  if (typeof path !== 'string' || path === '') return undefined
  // `bd where` names the `.beads` directory; the panel wants the project root,
  // because that is what every issue-relative path is resolved against.
  const beadsDir = resolve(path)
  const root = beadsDir.endsWith(`${sep}.beads`) ? beadsDir.slice(0, -'.beads'.length - 1) : beadsDir
  return { root, beadsDir }
}

/**
 * Walk up from `start` looking for a directory that holds `.beads`.
 *
 * Kept as the fallback for a `bd` too old to answer `where --json`, and used by
 * the tests as the plain filesystem question.
 *
 * @param {string} start - session working directory.
 * @returns {Promise<string | undefined>} the workspace root.
 */
export async function findWorkspace(start) {
  let dir = resolve(start)
  for (let depth = 0; depth < 12; depth += 1) {
    if (await hasBeadsDir(dir)) return dir
    const parent = dir.slice(0, dir.lastIndexOf(sep)) || sep
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Parse JSON emitted by `bd`, tolerating a warning line printed before it. */
export function parseBdJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { ok: true, value: [] }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    // `bd` may print a permissions warning on stdout/stderr before the payload.
    const start = trimmed.search(/[[{]/)
    if (start > 0) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(start)) }
      } catch {
        /* fall through */
      }
    }
    return { ok: false }
  }
}

/** Normalise one issue row for the panel (list or detail shape). */
export function shapeIssue(raw) {
  const row = raw ?? {}
  const deps = Array.isArray(row.dependencies) ? row.dependencies : []
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    description: typeof row.description === 'string' ? row.description : '',
    design: typeof row.design === 'string' ? row.design : '',
    acceptanceCriteria: typeof row.acceptance_criteria === 'string' ? row.acceptance_criteria : '',
    notes: typeof row.notes === 'string' ? row.notes : '',
    status: String(row.status ?? 'open'),
    priority: typeof row.priority === 'number' ? row.priority : Number(row.priority ?? 2),
    type: String(row.issue_type ?? row.type ?? 'task'),
    assignee: row.assignee ? String(row.assignee) : '',
    owner: row.owner ? String(row.owner) : '',
    createdAt: row.created_at ? String(row.created_at) : '',
    updatedAt: row.updated_at ? String(row.updated_at) : '',
    closedAt: row.closed_at ? String(row.closed_at) : '',
    closeReason: row.close_reason ? String(row.close_reason) : '',
    labels: Array.isArray(row.labels) ? row.labels.map((label) => String(label)) : [],
    parent: row.parent ? String(row.parent) : '',
    commentCount: Number(row.comment_count ?? 0),
    dependencyCount: Number(row.dependency_count ?? 0),
    dependentCount: Number(row.dependent_count ?? 0),
    dependencies: deps.map((dep) => ({
      id: String(dep.id ?? dep.depends_on_id ?? ''),
      title: String(dep.title ?? ''),
      type: String(dep.dependency_type ?? dep.type ?? ''),
      status: String(dep.status ?? ''),
    })),
  }
}

/**
 * The list row the panel actually reads.
 *
 * A tracker with hundreds of issues makes the unedited record expensive to
 * serialise and parse for no benefit: the list shows no prose, and the detail
 * view fetches the whole issue anyway. Empty optional fields are dropped so a
 * large workspace stays a small response.
 */
export function shapeListIssue(raw) {
  const issue = shapeIssue(raw)
  const row = {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    type: issue.type,
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    commentCount: issue.commentCount,
    dependencyCount: issue.dependencyCount,
    labels: issue.labels,
  }
  if (issue.assignee !== '') row.assignee = issue.assignee
  if (issue.parent !== '') row.parent = issue.parent
  return row
}

/** Normalise one comment row. */
export function shapeComment(raw) {
  const row = raw ?? {}
  return {
    id: String(row.id ?? ''),
    author: String(row.author ?? ''),
    text: typeof row.text === 'string' ? row.text : '',
    createdAt: String(row.created_at ?? ''),
  }
}

/**
 * The status/priority vocabulary the filter row offers.
 *
 * Read from `bd` when it answers, with a static fallback so the panel still
 * filters while a command is slow or a workspace is mid-migration.
 */
const FALLBACK_STATUSES = [
  { name: 'open', description: 'Available to work' },
  { name: 'in_progress', description: 'Actively being worked on' },
  { name: 'blocked', description: 'Blocked by a dependency' },
  { name: 'deferred', description: 'Deferred to a later date' },
  { name: 'closed', description: 'Completed' },
]

/**
 * Build the `overview` payload: counts plus every issue row, newest activity
 * first. Closed issues are included so the filter row can reveal history, but
 * the client opens on the active slice.
 *
 * @param {{ cwd: string, bin: string }} options
 */
export async function readOverview({ cwd, bin }) {
  const list = await readBd(
    ['list', '--json', '-n', '0', '--all', '--brief', '--sort', 'updated'],
    cwd,
    bin,
  )
  if (!list.ok) {
    return failureFrom(list, cwd)
  }
  const parsed = parseBdJson(list.stdout)
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return {
      ok: false,
      code: 'bad-json',
      message: 'bd list returned output this viewer could not parse as JSON.',
      detail: list.stdout.slice(0, 400),
      cwd,
    }
  }
  const issues = parsed.value.slice(0, MAX_ISSUES).map(shapeListIssue)
  const counts = { total: issues.length }
  for (const issue of issues) {
    counts[issue.status] = (counts[issue.status] ?? 0) + 1
  }
  // Readiness comes from `bd ready`, not from re-deriving it here: the predicate
  // is bd's own (open status, every blocking dependency closed, transitive
  // blockers included) and re-implementing it would drift. It is also the signal
  // a terminal Beads viewer leads with — an open issue nobody can start yet is
  // the thing a flat status filter hides.
  const [statuses, readyIds] = await Promise.all([readStatuses(cwd, bin), readReadyIds(cwd, bin)])
  for (const issue of issues) {
    if (readyIds !== undefined) issue.ready = readyIds.has(issue.id)
  }
  counts.ready = issues.filter((issue) => issue.ready === true).length
  return {
    ok: true,
    cwd,
    issues,
    counts,
    statuses,
    // `undefined` when `bd ready` could not answer: the panel then shows no
    // readiness marking at all rather than marking everything not-ready.
    readiness: readyIds === undefined ? 'unavailable' : 'live',
    truncated: parsed.value.length > MAX_ISSUES,
    at: new Date().toISOString(),
  }
}

/**
 * The ids `bd ready` reports, or undefined when that command fails.
 *
 * Undefined is distinct from an empty set on purpose: an empty set means "this
 * project has nothing startable", which the panel may say. Undefined means the
 * question could not be asked, and the panel must not pretend it was answered.
 */
async function readReadyIds(cwd, bin) {
  const result = await readBd(['ready', '--json', '-n', '0'], cwd, bin)
  if (!result.ok) return undefined
  const parsed = parseBdJson(result.stdout)
  if (!parsed.ok || !Array.isArray(parsed.value)) return undefined
  return new Set(parsed.value.map((row) => String(row.id ?? '')))
}

/** Read the status vocabulary, falling back to the built-in list. */
async function readStatuses(cwd, bin) {
  const result = await readBd(['statuses', '--json'], cwd, bin)
  if (!result.ok) return FALLBACK_STATUSES
  const parsed = parseBdJson(result.stdout)
  const builtIn = parsed.ok ? parsed.value?.built_in_statuses : undefined
  if (!Array.isArray(builtIn) || builtIn.length === 0) return FALLBACK_STATUSES
  return builtIn.map((entry) => ({
    name: String(entry.name ?? ''),
    description: String(entry.description ?? ''),
  }))
}

/**
 * Build the `issue` payload: the whole issue, its comments, and both
 * dependency directions so the detail view can offer navigation.
 *
 * @param {{ cwd: string, bin: string, id: string }} options
 */
export async function readIssue({ cwd, bin, id }) {
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    return { ok: false, code: 'bad-id', message: `Not a valid issue id: ${id}` }
  }
  const show = await readBd(['show', id, '--json', '--include-comments'], cwd, bin)
  if (!show.ok) return failureFrom(show, cwd)
  const parsed = parseBdJson(show.stdout)
  const first = parsed.ok && Array.isArray(parsed.value) ? parsed.value[0] : parsed.ok ? parsed.value : undefined
  if (first === undefined || first === null) {
    return { ok: false, code: 'not-found', message: `No issue ${id} in this workspace.` }
  }
  const issue = shapeIssue(first)
  issue.description = typeof first.description === 'string' ? first.description : ''
  const comments = (Array.isArray(first.comments) ? first.comments : [])
    .slice(0, MAX_COMMENTS)
    .map(shapeComment)
  const dependents = await readDependents({ cwd, bin, id })
  return { ok: true, cwd, id, issue, comments, dependents, at: new Date().toISOString() }
}

/** Issues that depend on `id` (`bd dep list --direction up`), best effort. */
async function readDependents({ cwd, bin, id }) {
  const result = await readBd(['dep', 'list', id, '--direction', 'up', '--json'], cwd, bin)
  if (!result.ok) return []
  const parsed = parseBdJson(result.stdout)
  if (!parsed.ok || !Array.isArray(parsed.value)) return []
  return parsed.value.slice(0, 100).map((row) => ({
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    type: String(row.dependency_type ?? row.type ?? ''),
    status: String(row.status ?? ''),
  }))
}

/**
 * Turn a failed `bd` invocation into a panel-readable failure.
 *
 * The three states users actually hit are distinguished, because their fixes
 * differ: Beads missing, no workspace here, and a workspace this bd release
 * refuses to open (it prints its own migration instruction, which is the most
 * useful sentence available and is passed through unchanged).
 */
export function failureFrom(result, cwd) {
  const stderr = String(result.stderr ?? '').trim()
  const combined = `${stderr}\n${result.stdout ?? ''}`
  if (/no beads database found|No active beads workspace/i.test(combined)) {
    return {
      ok: false,
      code: 'no-workspace',
      cwd,
      message: 'This project has no Beads workspace (no .beads directory).',
      detail: stderr,
    }
  }
  if (/historical SQLite workspace|migration is required/i.test(combined)) {
    return {
      ok: false,
      code: 'needs-migration',
      cwd,
      message: 'This Beads workspace needs an explicit migration before this bd version can open it.',
      detail: stderr,
    }
  }
  if (/command not found|ENOENT/i.test(combined) || result.code === 127) {
    return {
      ok: false,
      code: 'bd-missing',
      cwd,
      message: 'The bd CLI is not on this machine’s PATH.',
      detail: stderr || result.error,
    }
  }
  return {
    ok: false,
    code: 'bd-error',
    cwd,
    message: 'bd refused the request.',
    detail: stderr || result.error || `exit ${result.code}`,
  }
}

/**
 * Which of the issue's referenced paths exist inside the workspace.
 *
 * Issue prose names files the way an author typed them, so this is the filter
 * that keeps a mention from becoming a dead link: a path is offered as a file
 * link only when it resolves inside the workspace and is a regular file.
 * Paths that escape the workspace (`../..`) are never reported as existing,
 * because the panel can only open what the session may read.
 *
 * @param {string} workspace - the project root.
 * @param {string[]} paths - workspace-relative candidate paths.
 */
export async function checkFiles(workspace, paths, sessionCwd) {
  const root = resolve(workspace)
  const sessionRoot = sessionCwd ? resolve(sessionCwd) : undefined
  const rows = []
  for (const raw of paths) {
    // A path in issue prose can be written from the project root or from the
    // session's own folder, and those differ when the session sits in a
    // subdirectory; try the workspace root first, then the session root.
    const roots = sessionRoot !== undefined && sessionRoot !== root ? [root, sessionRoot] : [root]
    const candidate = await firstExistingFile(roots, raw)
    if (candidate === undefined) {
      const outside = roots.every((base) => {
        const joined = resolve(base, raw)
        return !(joined === base || joined.startsWith(`${base}${sep}`))
      })
      rows.push(outside ? { path: raw, exists: false, reason: 'outside-workspace' } : { path: raw, exists: false })
      continue
    }
    try {
      const info = await stat(candidate)
      const row = { path: raw, absolute: candidate, exists: true, size: info.size }
      // The session-relative spelling is what dedupes: the sidebar addresses a
      // file inside the session's own workspace relatively, so a link opened
      // here lands on the tab the chat already opened for the same file. A file
      // outside that workspace cannot be named relatively and keeps its absolute
      // path instead.
      if (sessionRoot !== undefined && candidate.startsWith(`${sessionRoot}${sep}`)) {
        row.sessionPath = candidate.slice(sessionRoot.length + 1)
      }
      rows.push(row)
    } catch {
      rows.push({ path: raw, exists: false })
    }
  }
  return rows
}

/**
 * The first base under which `raw` names an existing regular file, with the
 * containment rule applied per base.
 */
async function firstExistingFile(bases, raw) {
  for (const base of bases) {
    const joined = resolve(base, raw)
    if (!(joined === base || joined.startsWith(`${base}${sep}`))) continue
    try {
      const info = await stat(joined)
      if (info.isFile()) return joined
    } catch {
      /* try the next base */
    }
  }
  return undefined
}

/** Loopback-only guard: the route serves local project data. */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** Constant-shape JSON reply. */
function sendJson(res, status, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * The HTTP handler behind {@link ROUTE_PATH}.
 *
 * `?cwd=` is the only caller-supplied path and it must be an existing directory
 * that (or whose ancestor) holds `.beads`; the workspace root is then used for
 * every `bd` call, so a request can never point bd at an arbitrary tree that
 * happens to contain issue-shaped JSON.
 *
 * @param {{ resolveBd?: () => Promise<string | undefined> }} [deps] - injection
 *   points for tests.
 */
/**
 * A cheap change signal for a Beads workspace, for the client to poll.
 *
 * `bd` keeps its data in `.beads/embeddeddolt/<name>/.dolt/noms/` — those files'
 * mtimes move on every write. Statting four paths costs microseconds and spawns
 * nothing, so the panel can poll it often without paying for a `bd` process; only
 * when the fingerprint changes does the client spend the real read.
 *
 * `issues.jsonl` is deliberately not part of this: it is a passive export that
 * `bd` refreshes lazily, so its mtime can lag an actual write by hours.
 */
export function fingerprintWorkspace(beadsDir) {
  // Candidate stores, in the order bd actually uses them. Dolt workspaces keep
  // their mutable data under .dolt/noms; SQLite layouts are single files.
  const candidates = [
    join(beadsDir, 'embeddeddolt'),
    join(beadsDir, 'dolt'),
    join(beadsDir, 'db.sqlite'),
    join(beadsDir, 'beads.db'),
  ]
  for (const path of candidates) {
    try {
      const info = statSync(path)
      if (!info.isDirectory()) {
        // A SQLite layout: the file's own stamp is the whole signal.
        return `${info.mtimeMs}:${info.size}`
      }
      // Dolt layout: the store lives at <path>[/<dbname>]/.dolt/noms. Watching the
      // wrapper (or its lock files) would tick on every `bd` process start, which is
      // not a data change — so watch the store's own entries.
      const nomsCandidates = [
        join(path, '.dolt', 'noms'),
        // one level of database directories, e.g. embeddeddolt/<name>
        ...(() => {
          try {
            return readdirSync(path)
              .filter((entry) => !entry.endsWith('.lock'))
              .map((entry) => join(path, entry, '.dolt', 'noms'))
          } catch {
            return []
          }
        })(),
      ]
      let store = undefined
      for (const candidate of nomsCandidates) {
        try {
          statSync(candidate)
          store = candidate
          break
        } catch {
          /* try the next candidate path */
        }
      }
      if (store === undefined) store = path
      let stamp = ''
      for (const entry of readdirSync(store)) {
        const upper = entry.toUpperCase()
        if (entry === '.DS_Store' || entry === 'LOCK' || entry.endsWith('.lock')) continue
        try {
          const child = statSync(join(store, entry))
          stamp += `${entry}:${child.mtimeMs}:${child.size}|`
        } catch {
          /* an entry vanishing mid-scan is the poll racing a write; next poll sees it */
        }
      }
      return stamp
    } catch {
      /* try the next candidate layout */
    }
  }
  return undefined
}


export function makeHandler(deps = {}) {
  const resolveBdImpl = deps.resolveBd ?? resolveBd
  /** Per-workspace overview cache: a sidebar opened twice in a row is free. */
  const cache = new Map()
  /**
   * Per-workspace fingerprint taken right after one of our own `bd` reads.
   *
   * Spawning `bd` opens the Dolt store and touches journal.idx, so the fingerprint
   * the panel polls moves after every read this route serves — even with no
   * external write. Without this baseline every poll looked like a change and an
   * open detail view refreshed forever. The panel compares the polled value to
   * this: equal means "the movement was ours", not "the tracker changed".
   */
  const ownReadFingerprints = new Map()
  /** Workspaces with a `bd` read in flight right now. */
  const readsInFlight = new Set()

  /**
   * Record the workspace fingerprint once every in-flight read for it has finished.
   *
   * Concurrent bd reads (a focus bump's overview racing a row click's issue read)
   * each touch journal.idx at unpredictable moments; the baseline must come from
   * the LAST completing read, or the next poll sees a value matching neither the
   * old state nor the baseline. Callers release their own in-flight key first and
   * then call this; a sibling key still present means another read is finishing
   * after this one, and that one records the baseline instead.
   */
  // The read routes learn the workspace from `bd where` (a real path) while the
  // version route walks up from the session cwd (which keeps the spelling it was
  // given, e.g. macOS `/var` for `/private/var`). The baseline is one value per
  // workspace, so both sides must agree on the key or the lookup misses.
  const baselineKey = (workspace) => {
    try {
      return realpathSync(workspace)
    } catch {
      return workspace
    }
  }

  const readCompleted = (workspace, selfKey) => {
    // A sibling key still present means another read is finishing after this one;
    // that read records the baseline instead. The window's own key does not count —
    // it is held by the window itself until its finally, not by a concurrent read.
    let siblings = false
    try {
      const own = realpathSync(workspace)
      for (const key of readsInFlight) {
        if (key === selfKey || key === own) continue
        siblings = true
        break
      }
    } catch {
      siblings = false
    }
    if (siblings) return
    const stamp = fingerprintWorkspace(join(workspace, '.beads'))
    if (stamp !== undefined) ownReadFingerprints.set(baselineKey(workspace), stamp)
    return stamp
  }
  const ttl = deps.cacheTtlMs ?? OVERVIEW_TTL_MS

  /** One cached overview, or a fresh read when the entry is stale. */
  async function overview(workspace, bin, force) {
    const hit = cache.get(workspace)
    if (!force && hit !== undefined && Date.now() - hit.at < ttl) return hit.value
    const value = await readOverview({ cwd: workspace, bin })
    // Only successful reads are worth remembering: a workspace mid-migration
    // must show the fresh error, not a cached one.
    if (value.ok) cache.set(workspace, { at: Date.now(), value })
    else cache.delete(workspace)
    return value
  }

  return async function beadsHandler(req, res) {
    try {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, code: 'forbidden', message: 'This route serves local project data only.' })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'method', message: 'Read-only route: GET only.' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const requested = url.searchParams.get('cwd') ?? ''
      const action = url.searchParams.get('action') ?? 'overview'
      if (requested === '') {
        sendJson(res, 400, { ok: false, code: 'no-cwd', message: 'Missing the cwd of the session workspace.' })
        return
      }
      let info
      try {
        info = await stat(requested)
      } catch {
        sendJson(res, 404, { ok: false, code: 'no-cwd', message: `Directory not found: ${requested}` })
        return
      }
      if (!info.isDirectory()) {
        sendJson(res, 400, { ok: false, code: 'no-cwd', message: `Not a directory: ${requested}` })
        return
      }
      // The change signal is answered without `bd` at all: its whole point is to be
      // cheap enough to poll. That means no `bd where` either — spawning `bd` opens
      // the Dolt store, which touches journal.idx, which would move the very
      // fingerprint we just read and make every poll look like a change. The
      // workspace root for a stat is a filesystem question, so use the walk-up.
      if (action === 'version') {
        const workspace = await findWorkspace(requested)
        if (workspace === undefined) {
          sendJson(res, 200, {
            ok: false,
            code: 'no-workspace',
            cwd: requested,
            message: 'This project has no Beads workspace (no .beads directory).',
          })
          return
        }
        const beadsDir = join(workspace, '.beads')
        // Normalise the busy lookup the same way the issue branch does, or a
        // /tmp-vs-/private/tmp path spelling hides the in-flight window.
        let busyNow = false
        try { busyNow = readsInFlight.has(realpathSync(workspace)) } catch { busyNow = false }
        const version = fingerprintWorkspace(beadsDir) ?? null
        // Tell the panel what the fingerprint looked like after our last read, so
        // movement caused by this route's own `bd` spawns is recognisable as ours.
        // And while a read is in flight, the fingerprint is mid-write: the panel
        // must skip this sample entirely, because `bd` is touching journal.idx at
        // this moment and the next poll will settle the value.
        sendJson(res, 200, {
          ok: true,
          cwd: workspace,
          version,
          afterOwnRead: ownReadFingerprints.get(baselineKey(workspace)) ?? null,
          busy: busyNow,
        })
        return
      }
      // Everything from here spawns `bd` (resolution, where, reads) — and spawning
      // one touches the Dolt store, so the busy window opens before the first await
      // and is closed in a finally. Both matter: an early return or a throw that
      // left the marker set would keep that workspace busy forever, and the panel
      // skips busy samples — live refresh would silently stop for the session.
      // realpathSync normalises the key: `bd where` answers the real path (macOS
      // spells /tmp as /private/tmp), and the busy marker must match the key the
      // issue branch uses, or the detail-read window is invisible to the poll.
      const walked = await findWorkspace(requested)
      const busyKey = walked !== undefined ? realpathSync(walked) : undefined
      if (busyKey !== undefined) readsInFlight.add(busyKey)
      try {
        const bin = await resolveBdImpl()
        if (bin === undefined) {
          sendJson(res, 200, {
            ok: false,
            code: 'bd-missing',
            cwd: requested,
            message: 'The bd CLI is not on this machine’s PATH.',
          })
          return
        }
        const located = await whereWorkspace(requested, bin)
        const workspace = located?.root ?? (await findWorkspace(requested))
        if (workspace === undefined) {
          sendJson(res, 200, {
            ok: false,
            code: 'no-workspace',
            cwd: requested,
            message: 'This project has no Beads workspace (no .beads directory).',
          })
          return
        }
        // The bd-backed actions run inside this try, so the marker is released on
        // every exit path below. The version branch is not here: it must not spawn
        // bd at all, so it answers before this try begins (the busy window still
        // covers it — a poll arriving while an issue read runs sees busy).
        if (action === 'issue') {
          const id = url.searchParams.get('id') ?? ''
          cache.delete(workspace)
          // Normalise the key the same way the busy window does, so a poll can see
          // this read's window regardless of how each branch spelled the path.
          const issueKey = realpathSync(workspace)
          readsInFlight.add(issueKey)
          let body
          try {
            body = await readIssue({ cwd: workspace, bin, id })
          } finally {
            readsInFlight.delete(issueKey)
            // Baseline is recorded after the key is released, so the last
            // completing read for this workspace is the one that records it.
            readCompleted(workspace, issueKey)
          }
          sendJson(res, 200, body)
          return
        }
        if (action === 'files') {
          const paths = (url.searchParams.get('paths') ?? '').split('\n').filter(Boolean).slice(0, 200)
          const sessionCwd = url.searchParams.get('sessionCwd') ?? undefined
          const body = { ok: true, cwd: workspace, files: await checkFiles(workspace, paths, sessionCwd) }
          readCompleted(workspace, busyKey)
          sendJson(res, 200, body)
          return
        }
        const body = await overview(workspace, bin, url.searchParams.get('force') === '1')
        readCompleted(workspace, busyKey)
        sendJson(res, 200, body)
      } finally {
        if (busyKey !== undefined) readsInFlight.delete(busyKey)
      }
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        code: 'internal',
        message: String(error?.message ?? error),
      })
    }
  }
}

/**
 * Mount the route on the Host's web server.
 *
 * `webServer` is optional: in a CLI-only composition there is no browser to
 * serve, and the plugin simply stays inert instead of failing activation.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} [config] - the Loader row config.
 */
export function apply(ctx, config = {}) {
  const handler = makeHandler(config.handlerDeps ?? {})

  /**
   * Register the read route once `webServer` exists.
   *
   * This must WAIT for the service rather than read it once at activation: on a
   * fresh boot the plugin tree can activate before the web server is provided, and
   * the previous one-shot `ctx.get('webServer')` then returned undefined, logged a
   * line, and left the route unregistered for the whole session. The panel still
   * rendered — its client half is a static asset — so the failure looked like
   * "HTTP 404 but the search bar is there".
   */
  const wire = (scope) => {
    const webServer = typeof scope.get === 'function' ? scope.get('webServer') : undefined
    if (webServer === undefined || typeof webServer.register !== 'function') {
      scope.logger?.('beads-viewer')?.info?.('webServer absent; the Beads panel has no data route in this composition')
      return
    }
    const dispose = webServer.register({ kind: 'exact', path: ROUTE_PATH, handler })
    // One line at boot: without it a missing route is indistinguishable from a
    // failing one, which is exactly the confusion this fix came from.
    scope.logger?.('beads-viewer')?.info?.(`data route registered at ${ROUTE_PATH}`)
    if (typeof scope.effect === 'function') {
      scope.effect(() => dispose, 'beads-viewer: data route')
    }
  }

  // Same idiom the client half uses for its slot services: declare the dependency
  // and let Cordis call back when it is available.
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (scope) => wire(scope))
  else wire(ctx)
}
