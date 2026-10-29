/**
 * Client-half checks for the pure Markdown/path helpers.
 *
 * The browser bundle registers itself through `window.__ModuleLoader__`, so this
 * harness supplies that one global, materialises the factory, and calls the
 * exported `__test` seam. No DOM and no React rendering is involved — those are
 * verified in place by the running panel.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let captured
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}

// Minimal React stand-in: element creation only, so `__test` can be built.
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useMemo: (fn) => fn(),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)
assert.ok(captured, 'the bundle must register itself through window.__ModuleLoader__')
assert.equal(captured.id, 'dsh-beads-viewer')

const moduleExports = captured.factory((request) => {
  if (request === 'react') return fakeReact
  throw new Error(`unexpected module request: ${request}`)
})

const { parseBlocks, extractPaths, splitPathToken, fileAddress, relativeTime } = moduleExports.__test

const results = []
const test = (name, fn) => results.push({ name, fn })

/* -------------------------------------------------------------------------- */
/* parseBlocks                                                                */
/* -------------------------------------------------------------------------- */

test('headings carry their depth and text', () => {
  const blocks = parseBlocks('# One\n\n### Three')
  assert.deepEqual(
    blocks.map((block) => [block.type, block.depth, block.text]),
    [
      ['heading', 1, 'One'],
      ['heading', 3, 'Three'],
    ],
  )
})

test('fenced code keeps its language and body verbatim', () => {
  const blocks = parseBlocks('```ts\nconst a = 1\n  indented\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].lang, 'ts')
  assert.equal(blocks[0].text, 'const a = 1\n  indented')
})

test('an unterminated fence still closes at the end of input', () => {
  const blocks = parseBlocks('```\nopen')
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].text, 'open')
})

test('a table needs a separator row and keeps cells', () => {
  const blocks = parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'table')
  assert.deepEqual(blocks[0].header, ['a', 'b'])
  assert.deepEqual(blocks[0].rows, [
    ['1', '2'],
    ['3', '4'],
  ])
})

test('a pipe line without a separator stays a paragraph', () => {
  const blocks = parseBlocks('a | b | c')
  assert.equal(blocks[0].type, 'paragraph')
})

test('unordered and ordered lists keep their kind and items', () => {
  const unordered = parseBlocks('- one\n- two')
  assert.equal(unordered[0].type, 'list')
  assert.equal(unordered[0].ordered, false)
  assert.equal(unordered[0].items.length, 2)

  const ordered = parseBlocks('1. first\n2. second')
  assert.equal(ordered[0].ordered, true)
  assert.equal(ordered[0].items[1].text, 'second')
})

test('a blank line inside a list does not split it when a bullet follows', () => {
  const blocks = parseBlocks('- one\n\n- two')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].items.length, 2)
})

test('an indented continuation line belongs to its item', () => {
  const blocks = parseBlocks('- first line\n  second line')
  assert.equal(blocks[0].items[0].text, 'first line\nsecond line')
})

test('block quotes nest their own blocks', () => {
  const blocks = parseBlocks('> quoted **bold**\n> still quote')
  assert.equal(blocks[0].type, 'quote')
  assert.equal(blocks[0].blocks[0].type, 'paragraph')
})

test('thematic breaks and paragraphs are recognized', () => {
  const blocks = parseBlocks('text\n\n---\n\nmore')
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'hr', 'paragraph'],
  )
})

test('a paragraph stops at the next block start', () => {
  const blocks = parseBlocks('line one\nline two\n# heading')
  assert.equal(blocks[0].type, 'paragraph')
  assert.equal(blocks[0].text, 'line one\nline two')
  assert.equal(blocks[1].type, 'heading')
})

test('empty and whitespace-only input produce no blocks', () => {
  assert.deepEqual(parseBlocks(''), [])
  assert.deepEqual(parseBlocks('\n\n  \n'), [])
})

test('CRLF input is normalized', () => {
  const blocks = parseBlocks('# a\r\n\r\nbody')
  assert.equal(blocks[0].text, 'a')
  assert.equal(blocks[1].text, 'body')
})

/* -------------------------------------------------------------------------- */
/* path extraction                                                            */
/* -------------------------------------------------------------------------- */

test('splitPathToken separates an inline line range', () => {
  assert.deepEqual(splitPathToken('server/pool.ts:124-133'), { path: 'server/pool.ts', line: 124 })
  assert.deepEqual(splitPathToken('index.js'), { path: 'index.js', line: undefined })
  assert.deepEqual(splitPathToken('./a/b/c.py:9'), { path: 'a/b/c.py', line: 9 })
})

test('extractPaths finds nested and bare paths, deduped, without line suffixes', () => {
  const text = 'See server/services/poolSnapshot.ts:124-133 and also `notes.md` plus server/services/poolSnapshot.ts.'
  const paths = extractPaths(text)
  assert.deepEqual(paths, ['server/services/poolSnapshot.ts', 'notes.md'])
})

