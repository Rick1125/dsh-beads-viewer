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
