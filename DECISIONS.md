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

## Ask `bd where` for the workspace, instead of walking up to `.beads`

**Chosen:** `bd where --json` decides which workspace the panel reads.

**Rejected:** walk up from the session folder until a directory holds `.beads`.

The walk agrees with `bd` often enough to look correct, and disagrees in exactly the
cases where being wrong is confusing: `BEADS_DIR` overrides a local `.beads`, and a
git worktree can route elsewhere. With `BEADS_DIR` set, a walk reports the local
workspace while `bd` opens the other one — the panel would show a different issue
list than the terminal next to it, with no indication why. `where --json` also
returns the `.beads` path itself, so the project root is derived rather than guessed.

The walk stays as a fallback for a `bd` too old to answer `where --json`.

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

## External `bd` writes are noticed by polling a stat, not by watching

**Chosen:** the panel polls `?action=version` every five seconds while its tab is
visible; the Host answers with a fingerprint stat'd from the Dolt store's own
entries, and only a change spends the real `bd` read (cache bypassed).

**Rejected:** file watching on the workspace, refreshing on window focus alone, and
any version signal that goes through `bd`.

The report was: an issue created or updated from a terminal never appeared. The
panel refreshed on window focus, and focus does not move when the change happened
somewhere else. Three dead ends were measured before the working design:

1. **`issues.jsonl` mtime** — it is a lazy export; its stamp lagged the last real
   write by hours.
2. **A fingerprint including lock files** — `.lock` and noms' own `LOCK` tick on
   every `bd` process start, so any `bd` command anywhere in the project would have
   refreshed the panel for no reason.
3. **Resolving the workspace with `bd where` in the version route** — the subtle
   one. Spawning `bd` opens the Dolt store, which touches `journal.idx`. The route
   stat'd the fingerprint *after* spawning, so every poll moved the value it had
   just read: the panel would have refreshed forever, five seconds apart, and no
   single test caught it until the version route was polled three times in a row.

So the version route answers with **no `bd` at all** — the workspace root comes from
the filesystem walk, and the fingerprint stats `.dolt/noms`' entries while skipping
every lock. One consequence is accepted: a `BEADS_DIR` override resolves the
fingerprint from the walked directory rather than `bd`'s answer, so in that setup
the signal may be taken from a neighbouring workspace's store. The main data still
comes from `bd`, so a missed refresh is the worst case, not wrong data.

Cost, measured: the fingerprint is a handful of stats (~3ms, no subprocess) against
~0.8s for a real read, and the four-second overview cache still applies underneath.

**One more trap surfaced in real use, and it was the poll's own doing.** Opening a
detail view serves `action=issue`, which spawns `bd` — and spawning `bd` opens the
Dolt store and touches `journal.idx`. The next poll therefore saw a moved
fingerprint, forced a refresh, and the refresh moved it again: an open detail view
re-rendered forever, roughly a second apart. The fix gives the Host a memory of its
own reads: after every route that spawns `bd` it records the workspace fingerprint,
and the version answer carries that value as `afterOwnRead`. The panel treats a
polled value equal to `afterOwnRead` as "the movement was ours", not a change. A
test walks the exact loop — detail read, then poll twice — and asserts the panel
sees no change either time.

**One more race in the same family, reported as 0-3 random refreshes on opening a
detail page.** The busy window above only opened when the handler reached the read
itself, but the poll could land *before* that — between the request arriving and
`readsInFlight.add` running — and sample a fingerprint that the in-flight read was
about to move. And a sample taken *during* the read was neither the old state nor
the new one. Two changes close it: the busy window opens at the top of the
bd-reading path (before the first await), and the version answer carries
`busy: true` while a read is in flight, which the panel treats as "skip this
sample; the next poll settles".

The general lesson across this plugin's polling bugs: **any signal you poll must be
invariant to the act of polling it**, and a sample taken mid-write is not a signal
at all. The first version failed because the act of resolving the workspace moved
the signal; the second because the act of reading the data did, and the window
opened too late to mask it.

## Secondary blocks are washed; the description is not

**Chosen:** `background: color-mix(in srgb, var(--bv-teal) 4%, transparent)` on
`.bv-section`, with the description left unwashed and a comment left transparent.

