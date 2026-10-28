# Decisions

Why this plugin is built the way it is. Each entry records the alternative that was
rejected, so the next change does not accidentally undo the reason.

## Read the tracker through `bd`, not through its database

**Chosen:** shell out to `bd --json --readonly` per request, through one `readBd`
helper that owns the flag.

**Rejected:** open `.beads/*.db`, or the Dolt server, directly.

A Beads workspace is a SQLite file or a Dolt database depending on how `bd init` was
run, and the schema moves between `bd` releases — a workspace on disk today was
already refusing to open under this `bd` version during development. `bd` is the only
interface that knows which shape a given workspace is, and it already reports the
migration instruction for the old one. Opening the database directly would mean
tracking a schema that changes, and would also mean a viewer could write.

The cost is one process per refresh (~0.9 s on a 380-issue tracker). Three measures
keep that off the critical path: the list is cached for four seconds per workspace,
rows are trimmed to what the list draws, and a detail read is the only thing that
fetches prose.

## Ask `bd` for readiness instead of deriving it

**Chosen:** a second `bd ready` call per overview; the payload carries the answer.

**Rejected:** compute readiness in the plugin from each issue's `dependencies` and
their statuses.

A hand-derived predicate matched `bd ready` on this machine only because the shapes
happened to line up — and getting there took three attempts, because "open status"
and "every blocking dependency closed" are not the whole rule (in-progress issues are
excluded, `relates-to` edges never block, and the transitive closure matters). Any of
those could change in a bd release. The extra call costs ~0.3s on a cached path and
cannot drift.

The tri-state matters as much as the value: `'live'` with a per-issue boolean, or
`'unavailable'` when the command fails. The panel offers no readiness chip in the
second case, because showing "Ready 0" would report a failure as a finding.

## Return both a workspace-relative and a session-relative path

**Chosen:** `checkFiles` reports `absolute` (for opening) and `sessionPath` (when the
file is inside the session's own folder), and the client prefers `sessionPath`.

**Rejected:** return only the path as written in the issue.

The Beads workspace can sit above the session's cwd (a monorepo opened at a package),
so a path written from the project root does not resolve against the session root.
But an absolute address is a different tab identity from the relative one the chat
uses for the same file — opening a link would duplicate a tab that is already open.
The pair solves both: resolve against both roots, then address the file relatively
whenever the session can name it that way.

## Never invent a file link

**Chosen:** scan the prose for path-shaped tokens, then ask the Host which of them are
real files, and only link those.

**Rejected:** link every token that looks like a path.

Issue prose mixes real references with examples and version numbers. A link that
opens "file not found" is worse than plain text, so existence is decided by the Host
(which can stat the file) rather than by the renderer.

## Render Markdown in the plugin

**Chosen:** a small built-in renderer (`parseBlocks` → `renderBlocks`).

**Rejected:** depend on a Markdown package.

The Client module table is a fixed baseline; pulling in a renderer would add a
dependency that has to stay in step with the host's module graph, for a document set
that uses headings, lists, tables, fenced code, quotes, links and emphasis. The
renderer is ~200 lines, has no dependencies, and is covered by parser and render
tests. If it ever needs a feature outside that set, the trade-off should be revisited
deliberately.

## Register from an injected child context

**Chosen:** `ctx.inject(['sidebarRightTabs', 'slots'], scope => …)` and register the
tab type and the slot body on `scope`.

**Rejected:** read the service once in `apply` and register on `ctx`.

The right sidebar is another package's service. Waiting for it through `ctx.inject`
survives activation order, and registering on the child context means both
registrations disappear with the service instead of surviving it and pointing at a
dead registry. Locale is read optionally for the same reason: a composition without it
keeps the English copy rather than failing activation.

## Style with theme tokens only

**Chosen:** every colour and font in the panel comes from `--dsw-alias-*` /
`--dsw-font-*`, with a literal only as a fallback inside `var()`.

**Rejected:** a palette of its own.

The panel sits inside the Harness UI, beside host pages, in light and dark themes. A
token that gets renamed degrades the look; a hard-coded palette would clash in one of
the two themes immediately.
