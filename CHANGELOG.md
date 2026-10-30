# Changelog

## 1.1.4

**Refreshing no longer blanks the detail view, and regaining window focus only
reloads when the tracker actually changed.**

- **The detail view keeps its body while it refreshes.** A revision bump used to
  reset the detail to `{ loading: true, data: null }`, so every refresh — focus,
  poll, or the Refresh button — blanked the open issue and repainted it. A refresh
  of the same issue now keeps the body on screen and swaps in the new answer when
  it lands; the loading placeholder is reserved for "nothing to show yet". Opening
  a *different* issue still clears immediately, so an old body never sits under a
  new id.
- **Focus compares before refreshing.** Regaining window focus bumped the revision
  unconditionally, spending a `bd` read even when nothing had changed. Focus now
  asks the same stat-only fingerprint question as the 5-second poll and refreshes
  only on a real change.
- **One checker, one baseline.** Focus and poll share a single check and a single
  baseline; near-simultaneous triggers coalesce instead of queueing two refreshes.
  The in-flight gate is released in a `finally`, and a watchdog aborts a check that
  never settles — a transient route error or a stalled host must not leave the gate
  stuck and silently stop live refresh for the session.
- **Ordered answers only.** An answer for an issue that is no longer open is
  dropped by comparing against the id captured when the request was sent, not
  against live state — an A→B quick switch cannot let A's late answer paint over B.

Covered by four new panel tests: *a revision refresh keeps the open issue on screen
until the new answer lands*, *switching issues clears the old body immediately*,
*a late answer for a closed issue cannot paint over the open one*, *window focus
refreshes only when the fingerprint moved, and only once* (including the
double-trigger case), *a failed version check does not wedge live refresh*, and
*a version check that never settles releases the gate on timeout*.
**114 checks** across five suites.

## 1.1.3

**The last of the detail-page refreshes: a concurrent read race.**

Opening a detail page fires an issue read; a window focus at the same moment
fires an overview read alongside it. Both spawn `bd`, and each touches
`journal.idx` at its own moment. 1.1.2 recorded the `afterOwnRead` baseline from
whichever read returned, but the other read's touch could land *after* that
baseline was pinned — so the next poll saw a value matching neither the old state
nor the baseline and refreshed a few more times before settling.

- **The baseline now comes from the last completing read.** In-flight reads are
  counted per workspace — a path-keyed set would collapse the overview and issue
  reads of one workspace into a single entry, so the first finisher would think it
  was alone and pin the baseline while the other `bd` was still running. A read
  that finishes while a sibling is in flight only decrements the count; the
  fingerprint is recorded when the last one releases. Sibling detection is scoped
  to that workspace, so a read of another workspace cannot suppress this one's
  baseline. The count is released in a `finally`, so a failed read cannot wedge
  the workspace busy forever.
- **One baseline, one key.** The read routes learn the workspace from `bd where`
  (a real path, `…/private/var/…`) while the version route walks up from the
  session's cwd (which keeps its spelling, `…/var/…`). Both sides now normalise
  through `realpathSync` before storing or reading the baseline, so the lookup
  never misses on macOS's symlinked temp paths.

Covered by two gated tests: *overlapping reads of one workspace record the baseline
only after the last settles* (release one read, poll — busy, no baseline; release
the other, poll — the baseline equals the settled fingerprint) and *a read in
another workspace does not suppress this workspace baseline*. **108 checks**
across five suites.

## 1.1.2

**Opening a detail page caused 0-3 random refreshes; now none.**

Two races in the fingerprint polling introduced in 1.1.0, both fixed. (The 1.1.1
section below describes the same work but its npm tarball predates the commits —
this release is the one that actually contains it.)

- **The busy window opened too late.** The marker that tells the panel "a read of
  ours is in flight" was set after `bd` had already been resolved and spawned — a
  poll landing in that gap sampled a fingerprint the in-flight read was about to
  move. The window now opens at the top of the `bd`-reading path, before the first
  await.
- **A sample taken mid-read was treated as a signal.** While a read is in flight
  the fingerprint is neither the old state nor the new one. The version route now
  reports `busy: true` and the panel skips those samples entirely; the next poll
  settles.

**And one leak the fix itself nearly shipped with**

- The busy marker was only released on the normal path: an early return (`bd`
  binary missing) or a throw left the workspace flagged busy forever, and since the
  panel skips busy samples, live refresh would have silently stopped for the whole
  session. The window is closed in a `finally` now.