**Rejected:** a literal `gray-50` (`#f9fafb`), and washing the comment cards too.

Two facts decided this, both measured rather than assumed:

1. `gray-50` is theme-invariant. As a block background on the dark surface it puts
   light text at **1.0:1** — the text becomes invisible. The wash is therefore mixed
   from the panel accent against `transparent`, which reads as a pale mint on white
   and a deep teal-charcoal on dark: 18.1:1 and 16.5:1 for body text.
2. A comment sits *inside* the comments section, which already carries the wash.
   Tinting both stacked two 4% layers into 8% and the thread came out heavier than
   the description it is meant to sit behind. Comments are transparent with a border;
   the border alone separates entries.

The description deliberately gets no wash. The whole point of the wash is to rank
content, and a wash everywhere ranks nothing — a test asserts `.bv-md` stays plain.

**It did get an inset, on a wrapper of its own.** The description ran edge to edge
against the blocks below it, which read as one undifferentiated column. A `.bv-
description` wrapper now carries `padding: 12px 14px` (the sections use 9px 11px, so
the body text sits slightly further in than the blocks that follow).

The padding could not go on `.bv-md`: sections render their own `.bv-md` inside the
padding they already have, so a shared rule would inset that content twice — 12px
additively on top of 11px. A test asserts `.bv-md` declares no padding at all, and
another asserts the markup really wraps the description, since a rule with no
matching element would pass every stylesheet check while changing nothing.

## A list marker's gap is the list's own padding

**Chosen:** `.bv-mlist { padding-left: 1.9em }` (nested 1.7em).

**Rejected:** the 18px it was.

A bare `<ol>` puts its marker in the padding, so the padding *is* the gap between the
number and the panel edge. At 18px the marker sat almost against the detail pane's
border. Expressing it in `em` also means the gap grows with the Host text size
instead of staying 18px while the digits get bigger.

**Padding alone did not make the two list kinds look alike.** With an identical
`padding-left`, an ordered list still read as less indented than a bulleted one
beside it. The reason is that a native marker is laid out just outside the content
box at whatever width its glyph needs: a bullet is narrow, while `1.` — let alone
`10.` — is wide, so the wide marker reaches further left. The padding is not the
gutter; the marker's own width is.

The fix replaces the native marker with a fixed-width box: `list-style: none`, then
`.bv-mli::before` absolutely positioned at `left: -1.9em; width: 1.9em`, right
aligned with a small trailing pad, `ul` drawing a bullet and `ol` drawing
`counter(bv-li) "."`.

**Two wrong attempts came first**, both worth recording because each looked correct
in its own measurement:

1. *Right-aligned, no trailing pad.* Marker trailing edges and text starts matched
   exactly — and the list still looked wrong, because the reference a reader uses is
   the marker's **left** edge. A number is wider than a bullet, so at equal width the
   number's ink reached ~5px further left: `ol` read as less indented, exactly as
   reported. Pixel-sampling the rendered marker ink confirmed it (25px vs 30px).
2. *A wider gutter for `ol`.* This aligned the marker left edges, but pushed the
   ordered text 7px right of the bulleted text, so the two lists no longer lined up
   with each other — trading one mismatch for another.

**The third attempt was wrong too, and it was the one that shipped.** Equalising the
gutters made both lists start their text at the same x — and the report came back
unchanged, because the ask was never "make them identical", it was "an ordered list
reads as less indented, move it right". Aligning the marker ink to the bullet's had
satisfied a measurement I had invented, not the request.

What ships: the ordered gutter is **wider** than the bulleted one (`2.35em` vs
`1.9em`, nested `1.7em`), with the trailing pad kept small at `0.28em`. A number is
wider than a bullet, so the extra room absorbs the digits' width instead of letting
them hang left, and the numbered text lands further right. Measured: the marker ink
starts at 0 for both, while the ordered text starts at 37.6px against the bulleted
30.4px.

Recorded because the failure mode is easy to repeat: twice I adjusted a derived
number (gutter alignment, then gutter equality) without re-reading what was asked.
The request was comparative — "ol looks smaller than ul" — so the assertion that
guards it is comparative too: `olIndent > ulIndent`.

