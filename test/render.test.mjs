/**
 * Render checks with real React and real data.
 *
 * The component tree is the shipped one; only the transport and the slot seat
 * are supplied here. `renderToStaticMarkup` turns a crash, a hook-order defect
 * or a missing prop into a failing assertion, and the markup is asserted on the
 * content a user actually needs to see.
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
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => (captured = factory) } }
new Function('window', readFileSync(join(here, '..', 'client.js'), 'utf8'))(globalThis.window)
const mod = captured((request) => {
  if (request === 'react') return React
  throw new Error(`unexpected module: ${request}`)
})
const { Markdown, statusTone, priorityLabel, Badge, badgeFor, PRIORITY_BADGE, TYPE_BADGE, STATUS_BADGE, t, setLanguage, ZH, EN, BeadsTitle } =
  mod.__test

/**
 * WCAG relative luminance and contrast, so the badge palette is checked by
 * measurement rather than by eye.
 */
function luminance(hex) {
  const h = hex.replace('#', '')
  const channel = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** The literal fallback inside `var(--token, #hex)`. */
const fallbackHex = (value) => /#([0-9a-fA-F]{6})/.exec(value)[0]

const results = []
const test = (name, fn) => results.push({ name, fn })

const bin = await resolveBd()
assert.ok(bin, 'bd must be installed for the render check')

const workspace = await mkdtemp(join(tmpdir(), 'bv-render-'))
{
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync(bin, ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' })
  await writeFile(join(workspace, 'README.md'), '# readme')
  await writeFile(join(workspace, 'src-main.ts'), 'export {}')
  execFileSync(
    bin,
    [
      'create',
      'Render the panel end to end',
      '--description',
      [
        '# Heading',
        '',
        'Body with `src-main.ts:42` and `README.md` plus [link](https://example.com).',
        '',
        '| name | value |',
        '| --- | --- |',
        '| a | 1 |',
        '',
        '- first',
        '  - nested',
        '- second',
        '',
        '```ts',
        'const x = 1',
        '```',
        '',
        '> quoted text',
      ].join('\n'),
      '--type',
      'feature',
      '--priority',
      '0',
      '--label',
      'render',
    ],
    { cwd: workspace, stdio: 'ignore' },
  )
  const second = execFileSync(bin, ['q', 'Second issue'], { cwd: workspace, encoding: 'utf8' }).trim()
  const first = JSON.parse(
    execFileSync(bin, ['list', '--json', '-n', '0'], { cwd: workspace, encoding: 'utf8' }),
  ).find((issue) => issue.title === 'Render the panel end to end')
  execFileSync(bin, ['dep', 'add', second, first.id, '--type', 'blocks'], { cwd: workspace, stdio: 'ignore' })
  execFileSync(bin, ['comment', first.id, 'Mentions README.md and an issue ' + second], {
    cwd: workspace,
    stdio: 'ignore',
  })

  const existing = await checkFiles(workspace, ['README.md', 'src-main.ts', 'missing.md'])
  const exists = new Set(existing.filter((row) => row.exists).map((row) => row.path))
  const knownIds = new Set([first.id, second])

  /* ---------------------------------------------------------------------- */

  test('fonts come from the host tokens, not from literals', () => {
  // The panel is chrome inside the Harness UI. A literal font-family here would
  // ignore the user's choice in Settings > Appearance and look foreign beside
  // the host's own panels.
  const panel = mod.__test
  const css = readFileSync(join(here, '..', 'client.js'), 'utf8')
  const sheet = /const CSS = `([\s\S]*?)`\s*\n/.exec(css)[1]

  // Text follows the user's text font; when unset, the theme's own stack.
  assert.match(sheet, /font-family:var\(--dsh-font-family-text,/, 'the text face must follow the appearance setting')

  // Code follows the code font. `--dsw-font-mono` does not exist in this harness;
  // the real token is `--ds-font-family-code`.
  assert.doesNotMatch(sheet, /--dsw-font-mono/, '--dsw-font-mono is not a token this harness defines')
  assert.match(sheet, /var\(--ds-font-family-code,/, 'the code face must use the code-font token')

  // Every non-mono family declaration resolves to a token, never a bare stack.
  for (const match of sheet.matchAll(/font-family:([^;}]+)/g)) {
    const value = match[1].trim()
    if (value === 'inherit') continue
    assert.match(value, /^var\(--/, `bare font-family is not allowed: ${value}`)
  }
})

test('the panel scales with the host font-size setting', () => {
  const css = readFileSync(join(here, '..', 'client.js'), 'utf8')
  const sheet = /const CSS = `([\s\S]*?)`\s*\n/.exec(css)[1]

  // A fixed px size means the panel ignores Settings > Appearance > font size.
  // Sizes are expressed relative to the host's own content size instead.
  const literals = [...sheet.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1])
  assert.deepEqual(literals, [], `font-size must derive from the host setting, found ${literals}`)
  // The base comes from the variable the Host writes inline on <body> for the
  // user's text size. `--dsh-content-font-size-secondary` is a derived token with
  // a min/max clamp that flattens neighbouring steps (14px and 15px both yield
  // 13px), so a one-step change moved nothing — which is what was reported.
  assert.match(
    sheet,
    /--bv-font:\s*calc\(var\(--dsh-content-font-size/,
    'the panel base must derive from the host content-size variable',
  )
  assert.doesNotMatch(sheet, /--dsh-content-font-size-secondary/, 'the clamped derived token must not be used')
  // Every size must step from that one base, or one setting change moves only part
  // of the panel.
  for (const match of sheet.matchAll(/font-size:([^;}]+)/g)) {
    const value = match[1].trim()
    assert.ok(
      value === 'var(--bv-font)' ||
        value.startsWith('calc(var(--bv-font)') ||
        value.startsWith('var(--dsh-code-font-size'),
      `font-size must step from the panel base or the code token, found: ${value}`,
    )
  }
})

test('a box that renders text cannot pin it to a height the font can outgrow', () => {
  // The bug was `height: 18px` on a badge, which clipped its label once the text
  // size grew. Banning pixel heights sheet-wide would be wrong in both directions:
  // it says nothing about `height: 1.9rem`, a `line-height: 15px` or a clipping
  // `max-height`, and it rejects a decorative 1px separator that can never hold
  // text. So: every rule is checked unless it is declared decorative, and the
  // units that matter are the ones that do NOT follow the element's own font.
  //
  // `em` and `%` are allowed (they resolve against the font or the container);
  // `px`, `rem`, `pt` and physical units are refused, because a box pinned to
  // those is outgrown by larger text.
  // Units that do not follow the element's own font. `%` is included on purpose:
  // it resolves against the containing block, which `--bv-font` does not size, so
  // `.bv-badge{height:100%}` inside a fixed-height row clips exactly like the
  // original `18px` did. `em` is the one allowed unit, because it resolves against
  // the element's own font.
  const ABSOLUTE = /^-?[0-9.]+(px|rem|pt|pc|cm|mm|in|q)$/i
  const PERCENT = /^[0-9.]+%$/

  // Rules that draw a shape and never render a glyph. Anything added here is a
  // claim that the box cannot clip text; keep it to dots, rules and spinners.
  const DECORATIVE = new Set(['.bv-dot'])

  // Containers that fill the Host pane and scroll their own content. `height:100%`
  // is the correct idiom for these — the text lives in a scrolling child — so
  // percentage is refused everywhere else rather than trusted wholesale.
  const FILLS_PANE = new Set(['.bv-root', '.bv-listview', '.bv-detailview'])

  const sheet = /const CSS = `([\s\S]*?)`\s*\n/.exec(readFileSync(join(here, '..', 'client.js'), 'utf8'))[1]
  const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => {
    const declarations = {}
    for (const piece of body.split(';')) {
      const cut = piece.indexOf(':')
      if (cut === -1) continue
      declarations[piece.slice(0, cut).trim().toLowerCase()] = piece.slice(cut + 1).trim()
    }
    // Split grouped selectors: `.bv-sep, .bv-dot{...}` must not be exempted just
    // because the raw string is not in the set, and must not be skipped just
    // because part of it is.
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean)
    return { selector: selector.trim(), selectors, declarations }
  })
  assert.ok(rules.length > 40, 'the stylesheet should parse into rules')

  const offences = []
  for (const { selector, selectors, declarations } of rules) {
    // Only a rule whose every selector is decorative may claim it cannot hold
    // text; a mixed group still renders text through its non-decorative half.
    if (selectors.length > 0 && selectors.every((part) => DECORATIVE.has(part))) continue
    const fillsPane = selectors.length > 0 && selectors.every((part) => FILLS_PANE.has(part))
    // A box allowed to scroll keeps its content reachable, so a maximum height is
    // a layout choice rather than a clip.
    const scrolls = /(auto|scroll)/.test(declarations.overflow ?? '') || /(auto|scroll)/.test(declarations['overflow-y'] ?? '')
    for (const property of ['height', 'line-height', 'max-height']) {
      const value = declarations[property]
      if (value === undefined) continue
      if (property === 'max-height' && scrolls) continue
      if (fillsPane && PERCENT.test(value)) continue
      if (ABSOLUTE.test(value) || PERCENT.test(value)) offences.push(`${selector} { ${property}: ${value} }`)
    }
  }
  assert.deepEqual(
    offences,
    [],
    'text can be clipped by these font-independent heights. Use a minimum derived from\n' +
      '--bv-font, a unitless line-height, or em; and if the box never holds text, add\n' +
      `its selector to DECORATIVE above:\n${offences.join('\n')}`,
  )
})

test('the boxes that hold text size themselves from the panel font', () => {
  // The positive half of the rule above: these elements each used to carry a
  // font-independent height, so each must still resolve its height against the
  // font. Without this, deleting the declaration outright would satisfy the
  // clipping test while letting the box collapse onto its own text.
  const sheet = /const CSS = `([\s\S]*?)`\s*\n/.exec(readFileSync(join(here, '..', 'client.js'), 'utf8'))[1]
  const bodies = new Map()
  for (const [, selector, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    bodies.set(selector.trim(), body)
  }

  // Boxes that were `height: <n>px`: the minimum must be a multiple of the base.
  for (const selector of ['.bv-badge', '.bv-chip', '.bv-action', '.bv-iconbtn', '.bv-sort', '.bv-search']) {
    const body = bodies.get(selector)
    assert.ok(body !== undefined, `${selector} must still be in the stylesheet`)
    assert.match(
      body,
      /min-height:\s*(calc\(var\(--bv-font\)|\d*\.?\d+em)/,
      `${selector} must take its minimum height from the panel font, found: ${body.slice(0, 100)}`,
    )
  }

  // `.bv-ready` was `line-height: 15px`: a unitless ratio is what makes it follow
  // the font instead of clipping it.
  const ready = bodies.get('.bv-ready')
  assert.ok(ready !== undefined, '.bv-ready must still be in the stylesheet')
  assert.match(ready, /line-height:\s*[0-9.]+\s*(;|$)/, 'a unitless line-height follows the font')
})

test('the Chinese dictionary covers every English key with the same placeholders', () => {
  // The Host only ships "zh" and "en", and a missing key falls back to the key
  // itself — which shows up as `filterReady` in the UI rather than as an error. A
  // placeholder that exists in one language only would render a literal `{n}`.
  assert.deepEqual(
    Object.keys(ZH).sort(),
    Object.keys(EN).sort(),
    'both dictionaries must define the same keys',
  )
  for (const key of Object.keys(EN)) {
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    assert.deepEqual(
      placeholders(ZH[key]),
      placeholders(EN[key]),
      `${key} must use the same placeholders in both languages`,
    )
  }
})

test('switching the language changes the copy the panel renders', () => {
  // The point of the dictionaries is that the Host's Language setting reaches the
  // screen. Rendering the same tree twice is the cheapest honest proof.
  setLanguage('en')
  const english = renderToStaticMarkup(React.createElement(Markdown, { source: 'x' }))
  assert.equal(typeof english, 'string')
  assert.equal(t('search'), 'Search issues…  ( / )')
  assert.equal(t('shown', { n: 3 }), '3 shown')

  setLanguage('zh')
  assert.equal(t('search'), '搜索议题…  ( / )')
  assert.equal(t('shown', { n: 3 }), '共 3 条')
  assert.equal(t('waitingOn', { n: 2 }), '等待 2 项')

  setLanguage('en')
  assert.equal(t('waitingOn', { n: 2 }), 'waiting on 2')
})

test('the tab chip renders a glyph beside its title', () => {
  // The start-list entry gets its icon from `guide[].icon`; the open tab is a
  // different seat (`sidebar.right.pane.tab.title`) and had no glyph until it was
  // contributed. This asserts the chip really draws one, not just text.
  setLanguage('en')
  const markup = renderToStaticMarkup(
    React.createElement(BeadsTitle, {
      useTabInfo: () => ({ tab: { title: 'Beads' } }),
    }),
  )
  assert.match(markup, /<svg/, 'the chip must draw the glyph')
  assert.match(markup, /bv-titleicon/, 'the glyph needs its own flex-none wrapper')
  assert.match(markup, /Beads/, 'the chip must still show the title')

  // Without a tab record it still renders rather than throwing.
  const bare = renderToStaticMarkup(React.createElement(BeadsTitle, {}))
  assert.match(bare, /<svg/)
  assert.match(bare, /Beads/)
})

test('rows are plain at rest and tinted only under the pointer', () => {
  // Requested: the highlight marks the row you are about to click, so a resting
  // row must stay uncoloured. This asserts both halves — tint on hover, none
  // otherwise — because tinting every row makes the signal meaningless.
  const rawSheet = /const CSS = `([\s\S]*?)`\s*\n/.exec(readFileSync(join(here, '..', 'client.js'), 'utf8'))[1]
  // Strip comments before parsing, not after matching: a comment that precedes a
  // rule otherwise becomes part of the "selector" and the rule is missed.
  const sheet = rawSheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector) => {
    for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sel.trim() === selector) return body
    }
    return undefined
  }

  const row = rule('.bv-row')
  assert.ok(row !== undefined, '.bv-row must exist')
  // No background declaration at all is also correct: the row simply inherits the
  // panel surface. Either way it must not be tinted.
  assert.doesNotMatch(row, /background(-color)?:\s*color-mix/, 'a resting row must not be tinted')

  const hover = rule('.bv-row:hover')
  assert.ok(hover !== undefined, '.bv-row:hover must exist')
  assert.match(hover, /background:\s*color-mix\(/, 'hover must tint the row')
  assert.match(hover, /var\(--bv-teal\)/, 'the tint must come from the one accent variable')
  assert.doesNotMatch(hover, /#[0-9a-f]{6}/i, 'no fixed colour on the hover surface')

  // One accent declaration keeps the border and the wash in step.
  assert.match(sheet, /--bv-teal:\s*#[0-9a-f]{6}/i, 'the accent must be declared as one variable')
})

test('a row is three line boxes tall, whatever its content', () => {
  // Requested twice: fixed three-line rows, and the height expressed as
  // line-height x 3 rather than a pixel constant or a font-size multiple. `1lh`
  // resolves to the element's own line-height, so this follows the text metrics.
  const raw = /const CSS = `([\s\S]*?)`\s*\n/.exec(readFileSync(join(here, '..', 'client.js'), 'utf8'))[1]
  const sheet = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector) => {
    for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sel.trim() === selector) return body
    }
    return undefined
  }

  const row = rule('.bv-row')
  assert.ok(row !== undefined, '.bv-row must exist')

  // The height must be three line boxes.
  assert.match(row, /height:\s*calc\(\s*3\s*\*\s*1lh/, 'the row height must be 3lh')
  // And no pixel height may compete with it.
  assert.doesNotMatch(row, /(?:^|;)\s*height:\s*[0-9.]+px/, 'no pixel height on the row')
  // The line-height must be a ratio, or `1lh` would not scale with the font.
  assert.match(row, /line-height:\s*var\(--bv-line\)/, 'the row must take its line-height from one variable')
  assert.match(sheet, /--bv-line:\s*[0-9.]+\s*(;|$)/, 'that variable must be a unitless ratio')
  // Three equal tracks, so the three lines split the height evenly.
  assert.match(row, /grid-template-rows:\s*repeat\(\s*3\s*,/, 'three equal tracks')

  // Content must not be able to change the height.
  for (const selector of ['.bv-row-top', '.bv-row-meta', '.bv-row-labels']) {
    const body = rule(selector)
    assert.ok(body !== undefined, `${selector} must exist`)
    assert.doesNotMatch(body, /(?:^|;)\s*height:\s*[0-9.]+px/, `${selector} must not pin a pixel height`)
  }

  // The title stays on one line and ellipsizes; a clamp would reintroduce variety.
  const title = rule('.bv-row-title')
  assert.match(title, /text-overflow:\s*ellipsis/, 'the title must ellipsize')
  assert.match(title, /white-space:\s*nowrap/, 'the title must stay on one line')
  assert.doesNotMatch(title, /-webkit-line-clamp/, 'a line clamp would make rows uneven')

  // The badge line must not wrap into a second line.
  assert.match(rule('.bv-row-meta'), /flex-wrap:\s*nowrap/, 'the badge line must not wrap')

  // The label track is rendered unconditionally so label-less issues keep 3 tracks.
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  assert.doesNotMatch(
    source,
    /issue\.labels\.length > 0\s*\?\s*h\(/,
    'the label row must not be conditional, or label-less rows lose a track',
  )
})

test('secondary content blocks carry a faint wash, and it does not stack', () => {
  // Requested: non-description blocks (Design, Notes, Comments) should have a faint
  // background so the description stays primary. A literal gray-50 cannot do that —
  // it is theme-invariant and leaves light text at 1.0:1 on the dark surface — so
  // the wash is mixed from the panel accent instead.
  const raw = /const CSS = `([\s\S]*?)`\s*\n/.exec(readFileSync(join(here, '..', 'client.js'), 'utf8'))[1]
  const sheet = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector) => {
    for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sel.trim() === selector) return body
    }
    return undefined
  }

  const section = rule('.bv-section')
  assert.ok(section !== undefined, '.bv-section must exist')
  assert.match(section, /background:\s*color-mix\(/, 'a secondary section must be washed')
  assert.match(section, /var\(--bv-teal\)/, 'the wash must come from the panel accent')
  assert.doesNotMatch(section, /#[0-9a-f]{6}/i, 'no fixed colour: it would break one theme')

  // The description itself must NOT be washed, or nothing reads as primary.
  const md = rule('.bv-md')
  assert.ok(md !== undefined, '.bv-md must exist')
  assert.doesNotMatch(md, /background:\s*color-mix/, 'the description must stay unwashed')

  // A comment sits inside the (already washed) comments section; tinting it again
  // doubled the wash and made the thread heavier than the description.
  const comment = rule('.bv-comment')
  assert.ok(comment !== undefined, '.bv-comment must exist')
  assert.match(comment, /background:\s*transparent/, 'a comment must not re-tint the section wash')
  assert.match(comment, /border:/, 'a comment still needs a border to stay separable')
})

test('the description has its own inset without double-padding the sections', () => {
  // Requested: a little more padding around the description so it separates from the
  // blocks below. The padding must live on a wrapper, not on `.bv-md` — sections
  // render their own `.bv-md` inside padding they already have, so a shared rule
  // would inset those twice.
  const raw = /const CSS = `([\s\S]*?)`\s*\n/.exec(readFileSync(join(here, '..', 'client.js'), 'utf8'))[1]
  const sheet = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector) => {
    for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sel.trim() === selector) return body
    }
    return undefined
  }

  const description = rule('.bv-description')
  assert.ok(description !== undefined, 'the description needs its own wrapper')
  const padding = /padding:\s*([0-9.]+)px\s+([0-9.]+)px/.exec(description)
  assert.ok(padding, 'the description must declare a padding')
  assert.ok(Number(padding[1]) >= 10, `vertical padding too small: ${padding[1]}px`)
  assert.ok(Number(padding[2]) >= 12, `horizontal padding too small: ${padding[2]}px`)

  // `.bv-md` is shared with every section; it must stay padding-free.
  const md = rule('.bv-md')
  assert.ok(md !== undefined, '.bv-md must exist')
  assert.doesNotMatch(md, /(?:^|;)\s*padding:/, 'padding on .bv-md would double-inset section content')

  // The markup must actually wrap the description, or the rule never applies.
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  assert.match(
    source,
    /'bv-description'[\s\S]{0,120}?Markdown/,
    'the description must be rendered inside its wrapper',
  )
})

test('every badge fill is legible against its own label colour', () => {
  // AA for normal text is 4.5:1. A filled badge with an unreadable label is
  // worse than the outline chip it replaced, so this is a hard floor.
  for (const [name, table] of Object.entries({ PRIORITY_BADGE, TYPE_BADGE, STATUS_BADGE })) {
    for (const [value, pair] of Object.entries(table)) {
      const ratio = contrast(fallbackHex(pair.bg), pair.ink)
      assert.ok(ratio >= 4.5, `${name}.${value} contrast ${ratio.toFixed(2)} is below 4.5`)
    }
  }
})

test('ink is derived from luminance: light fill takes black, dark fill takes white', () => {
  // One rule, applied to every badge. Before this the ink was chosen per badge by
  // eye, so the panel mixed white text on mid-tones with black on others and
  // there was no reason a reader could infer.
  const CROSSOVER = Math.sqrt(0.05 * 1.05) - 0.05 // where black == white
  for (const [name, table] of Object.entries({ PRIORITY_BADGE, TYPE_BADGE, STATUS_BADGE })) {
    for (const [value, pair] of Object.entries(table)) {
      const light = luminance(fallbackHex(pair.bg)) > CROSSOVER
      const expected = light ? '#0f0f0f' : '#ffffff'
      assert.equal(
        pair.ink.toLowerCase(),
        expected,
        `${name}.${value} is ${light ? 'light' : 'dark'} and must use ${expected}, got ${pair.ink}`,
      )
    }
  }
})

test('in_progress is far enough from open, and P3 from P2, to read as different colours', () => {
  // Reported by eye: open/in_progress and P2/P3 looked like the same colour.
  // Compare in Lab, where ~10 is "just noticeable" and 25+ is clearly distinct.
  const lab = (hexValue) => {
    const h = hexValue.replace('#', '')
    const toLinear = (i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const [r, g, b] = [toLinear(0), toLinear(2), toLinear(4)]
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const [fx, fy, fz] = [f(x), f(y), f(z)]
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const deltaE = (a, b) => {
    const [l1, a1, b1] = lab(a)
    const [l2, a2, b2] = lab(b)
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
  }

  const distance = (table, left, right) =>
    deltaE(fallbackHex(table[left].bg), fallbackHex(table[right].bg))

  assert.ok(distance(STATUS_BADGE, 'open', 'in_progress') >= 40, 'open and in_progress must not look alike')
  assert.ok(distance(PRIORITY_BADGE, 2, 3) >= 40, 'P2 and P3 must not look alike')
  // And in_progress must not simply collide with P1's amber instead.
  assert.ok(
    deltaE(fallbackHex(STATUS_BADGE.in_progress.bg), fallbackHex(PRIORITY_BADGE[1].bg)) >= 25,
    'in_progress must stay distinguishable from P1',
  )
})

test('no two badges that sit side by side on a row are near-identical colours', () => {
  // Reported twice by eye ("open and in_progress are too close", "P2 and P3 are
  // too close"), both times for a pair that appears in the same row. The check is
  // therefore cross-dimension: status vs priority vs type all share one line.
  const lab = (hexValue) => {
    const h = hexValue.replace('#', '')
    const toLinear = (i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const [r, g, b] = [toLinear(0), toLinear(2), toLinear(4)]
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const [fx, fy, fz] = [f(x), f(y), f(z)]
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const deltaE = (a, b) => {
    const [l1, a1, b1] = lab(a)
    const [l2, a2, b2] = lab(b)
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
  }

  const all = []
  for (const [dimension, table] of Object.entries({ status: STATUS_BADGE, priority: PRIORITY_BADGE, type: TYPE_BADGE })) {
    for (const [value, pair] of Object.entries(table)) {
      all.push({ label: `${dimension}:${value}`, hex: fallbackHex(pair.bg) })
    }
  }

  // Two badges deliberately share a hue because they mean the same thing:
  // "urgent/broken" is red for a blocked status, a P0 priority and a bug type,
  // and "inert" is grey for closed work. Sharing a hue across dimensions is
  // defensible; sharing one *within* a dimension is not, and that is asserted
  // separately. Anything else must be distinguishable at a glance.
  const SAME_MEANING = [
    // red = "urgent or broken"
    ['status:blocked', 'priority:0'],
    ['status:blocked', 'type:bug'],
    ['priority:0', 'type:bug'],
    // grey = "inert"
    ['status:closed', 'type:chore'],
    ['priority:4', 'status:deferred'],
  ]
  const exempt = new Set(SAME_MEANING.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))

  // ~25 in Lab is comfortably "different colour"; below that a reader has to
  // compare labels rather than glance at the hue, which defeats the badges.
  const tooClose = []
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const key = `${all[i].label}|${all[j].label}`
      if (exempt.has(key)) {
        // An exemption is only allowed to cover an exact hue match.
        const distance = deltaE(all[i].hex, all[j].hex)
        assert.ok(distance < 1, `${all[i].label} and ${all[j].label} are declared the same meaning but differ (dE ${distance.toFixed(1)})`)
        continue
      }
      const distance = deltaE(all[i].hex, all[j].hex)
      if (distance < 25) tooClose.push(`${all[i].label} ~ ${all[j].label} (dE ${distance.toFixed(1)})`)
    }
  }
  assert.deepEqual(tooClose, [], `badge colours too close to tell apart:\n${tooClose.join('\n')}`)
})

test('no two values inside one dimension share a fill', () => {
  // A shared hue inside a dimension would mean two different priorities looked
  // identical, which defeats the point of colouring them.
  for (const [name, table] of Object.entries({ PRIORITY_BADGE, TYPE_BADGE, STATUS_BADGE })) {
    const fills = Object.values(table).map((pair) => pair.bg)
    assert.equal(new Set(fills).size, fills.length, `${name} repeats a fill`)
  }
})

test('the three dimensions are told apart by shape as well as hue', () => {
  // Only a handful of hue families exist, so status and priority can both land
  // on amber. The radius and typeface must differ so the dimensions stay
  // distinguishable in greyscale and for a colour-blind reader.
  const html = (kind, value) => renderToStaticMarkup(React.createElement(Badge, { kind, value }, String(value)))
  assert.match(html('status', 'open'), /bv-badge-status/)
  assert.match(html('priority', 1), /bv-badge-priority/)
  assert.match(html('type', 'bug'), /bv-badge-type/)
  assert.match(html('status', 'open'), /border-radius|background/, 'the badge is filled, not outlined')
  assert.match(html('priority', 1), /background:#?|background:rgb/)
})

test('a badge for an unknown value degrades to the outline chip', () => {
  assert.equal(badgeFor('type', 'nonexistent-type'), undefined)
  const html = renderToStaticMarkup(React.createElement(Badge, { kind: 'type', value: 'weird' }, 'weird'))
  assert.match(html, /class="bv-badge"/)
  assert.doesNotMatch(html, /bv-badge-solid/, 'an unmapped value must not get an invented colour')
})

test('a path in prose and a path in code both become links when the file exists', () => {
  const exists = new Set(['package.json', 'scripts/probes/pe_cost.py'])
  const ctx = { exists, knownIds: new Set(), onFile: () => {}, onIssue: () => {} }
  const prose = renderToStaticMarkup(
    React.createElement(Markdown, { text: 'Run package.json and scripts/probes/pe_cost.py today.', ctx }),
  )
  assert.match(prose, /class="bv-filelink"/, 'a prose path that exists is a link')

  const code = renderToStaticMarkup(
    React.createElement(Markdown, { text: 'Edit `scripts/probes/pe_cost.py:12` next.', ctx }),
  )
  assert.match(code, /bv-code-link/, 'a code span holding a real file is a link')
  assert.match(code, /:12/, 'the line number is kept')

  const missing = renderToStaticMarkup(
    React.createElement(Markdown, { text: 'Gone: `removed/file.py` and removed/file.py.', ctx }),
  )
  assert.doesNotMatch(missing, /bv-filelink|bv-code-link/, 'a path that does not exist stays plain text')
})

test('Markdown renders headings, code, tables, nested lists and quotes', () => {
    const out = renderToStaticMarkup(
      React.createElement(Markdown, {
        text: [
          '# Heading',
          '',
          'Body with `README.md` and **bold** and [link](https://example.com).',
          '',
          '| name | value |',
          '| --- | --- |',
          '| a | 1 |',
          '',
          '- first',
          '  - nested',
          '- second',
          '',
          '```ts',
          'const x = 1',
          '```',
          '',
          '> quoted text',
        ].join('\n'),
        ctx: { exists, knownIds, onFile: () => {}, onIssue: () => {} },
      }),
    )
    assert.match(out, /<h3 class="bv-h bv-h1">Heading<\/h3>/)
    assert.match(out, /<code class="bv-code bv-code-link"[^>]*>README\.md<\/code>/)
    assert.match(out, /<strong>bold<\/strong>/)
    assert.match(out, /href="https:\/\/example\.com"/)
    assert.match(out, /<table class="bv-table">/)
    assert.match(out, /<th>name<\/th>/)
    assert.match(out, /<ul class="bv-mlist">/)
    assert.match(out, /bv-mlist-nested/)
    assert.match(out, /<pre class="bv-pre">/)
    assert.match(out, /<blockquote class="bv-quote">/)
  })

  test('paths the workspace does not have stay plain text', () => {
    const out = renderToStaticMarkup(
      React.createElement(Markdown, {
        text: 'Open `missing.md` and `README.md`.',
        ctx: { exists, knownIds, onFile: () => {}, onIssue: () => {} },
      }),
    )
    assert.match(out, /<code class="bv-code">missing\.md<\/code>/)
    assert.match(out, /bv-code-link[^>]*>README\.md</)
  })

  test('a known issue id becomes a link and an unknown one does not', () => {
    const out = renderToStaticMarkup(
      React.createElement(Markdown, {
        text: `Fix ${second} after ${first.id} but not nope-zzzz.`,
        ctx: { exists, knownIds, onFile: () => {}, onIssue: () => {} },
      }),
    )
    assert.match(out, new RegExp(`bv-issuelink[^>]*>${second}<`))
    assert.match(out, new RegExp(`bv-issuelink[^>]*>${first.id}<`))
    assert.doesNotMatch(out, /bv-issuelink[^>]*>nope-zzzz</)
  })

  test('a bare path with a line suffix keeps the suffix visible', () => {
    const out = renderToStaticMarkup(
      React.createElement(Markdown, {
        text: 'see src-main.ts:42 for details',
        ctx: { exists, knownIds, onFile: () => {}, onIssue: () => {} },
      }),
    )
    assert.match(out, /bv-filelink/)
    assert.match(out, /src-main\.ts/)
    assert.match(out, /bv-fileline">:42</)
  })

  test('task list items render a checkbox', () => {
    const out = renderToStaticMarkup(
      React.createElement(Markdown, {
        text: '- [x] done\n- [ ] todo',
        ctx: { exists, knownIds, onFile: () => {}, onIssue: () => {} },
      }),
    )
    assert.equal((out.match(/<input/g) ?? []).length, 2)
    assert.match(out, /checked=""/)
  })

  test('status tones and priority labels are stable vocabulary', () => {
    assert.match(statusTone('blocked'), /state-error/)
    assert.match(statusTone('in_progress'), /brand-primary/)
    assert.equal(priorityLabel(0), 'P0')
    assert.equal(priorityLabel(4), 'P4')
    assert.equal(priorityLabel(9), 'P9')
  })

  test('the live Host payload drives the rendered Markdown with real data', async () => {
    const detail = await readIssue({ cwd: workspace, bin, id: first.id })
    assert.equal(detail.ok, true, JSON.stringify(detail).slice(0, 300))
    const out = renderToStaticMarkup(
      React.createElement(Markdown, {
        text: detail.issue.description,
        ctx: { exists, knownIds, onFile: () => {}, onIssue: () => {} },
      }),
    )
    assert.match(out, /Heading/)
    assert.match(out, /<table class="bv-table">/)
    assert.match(out, /README\.md/)
  })

  test('the overview lists both issues with counts', async () => {
    const overview = await readOverview({ cwd: workspace, bin })
    assert.equal(overview.ok, true)
    const titles = overview.issues.map((issue) => issue.title)
    assert.ok(titles.includes('Render the panel end to end'))
    assert.ok(titles.includes('Second issue'))
    assert.equal(overview.counts.total, 2)
  })
}

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
console.log(`\n${results.length - failed}/${results.length} passed`)
await rm(workspace, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
