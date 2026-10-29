# dsh-beads-viewer

A DeepSeek Harness plugin that puts this project's [Beads](https://github.com/Dicklesworthstone/beads)
issues in the right sidebar, beside Files and the other tabs.

It is the browser counterpart of the terminal `bv` viewer: same question — *what is
in this project's issue tracker, and what does it say* — answered where the code and
the conversation already are.

## What it does

- **A tab in the right sidebar.** It registers a `beads` tab type, so it appears in
  the sidebar's new-tab guide next to Files and the rest, and can be docked, split or
  floated like any other page.
- **Colour-coded badges.** Every row carries three filled badges — status, priority
  and type — so a list can be triaged without reading it. Hue carries the value
  (red is urgent or broken, amber is a warning, blue is normal work, green is a
  task, grey is inert) and shape carries the dimension (a pill is a status, a
  sharp monospace block is a priority, a soft square is a type).
- **Uniform row pitch.** A row is exactly three line boxes tall — title, badges,
  labels — expressed as `calc(3 * 1lh + padding)` so it follows the text metrics
  rather than a pixel value. A long title truncates with an ellipsis at the container
  edge instead of wrapping, and the label track is reserved even when an issue has no
  labels, so every row is the same height.
- **Secondary blocks are visually quieter.** Design, notes, acceptance criteria,
  close reason and the comments section take a faint accent wash, so the description
  stays the content you read first. The wash is mixed from the accent against
  `transparent` rather than a literal pale grey, which would be invisible on the dark
  surface. The description itself is never washed.
- **Hover marks the target row.** A resting row is plain; the row under the pointer
  takes a teal wash and border. The wash is mixed from one hue against
  `transparent`, so it reads correctly on both the light and the dark surface
  instead of needing a second literal.
- **Two rules the palette must satisfy, enforced by tests.** Every fill is checked
  against every other fill that shares a row (ΔE ≥ 25 in Lab, so no two badges
  read as the same colour) and label ink is *derived*, not chosen: a fill lighter
  than WCAG's luminance crossover takes black text, a darker one takes white. A
  fill that clashes or a hand-picked ink fails the suite.
- **The list.** A *Ready* chip (what you can start right now, from `bd ready`) and a
  *Blocked* chip beside the status chips, then active / open / in progress / closed /
  all, each with live counts, a search box (`/` focuses it), and sorting by update,
  priority, created or id. A row marks itself `ready`, or `waiting on N` when
  dependencies hold it — the distinction a flat status filter hides.
- **The issue.** Title, status, priority and label badges, timeline, then the body
  rendered as real Markdown: headings, ordered and unordered lists (nested and task
  lists), tables, fenced code with a language tag, quotes, links, and emphasis. A
  long comment thread opens on its most recent comments with the rest one click away.
- **Linked project files.** Any path in the issue that names a real file in the
  project becomes a clickable link that opens it in the sidebar. A path the project
  does not have stays plain text, so a renamed file cannot become a dead link.
- **Linked issues.** An issue id mentioned in the text opens that issue in the panel;
  the "depends on" and "blocks" sections are navigable too.
- **Copy or insert the id.** `⧉` copies the issue id; `↵` inserts it into the
  composer at the caret as one undoable edit.

## Install

```bash
# from the registry
dsh plugin --profile <name> add dsh-beads-viewer

# or from a checkout, which links the profile entry to this directory
dsh plugin --profile <name> add /path/to/dsh-beads-viewer
```

Then restart the Harness so the new bundle's client half loads. The tab appears in
the right sidebar's new-tab guide.

A **linked** install picks up edits on the next load with no reinstall; a registry
install is a normal package, so upgrading means running `add` again with the new
version.

## Requirements

- The `bd` CLI on the machine running the Harness. The Host finds it on `PATH`, then
  at the usual Homebrew and Go install locations. `brew install beads` is enough.
- A project with a Beads workspace. The panel asks `bd where` which workspace it
  would open, so a subdirectory, a git worktree and a `BEADS_DIR` override all
  resolve the way `bd` itself would.

If either is missing the panel says which one, in the panel itself, with the reason
`bd` gave.

## How it reads the tracker

The Host half serves one read-only route, `GET /beads-viewer/api`:

| Query | Answer |
| --- | --- |
| `?cwd=<dir>` | every issue (slim rows), status counts, the status vocabulary, and each issue's readiness |
| `?cwd=<dir>&action=issue&id=<id>` | the whole issue, its comments, and both dependency directions |
| `?cwd=<dir>&action=files&paths=<newline-separated>` | which of those paths exist, and where |