**A parser bug surfaced while fixing this.** The list block took its `ordered` flag
from the *first* marker and applied it to every item in the run, so this:

```
1. one
2. two

- alpha
- beta
```

rendered as `1. 2. 3. 4.` — the bullet list inherited the numbering. The run now
breaks when the marker kind changes at the same indent, and the outer loop opens a
second list of the correct type. Nested items still inherit their parent's type,
which is correct: a `- child` under `1. parent` is a `<ul>` inside the `<ol>`.

## A row is three fixed tracks, and the title is cut, not wrapped

**Chosen:** `height: calc(3 * 1lh + 2 * var(--bv-row-pad-y))` on `.bv-row`, with
`--bv-line: 1.7` as a unitless ratio, `grid-template-rows: repeat(3, 1fr)`, the title
on one line with `text-overflow: ellipsis`, and the label track always rendered.

**Rejected:** a two-line title clamp and an optional label row.

Rows measured 61, 81, 101 and 102px on one screen, because two things varied with
content: the title clamped at two lines, and the label row was omitted when an issue
had none. A list you scan vertically needs a constant row pitch, so both had to go.

Three sub-problems had to be solved together, and each one alone left rows uneven:

1. **The title wrapped.** `-webkit-line-clamp: 2` was the variable. One line with an
   ellipsis makes the height constant, and long titles now cut at the container edge
   as asked.
2. **The label track vanished.** It is now always rendered; empty means an empty
   track, not a shorter row. The test asserts it is not conditional, because the
   element still renders with no children and a markup check alone would miss it.
3. **The badge line wrapped.** `flex-wrap: wrap` let the badges take a second line
   on rows with many of them, adding 21px. It is `nowrap` with `overflow: hidden`
   now: content that does not fit is clipped rather than reflowed, which keeps the
   pitch constant.

**Then the height was re-derived from line boxes.** The first fix pinned each track
to a font-size multiple (`calc(var(--bv-font) * 1.7)`). That was still a guess: it
approximates a line and drifts from the real text metrics as soon as line-height
changes. The row now says what it means — three line boxes plus its own padding —
using the `1lh` unit, which resolves to the element's own computed line-height.
`--bv-line` must stay a unitless ratio, or `1lh` stops scaling with the font; a test
enforces that.

Measured afterwards, all rows identical at each setting, and each height equal to
`3 x line-height + 2 x padding` to the decimal: 66px at 12 (3x18.7+8.2), 78px at 14
(3x22.1+8.2), 102px at 18, 126px at 22.

## Row tint marks the pointer, and is mixed rather than picked

**Chosen:** a teal wash on `.bv-row:hover` only —
`background: color-mix(in srgb, var(--bv-teal) 14%, transparent)` plus a 38% border
— with the resting row left transparent.

**Rejected:** a literal `teal-100` (`#e6faed`), and tinting every row at rest.

Two corrections stand behind this, both mine:

1. **Resting tint was wrong.** The first version washed every row at 9%. A highlight
   exists to say "this is the row under your pointer"; if all rows are tinted the
   signal says nothing, and the settled list looks busy. Now only the pointed-at row
   carries colour, which is what was asked for.
2. **A literal light value cannot serve both themes.** `#e6faed` is
   theme-invariant; on the dark surface it leaves white text at 1.09:1. Mixing one
   hue against `transparent` lets the surface underneath decide: pale mint on white,
   deep teal-charcoal on dark. Measured after compositing, 16.2:1 in light and
   13.3:1 in dark — both far above AA.

The request was "a bit of background colour, e.g. teal-100". Two facts changed the
implementation while keeping the intent:

1. The theme has **no teal family** — only red, amber, green, blue, deepseek and
   neutral. The nearest token, `green-100`, is `#e6faed`.
2. `#e6faed` is theme-invariant. As a row background on the dark surface it puts
   white text at **1.09:1** — invisible. A light literal only works in one theme.

The accent is a literal because it is decoration, not semantics: semantic colour in
this panel comes from theme tokens, and inventing a `--dsw-*` name for a row wash
would misrepresent it as part of the design system.

## The tab chip is a second registration, not a property of the first