test('extractPaths finds a path that opens the body', () => {
  // A body whose first token is a path used to yield nothing, because the
  // boundary needed a preceding character.
  assert.deepEqual(extractPaths('src/main.ts is the entry point'), ['src/main.ts'])
})

test('extractPaths never slices a path out of the middle of a word', () => {
  const paths = extractPaths('blahxmysrc/main.ts and foo=src/main.ts')
  assert.deepEqual(paths, ['blahxmysrc/main.ts', 'src/main.ts'])
})

test('extractPaths finds a path after a bullet or inside brackets', () => {
  assert.deepEqual(extractPaths('- src/main.ts'), ['src/main.ts'])
  assert.deepEqual(extractPaths('(src/y.ts)'), ['src/y.ts'])
  assert.deepEqual(extractPaths('`docs/x.md`'), ['docs/x.md'])
})

test('extractPaths keeps the longest extension', () => {
  // The alternation is ordered: `js` before `json` would truncate these.
  assert.deepEqual(extractPaths('read package.json now'), ['package.json'])
  assert.deepEqual(extractPaths('edit config.jsonl'), ['config.jsonl'])
  assert.deepEqual(extractPaths('data.csv is fine'), ['data.csv'])
  assert.deepEqual(extractPaths('see app.yaml and app.yml'), ['app.yaml', 'app.yml'])
})

test('extractPaths does not mistake a property access for a file', () => {
  // `ctx.capTruncated` is code, not a path.
  assert.deepEqual(extractPaths('see ctx.capTruncated here'), [])
  assert.deepEqual(extractPaths('row.depends_on_id is a column'), [])
})

test('extractPaths never offers a URL as a local path', () => {
  assert.deepEqual(extractPaths('see https://example.com/a/b.ts here'), [])
  assert.deepEqual(extractPaths('see http://x.io/src/y.py'), [])
})

test('extractPaths ignores prose that is not file-shaped', () => {
  assert.deepEqual(extractPaths('nothing to see here, version 1.2.3 only'), [])
})

test('extractPaths caps a pathological blob', () => {
  const blob = Array.from({ length: 400 }, (_, index) => `src/file${index}.ts`).join(' ')
  assert.equal(extractPaths(blob).length, 200)
})

/* -------------------------------------------------------------------------- */
/* addresses and formatting                                                   */
/* -------------------------------------------------------------------------- */

test('fileAddress percent-encodes every path segment', () => {
  assert.equal(
    fileAddress('sess-1', 'a b/c#d.ts'),
    'dsh-resource://file/session/sess-1/a%20b/c%23d.ts',
  )
})

test('fileAddress keeps a drive letter colon literal', () => {
  assert.equal(fileAddress('s', 'C:/x/y.ts'), 'dsh-resource://file/session/s/C:/x/y.ts')
})