- The busy key and the read window's key came from different resolvers (`bd where`
  answers the real path; macOS spells `/tmp` as `/private/tmp`), so the window was
  invisible to the poll on some machines. Both keys are normalised through
  `realpathSync`.

Verified against a real tracker: create → fingerprint moves → issue appears;
detail open → polls stay stable with `busy: false`; close → fingerprint moves
again. 106 checks across five suites, plus a gated-read test that flips the busy
flag on and off.

## 1.1.1

**An open detail view no longer re-renders itself about once a second.**

- Opening a detail view serves `action=issue`, which spawns `bd` — and spawning
  `bd` opens the Dolt store and touches `journal.idx`. The next fingerprint poll
  saw a moved value, forced a refresh, and the refresh moved it again: the view
  re-rendered forever. The Host now records the workspace fingerprint right after
  every route that spawns `bd`, and the version answer carries it as
  `afterOwnRead`; the panel treats a polled value equal to that as its own
  movement, not a tracker change. A test walks the loop — detail read, poll,
  poll — and asserts no change is seen either time.

  ⚠️ **Not in the published 1.1.1.** The busy-skip below was written after the
  1.1.1 tag was cut — verified against the tag's own tree and the published
  tarball, neither contains it. The actual fix ships in 1.1.2; if you are on 1.1.1
  this is why an open detail view still re-renders occasionally.

## 1.1.0

**The panel now notices writes that happen outside this window.**

- **External updates refresh automatically.** An issue created, edited or closed
  from a terminal — or from another session — appears in the panel within about five
  seconds, with no Refresh click and no window focus. The Host answers a
  `?action=version` route with a fingerprint stat'd from the Beads store's own
  files (~3ms, no subprocess); the panel polls it while visible, and only a change
  spends the real read. An open detail view refreshes with the list.
  - Deliberately no `bd` in that route: spawning `bd` opens the Dolt store, which
    touches `journal.idx` and would move the fingerprint the route just read —
    every poll would look like a change. Lock files are skipped for the same
    reason: they tick on process starts, not on data changes.

**Two regressions from 1.0.0 fixed, both reported against real use**

- **The interface kept its language across a Harness restart.** The locale service
  was read with a bare `ctx.get('locale')`, which only works when the locale plugin
  happens to activate first; on other boots the whole locale block was skipped
  silently and the panel rendered English. The service is now declared
  (`inject: ['slots', 'locale']`), so Cordis resolves it before `apply` runs.
- **The two hero screenshots stayed side by side.** They were fixed-width images
  in a centered div; below a ~850px container the second wrapped under the first.
  They are now two table cells at 100% width each.

**Also**

- `.beads/issues.jsonl` (the lazy export `bd` refreshes on every write) is no
  longer tracked — it churned the repository and published every issue's text.
- The npm package declares its `repository` field, so registry download counts
  link back to this repository; `screenshots.json` declares four storefront
  images; the repo pins npmjs.org as its registry.

## 1.0.0

First release.

**The tab**

- Lives in the right sidebar as its own tab type (`beads`), beside Files and the
  task panels, and keeps its state across tab switches.
- Follows the Host in three ways that are easy to get wrong: the text size setting,
  the text and code font choices, and the interface language (`zh` / `en`).

**The list**

- Filter chips for ready, waiting, active and each lifecycle status, with a search
  box and a sort control. Counts come from the tracker, not from the loaded page.
- Rows are exactly three lines tall at every text size, so the list scans as a grid.
  A long title truncates at the container edge.
- Three filled badges per row — status, priority, type — in distinct hues, with the
  label colour derived from each fill's luminance so text is always legible. Hover
  tints only the row under the pointer.

**The detail**

- Issue Markdown rendered by a built-in renderer: headings, nested lists, tables,
  quotes, task lists, code blocks and inline code.
- Project files mentioned in the text become links that open in the sidebar's
  document preview, but only after the Host confirms the file exists.
- `⧉` copies the issue id; `↵` inserts it into the composer as one undoable edit.
- Design, notes, acceptance criteria and comments sit on a faint wash; the
  description keeps the foreground.

**The data path**

- One read-only route, `GET /beads-viewer/api`, loopback only, registered on the
  Host's web server. Every answer comes from `bd --readonly`, so the panel cannot
  write to a tracker and cannot see a workspace `bd` never opens.
- Readiness is live: `bd ready` is asked alongside the list, and the payload says
  `unavailable` rather than guessing when the question cannot be asked.

**Known limits**

- Two `bd` processes per refresh (~0.8s on a 380-issue project), cached four seconds.
- The list is capped at 2000 issues and 200 comments per issue.