**Chosen:** a `BeadsTitle` component registered at `sidebar.right.pane.tab.title`
under the same key as the panel body.

**Rejected:** hoping `guide[].icon` covers the chip, or adding an `icon` field to
the tab type and expecting the sidebar to pick it up.

The start list and the open tab are two different seats. `guide[].icon` draws the
start-list tile; the chip above the panel is dispatched through its own slot and
renders the tab record's `title` text when nothing claims it. That is why the icon
appeared in the start list and vanished once the tab was open — the tab type was
registered correctly, the chip simply had no contributor.

The shipped sidebar reads the same way: `sidebar-files` registers `FilesBody` at
`sidebar.right.pane.tab` and a separate `FilesTitle` at
`sidebar.right.pane.tab.title`, the latter drawing `FileTypeIcon` before the title
text. Both seats take the same `key`, which is what makes the chip and the body
describe one record — a test asserts the keys match, because a mismatch would let
the chip label a different tab than the panel below it.

## Copy follows the Host language, through the slot's own mechanism

**Chosen:** one `ZH`/`EN` dictionary pair, a module `t()` that reads the active
dictionary, the panel registered with `locale: NS`, and a `locale.subscribe` that
swaps the dictionary before the Host's re-render.

**Rejected:** a plugin-side language switch, and React context threaded through
every helper.

The Host ships exactly two locales (`["zh", "en"]`) and owns the preference at
`settings.general.item` → id `language` → the first row of General. A second
switch inside this panel would let the tab say Chinese while its settings page said
English, so the only correct source is the Host's own value.

Two details make it work rather than merely compile:

1. `ctx.slots.installLocale(locale)` means slot occupants are re-rendered on a
   locale change, and registering a slot with `locale: <ns>` is what hands the
   component a bound `t`. Without the `locale` option the panel keeps rendering
   whatever dictionary it captured at boot.
