# Changelog

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