`?force=1` bypasses the four-second list cache.

Three properties are deliberate:

- **It shells out to `bd`, and reads no database file.** A Beads workspace is either
  a Dolt server or a SQLite file depending on how it was initialised, and the schema
  moves between `bd` releases. `bd --json` is the interface that stays correct across
  both — and when a workspace is too old, `bd` prints the migration instruction,
  which the panel shows verbatim rather than guessing at.
- **It is read-only.** Every read goes through one `readBd` helper that prepends
  `bd --readonly`, so the guarantee is structural rather than a per-call habit — a
  test asserts the flag is on the argv. No route mutates anything.
- **It only answers itself.** The route refuses non-loopback peers, and `?cwd=` must
  be an existing directory that (or whose parent) holds `.beads`. The directory is
  then used as the workspace for every `bd` call, so a request cannot point `bd` at
  an arbitrary tree.

## Layout

```
index.js            Host half: the read-only route and the bd calls
client.js           Client half: the sidebar tab, panel, and Markdown renderer
cordis.patch.yml    The bundle patch that mounts the host row
locale/{en,zh}.json Plugin title and description for the Plugin Manager
icon.svg            Panel artwork
test/               Host, client-helper, activation and render checks
```

## Tests

```bash
npm test
```

103 checks in five suites:

| File | Covers |
| --- | --- |
| `test/host.test.mjs` | the helpers, the handler's error states, and a real `bd` workspace (skipped when `bd` is missing) |
| `test/client.test.mjs` | the Markdown parser, path extraction, file addresses |
| `test/activation.test.mjs` | `apply` against a fake context, including a profile without the right sidebar |
| `test/render.test.mjs` | the Markdown renderer with real React and data from a real `bd` workspace |
| `test/panel.test.mjs` | the panel's states — list, detail after a row click, failure card, transport error, missing tab record |

The last two matter most: they render the shipped component tree, so a crash, a bad
prop or a broken hook order fails the suite instead of blanking the panel.

## Readiness, and why it is not computed here

`bd ready` owns the predicate (open, every blocking dependency closed, transitive
blockers included). Re-deriving it in the plugin would drift the moment bd changes a
rule, so the Host asks `bd` directly and reports `readiness: 'live'` with a flag per
issue. When that command fails the payload says `'unavailable'` and the panel offers
no readiness chip at all — an empty set means "nothing is startable", which is a
different and actionable statement from "the question could not be asked".

## What it looks like

Screenshots of the shipped component tree, rendered against the theme tokens
extracted from the host.

**List** — uniform three-line rows, tinted only under the pointer, badges in three
shapes so a row can be triaged without reading it:

| Light | Dark |
| --- | --- |
| ![list, light](docs/list-hover-light.png) | ![list, dark](docs/list-hover-dark.png) |

**Issue detail** — description first, secondary blocks (design, notes, acceptance
criteria, comments) on a faint wash:

| Light | Dark |
| --- | --- |
| ![detail, light](docs/detail-sections-light.png) | ![detail, dark](docs/detail-sections-dark.png) |

**Badge palette** — the full set, checked for contrast in both themes:

| Light | Dark |
| --- | --- |
| ![badges, light](docs/badges-light.png) | ![badges, dark](docs/badges-dark.png) |

Chinese interface, via the Host's own language setting:

![panel in Chinese](docs/lang-zh.png)

Details that took more than one attempt, kept as evidence:

- `docs/list-fixed-rows.png` — rows are one height at every text size.
- `docs/detail-list-indent.png` — an ordered list's marker and text against a
  bulleted one; the number is wider, so its gutter is wider too.

## Known limits

- Reading the tracker costs two `bd` processes per refresh (list + ready; ~0.8s on a
  380-issue project); the list is cached for four seconds, refreshes when the window
  regains focus, and the Refresh control bypasses the cache for its one request.
- The panel keeps its state (filter, search, open issue, scroll) across tab switches
  because its tab type is `keepMounted`.
- The panel is a viewer. Creating, editing and closing issues stays with `bd` and
  with the agent, which is the one place that can report exactly what changed.
- Markdown is rendered by a small built-in renderer rather than a full CommonMark
  implementation: it covers what issue bodies actually use (headings, lists, tables,
  code, quotes, links, emphasis) and adds file and issue links on top.