2. Re-rendering is not enough on its own: the render reads a module-level
   dictionary, so a `locale.subscribe` swaps it first. The subscription is guarded
   by a `typeof` check, because a Host without it (and the activation test's fake)
   must not crash on a plugin that treats locale as optional.

Badge values are deliberately *not* translated. `open` and `in progress` are the
tracker's own identifiers — the strings `bd` prints — and a reader comparing the
panel against a terminal would be misled by 待办 in one place and `open` in the
other. Chrome is translated; data is not.

## Read the font size the Host actually writes, and never fix a text height

**Chosen:** one local base, `--bv-font: calc(var(--dsh-content-font-size, 14px) - 1px)`,
with every size in the panel expressed as a step from it; heights are `min-height`
derived from that base, never a fixed pixel value.

**Rejected:** `--dsh-content-font-size-secondary`, and fixed heights on badges and
chips.

Three problems stacked, and only the last was visible as "the font size does not
follow the theme":

1. `--dsh-content-font-size-secondary` is a *derived* token with a `min/max` clamp:
   `min(size - 1px, max(13px, size - 2px))`. Next to the default it is flat — 14px
   and 15px both yield 13px — so a one-step change in Settings moved nothing at
   all. The Host writes `--dsh-content-font-size` itself inline on `body`, which
   tracks every step exactly; the panel now derives from that.
2. `--dsh-code-font-size` is a separate setting ("代码字号"). Code blocks that
   inherited the prose size ignored it; they now use the code token.
3. Badges had `height: 18px` and chips `height: 24px`. After the size fix the text
   grew past those boxes and was **clipped** — a worse bug than the original,
   introduced by fixing the first one. Heights are now minimums computed from the
   base, and a test forbids any fixed `height` in the stylesheet.

The lesson recorded here: scaling a font means scaling the boxes around it, and a
derived token is not the same thing as the setting it was derived from.

**The guard test had to be written twice.** The first version scanned for
`height: <n>px` across the whole stylesheet. Reviewed honestly, that was wrong in
both directions: it could not see `height: 1.9rem`, `line-height: 15px` or a
clipping `max-height` (all of which clip exactly like the original bug), and it
rejected a decorative 1px separator that can never hold text. The version now in
the suite checks every rule for `height` / `line-height` / `max-height` in units
that do not follow the element's own font — `em` and `%` are allowed because they
scale — skips a `max-height` on a box that scrolls, and exempts only selectors
listed in an explicit `DECORATIVE` set. Adding a decorative box therefore costs
one deliberate line, which is the point: the failure message names the fix.

## Two hard rules replace per-badge colour judgement

**Chosen:** (a) no two badge fills that appear on the same row may sit closer than
ΔE 25 in Lab, and (b) label ink is computed from the fill's luminance — above
WCAG's black/white crossover (≈0.179) the text is black, below it the text is
white.

**Rejected:** choosing each colour and each ink colour individually.

Every colour complaint so far came from the same root: judgement instead of a rule.
`open`/`in_progress` (ΔE 18) and `P2`/`P3` (ΔE 25) were both reported by eye, and
when the first was fixed with `feature` still on indigo the same class of clash
remained at ΔE 5 — invisible to me in a screenshot of the palette, obvious in a
row. Ink had the same problem: with no rule, some badges were white-on-mid-tone and
some black, and a reader could not infer why.

The ΔE floor is cross-dimension on purpose, because status, priority and type share
one line; the check would have passed a within-dimension-only rule while the
reported clashes were between dimensions. Identical hues are allowed only where two
values mean the same thing (red for `blocked`/`P0`/`bug`, grey for `chore`/`closed`),
and the test asserts those exceptions are *exact* matches so the list cannot quietly
grow.

Two hues in the palette are literals rather than theme tokens — cyan for P3 and
fuchsia for `feature` — because the theme ships only six hue families and those two
values had no neighbour far enough away inside them.

## Fonts are inherited from the host, never declared as literals

**Chosen:** text uses `var(--dsh-font-family-text, var(--dsw-font-family, …))`, code
uses `var(--ds-font-family-code, …)`, and every `font-size` is an offset from
`var(--dsh-content-font-size-secondary)`.

**Rejected:** `var(--dsw-font-family)`, `var(--dsw-font-mono)`, and fixed px sizes.

Three separate mistakes lived in the first version, and only the last one was
visible as "the font does not follow the theme":

1. `--dsw-font-mono` **does not exist** in this harness. It was invented, so every
   monospace declaration silently resolved to its literal fallback — the panel's
   code and ids never matched the host's code font. The real token is
   `--ds-font-family-code`.
2. `--dsw-font-family` is set once by the theme and never changes. The appearance
   settings write `--dsh-font-family-text` instead, which is *absent* until a user
   picks a font — so the correct expression is nested: prefer the user's choice,
   fall back to the theme's stack.
3. Sizes were ten hardcoded px values. The host exposes one user-chosen text size
   and derives everything else from it, so the panel ignored Settings > Appearance
   > font size entirely. Expressing each size as a `calc()` offset from
   `--dsh-content-font-size-secondary` makes one setting scale the whole panel.

A test asserts no bare `font-family` and no literal `font-size` survives in the
stylesheet, because all three failures are invisible in a screenshot at the default
settings — they only show up for a user who changed something.

## Badges encode a dimension twice: hue for the value, shape for the dimension

**Chosen:** filled badges whose fill is a `--dsw-static-*` mid-tone, whose label
colour is chosen per fill, and whose corner radius and typeface identify which
dimension the badge belongs to (pill = status, sharp monospace = priority, soft
square = type).

**Rejected:** hue alone, and a single ink colour for every fill.

The theme ships five usable hue families (red, amber, green, blue, indigo) against
sixteen values across three dimensions, so hue alone cannot separate them — `in
progress` and `P1` both land on amber, side by side in the same row. Shape carries
the dimension so the same amber reads as "a warning priority" or "work in progress"
without asking the reader to look it up, and it survives greyscale and colour
blindness, which a hue-only scheme does not.

The label colour is per fill rather than one white ink: white on `green-500` is
2.28:1, unreadable. Each pair was picked by computing WCAG contrast, and
`test/render.test.mjs` recomputes it, so a future palette edit that drops below AA
fails the suite instead of shipping. Static mid-tones are identical in the light
and dark theme blocks (verified against the shipped CSS), which is what makes one
palette safe for both.

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
