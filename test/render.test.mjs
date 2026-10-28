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
const { Markdown, statusTone, priorityLabel } = mod.__test

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