test('fileAddress round-trips through the shipped sidebar parser', () => {
  // Copied verbatim from
  // @deepseek-ai/dsh-client-ui-sidebar-documentpreview (parseFileAddress).
  // Requirement "click a file in the issue" rests entirely on this: an address
  // the sidebar cannot parse opens nothing.
  const parse = (address) => {
    try {
      if (!address.startsWith('dsh-resource://file/')) return undefined
      const end = address.search(/[?#]/)
      const [scope, ...rest] = address.slice(20, end === -1 ? undefined : end).split('/')
      if (scope !== 'session') return undefined
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    } catch {
      return undefined
    }
  }

  const cases = [
    ['sess-abc', 'server/services/poolSnapshot.ts'],
    ['sess-abc', 'src/main.ts'],
    ['sess-abc', 'a b/c#d.ts'],
    ['sess-abc', 'docs/中文笔记.md'],
    ['sess-abc', 'deep/x/y/z.py'],
  ]
  for (const [sessionId, path] of cases) {
    const parsed = parse(fileAddress(sessionId, path))
    assert.ok(parsed, `address must parse: ${path}`)
    assert.equal(parsed.sessionId, sessionId)
    assert.equal(parsed.path, path)
  }
})

test('relativeTime degrades gracefully', () => {
  assert.equal(relativeTime(''), '')
  assert.equal(relativeTime('not-a-date'), '')
  assert.equal(relativeTime(new Date().toISOString()), 'just now')
})

/* -------------------------------------------------------------------------- */

results.push({
  name: 'a bullet run after a numbered run is a separate list, not item N+1',
  fn: () => {
    // Reported in the panel: a `- foo` list directly after a `1. bar` list rendered
    // as "4." / "5." because the block took its type from the first marker only.
    const md = `1. one
2. two

- alpha
- beta
`
    const blocks = parseBlocks(md)
    const lists = blocks.filter((b) => b.type === 'list')
    assert.equal(lists.length, 2, 'two lists, one of each kind')
    assert.equal(lists[0].ordered, true)
    assert.equal(lists[1].ordered, false, 'the bullet run must stay unordered')
    assert.equal(lists[1].items.length, 2)
  },
})

results.push({
  name: 'list markers get a left inset from the panel edge',
  fn: () => {
    // Requested: the numbers sat too close to the left edge of the detail pane. The
    // marker lives in the list padding, so that padding is the gap.
    const css = readFileSync(join(here, '..', 'client.js'), 'utf8')
    const sheet = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (selector) => {
      for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (sel.trim() === selector) return body
      }
      return undefined
    }
    for (const selector of ['.bv-mlist', '.bv-mlist-nested']) {
      const body = rule(selector)
      assert.ok(body !== undefined, `${selector} must exist`)
      const padding = /padding-left:\s*([0-9.]+)em/.exec(body)
      assert.ok(padding, `${selector} must indent in em so it scales with the font`)
      assert.ok(
        Number(padding[1]) >= 1.5,
        `${selector} needs room for the marker plus a gap, got ${padding[1]}em`,
      )
    }
  },
})

results.push({
  name: 'numbered and bulleted lists share one marker gutter',
  fn: () => {
    // Reported: an `ol` looked less indented than a `ul` beside it. Native markers
    // sit just outside the content box at whatever width the glyph needs, so "10."
    // reaches further left than a bullet. The gutter is a fixed box now, which also
    // keeps two-digit numbers from shifting the text.
    const css = readFileSync(join(here, '..', 'client.js'), 'utf8')
    const sheet = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (selector) => {
      for (const [, sel, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (sel.trim() === selector) return body
      }
      return undefined
    }

    // Native markers must be off, or the two kinds would keep different gutters.
    assert.match(rule('.bv-mlist'), /list-style:\s*none/, 'the native marker must be replaced')

    // Both kinds draw a marker in the same absolute box.
    const base = rule('.bv-mli::before')
    assert.ok(base !== undefined, '.bv-mli::before must define the gutter')
    assert.match(base, /position:\s*absolute/, 'the gutter must be out of flow')
    assert.match(base, /width:\s*1\.9em/, 'the gutter must be one fixed width')
    assert.match(base, /text-align:\s*right/, 'markers must be flush with the text')
    // The trailing gap must be small: a wide gutter with a big pad pushed the
    // ordered text further right than the bulleted text and the two lists stopped
    // lining up, which is what the second report was about.
    const pad = /padding-right:\s*([0-9.]+)em/.exec(base)
    assert.ok(pad, 'the gutter must declare its trailing gap explicitly')
    assert.ok(
      Number(pad[1]) <= 0.35,
      `trailing gap too wide (${pad[1]}em): it pushes the numbered text right of the bulleted text`,
    )
    assert.match(base, /left:\s*-1\.9em/, 'the gutter must sit outside the content box')

    // Each kind supplies content; neither overrides the geometry.
    assert.match(rule('ul.bv-mlist>.bv-mli::before'), /content:\s*"•"/, 'bullets need a glyph')
    assert.match(
      rule('ol.bv-mlist>.bv-mli::before'),
      /content:\s*counter\(bv-li\)/,
      'numbers must come from a counter',
    )
    assert.match(rule('ol.bv-mlist'), /counter-reset:\s*bv-li/, 'the counter must reset per list')
    assert.match(rule('ol.bv-mlist>.bv-mli'), /counter-increment:\s*bv-li/, 'items must advance the counter')

    // Nested lists narrow the gutter; they must not fall back to a native marker.
    assert.match(
      rule('.bv-mlist-nested>.bv-mli::before'),
      /width:\s*1\.7em/,
      'nested gutters must match the nested indent',
    )

    // An ordered list gets a WIDER gutter than a bulleted one, on purpose: a number
    // is wider than a bullet, so at equal width its ink sits further left and the
    // list reads as less indented. Widening the gutter both lines the marker ink up
    // and pushes the numbered text further right.
    const olIndent = /padding-left:\s*([0-9.]+)em/.exec(rule('ol.bv-mlist') ?? '')
    const ulIndent = /padding-left:\s*([0-9.]+)em/.exec(rule('.bv-mlist') ?? '')
    assert.ok(olIndent !== null, 'ol must declare its own indent')
    assert.ok(ulIndent !== null, 'the shared indent must be declared')
    assert.ok(
      Number(olIndent[1]) > Number(ulIndent[1]),
      `an ordered list must indent further than a bulleted one (${olIndent[1]}em vs ${ulIndent[1]}em)`,
    )
    // And its marker gutter must follow that indent, or the marker would sit in the
    // wrong place inside the wider padding.
    const olGutter = rule('ol.bv-mlist>.bv-mli::before')
    assert.ok(olGutter !== undefined, 'ol must override the gutter geometry')
    assert.match(olGutter, /left:\s*-2\.35em/, 'the ol gutter must offset by its own indent')
    assert.match(olGutter, /width:\s*2\.35em/, 'the ol gutter must be as wide as its indent')
  },
})

let failed = 0
for (const { name, fn } of results) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
