# Changelog

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
