window.__ModuleLoader__.load({
  id: 'dsh-beads-viewer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const TAB_KIND = 'beads'
    const TAB_ID = 'dsh-beads-viewer'
    const ROUTE = 'beads-viewer/api'
    const LIST_PAGE = 120
    /** Comments a long thread shows before it offers the rest. */
    const COLLAPSED_COMMENTS = 4
    const NS = 'beadsViewer'

    /**
     * Markdown-ish extensions that are worth offering as file links.
     *
     * Longest first: the alternation is ordered, so `js` before `json` cuts
     * `package.json` down to `package.js`. A trailing guard rejects one more
     * name character for the same reason (`config.jsonl` is not `config.js`).
     */
    const FILE_EXT =
      '(?:py|pyi|jsonl|json|ya?ml|toml|lock|tsx|ts|jsx|mjs|cjs|js|mdx|md|css|scss|html|vue|svelte|ini|cfg|bash|zsh|sh|graphql|proto|rs|go|java|kt|swift|cc|cpp|hpp|cs|rb|php|sql|csv|tsv|txt|env|tf|c|h)'
    /** An extension match must not be followed by another name character. */
    const EXT_TAIL = '(?![\\w.])'

    /* ------------------------------------------------------------------ *
     * Small utilities
     * ------------------------------------------------------------------ */

    function dirBase() {
      const fallback = 'http://127.0.0.1/'
      let base = typeof document !== 'undefined' ? document.baseURI : fallback
      try {
        const url = new URL(base === '' ? fallback : base, fallback)
        url.search = ''
        url.hash = ''
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return url.href
      } catch {
        return fallback
      }
    }

    async function api(params, signal) {
      const url = new URL(ROUTE, dirBase())
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
      const response = await fetch(url.href, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        let detail = ''
        try {
          detail = await response.text()
        } catch {
          detail = ''
        }
        throw new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`)
      }
      return response.json()
    }

    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /** The right side's file address for a workspace-relative path. */
    function fileAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized
        .split('/')
        .map(encodeSegment)
        .join('/')}`
    }

    function relativeTime(iso) {
      if (!iso) return ''
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      const minutes = Math.round((Date.now() - then) / 60000)
      if (minutes < 1) return 'just now'
      if (minutes < 60) return `${minutes}m ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h ago`
      const days = Math.round(hours / 24)
      if (days < 30) return `${days}d ago`
      return new Date(then).toLocaleDateString()
    }

    function priorityLabel(priority) {
      return ['P0', 'P1', 'P2', 'P3', 'P4'][priority] ?? `P${priority}`
    }

    /** Status colour token; keeps the panel readable without inventing colours. */
    function statusTone(status) {
      if (status === 'closed') return 'var(--dsw-alias-state-idle-primary, #8a8f98)'
      if (status === 'in_progress') return 'var(--dsw-alias-brand-primary, #4f8cff)'
      if (status === 'blocked') return 'var(--dsw-alias-state-error-primary, #e5534b)'
      if (status === 'deferred') return 'var(--dsw-alias-state-warn-primary, #d29922)'
      return 'var(--dsw-alias-state-success-primary, #2ea043)'
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ *
     * Candidate file paths inside issue prose
     * ------------------------------------------------------------------ */

    /** `dir/file.ext:12-34` or `file.ext:12`, always with a known source extension. */
    const PATH_SRC =
      `(?<pfx>(?:\\.{0,2}\\/)?(?:[\\w.@+-]+\\/)+[\\w.@+-]+\\.${FILE_EXT}${EXT_TAIL}(?::\\d+(?:-\\d+)?)?)` +
      `|(?<pbare>(?:\\.{0,2}\\/)?[\\w.@+-]+\\.${FILE_EXT}${EXT_TAIL}(?::\\d+(?:-\\d+)?)?)`

    /** An issue id as Beads mints it: `prefix-abc123`, optionally with `.1` children. */
    // Beads mints ids as `prefix-suffix` with a mixed-case suffix (`proj-Phc908`),
    // so both cases are accepted; a candidate only becomes a link when it names an
    // issue in the list, which is what keeps ordinary hyphenated prose out.
    const ISSUE_ID_SRC = '(?<iid>[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-[A-Za-z0-9]{2,6}(?:\\.[0-9]+)*)'

    // The left boundary keeps a match out of the middle of a word
    // (`mysrc/main.ts` must not yield `src/main.ts`). A lookbehind says that
    // without consuming a character, so the match starts at the path and the
    // start of the string and the start of a line both qualify.
    const BOUNDARY = '(?<![\\w./\\-])'

    /** Normalise one matched path token: strip the `:line` suffix and `./`. */
    function splitPathToken(token) {
      const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(token)
      const raw = match ? match[1] : token
      const line = match && match[2] ? Number(match[2]) : undefined
      return { path: raw.replace(/^\.\//, ''), line }
    }

    /** The path a regex match names, if it names one. */
    function matchedPath(match) {
      const groups = match.groups ?? {}
      return groups.pfx ?? groups.pbare ?? null
    }

    /**
     * Every file-looking path in a blob of prose, deduped, in first-seen order.
     * The panel asks the Host which of them exist before rendering links, so a
     * path mentioned as prose (or a renamed file) does not become a dead link.
     */
    function extractPaths(text) {
      const seen = new Set()
      const out = []
      if (typeof text !== 'string' || text === '') return out
      const pattern = new RegExp(`${BOUNDARY}(?:${PATH_SRC})`, 'g')
      let match
      while ((match = pattern.exec(text)) !== null) {
        const token = matchedPath(match)
        if (!token) continue
        const { path } = splitPathToken(token)
        if (path === '' || seen.has(path)) continue
        seen.add(path)
        out.push(path)
        if (out.length >= 200) break
      }
      return out
    }

    /* ------------------------------------------------------------------ *
     * Markdown rendering (no external dependency, token-only styling)
     * ------------------------------------------------------------------ */

    const BLOCK_START = /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\s*\|)/
    const TABLE_SEPARATOR = /^\s*\|?[\s:\-|]+\|[\s:\-|]*$/

    /** Split markdown into block-level nodes. Pure; exported for tests. */
    function parseBlocks(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      const blank = (line) => line === undefined || line.trim() === ''

      while (index < lines.length) {
        const line = lines[index]
        if (blank(line)) {
          index += 1
          continue
        }

        const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
        if (fence) {
          const marker = fence[1]
          const lang = fence[2]
          const body = []
          index += 1
          while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push({ type: 'code', lang, text: body.join('\n') })
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push({ type: 'heading', depth: heading[1].length, text: heading[2].trim() })
          index += 1
          continue
        }

        if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
          blocks.push({ type: 'hr' })
          index += 1
          continue
        }

        if (line.includes('|') && lines[index + 1] !== undefined && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes('-')) {
          const header = splitRow(line)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].includes('|') && !blank(lines[index])) {
            rows.push(splitRow(lines[index]))
            index += 1
          }
          blocks.push({ type: 'table', header, rows })
          continue
        }

        if (/^\s*>/.test(line)) {
          const body = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            body.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) })
          continue
        }

        const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (listMatch) {
          const ordered = /\d/.test(listMatch[2])
          const items = []
          while (index < lines.length) {
            const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
            if (item) {
              const itemOrdered = /\d/.test(item[2])
              // A bare bullet run right after a numbered one used to inherit the
              // numbered marker, so a `- foo` under a `1. bar` list rendered as
              // "4." instead of a bullet. Only continue while the marker KIND
              // matches; a change closes this list and the outer loop opens a new
              // one of the right type.
              if (itemOrdered !== ordered && item[1].length === 0) {
                break
              }
              items.push({ indent: item[1].replace(/\t/g, '  ').length, ordered: itemOrdered, text: item[3] })
              index += 1
              // Continuation lines (indented, not a new bullet) belong to the item.
              while (
                index < lines.length &&
                lines[index].trim() !== '' &&
                /^\s{2,}/.test(lines[index]) &&
                !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index])
              ) {
                items[items.length - 1].text += `\n${lines[index].trim()}`
                index += 1
              }
              continue
            }
            if (blank(lines[index])) {
              // A blank line ends the list unless another bullet follows.
              let probe = index + 1
              while (probe < lines.length && blank(lines[probe])) probe += 1
              if (probe < lines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[probe])) {
                index = probe
                continue
              }
            }
            break
          }
          blocks.push({ type: 'list', ordered, items })
          continue
        }

        // Paragraph: everything until a blank line or the start of another block.
        const body = [line]
        index += 1
        while (index < lines.length && !blank(lines[index]) && !BLOCK_START.test(lines[index])) {
          body.push(lines[index])
          index += 1
        }
        blocks.push({ type: 'paragraph', text: body.join('\n') })
      }
      return blocks
    }

    function splitRow(line) {
      let trimmed = line.trim()
      if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
      if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
      return trimmed.split('|').map((cell) => cell.trim())
    }

    /** A fresh inline pattern per call: the renderer recurses into itself. */
    function inlinePattern() {
      return new RegExp(
        [
          '(`[^`\\n]+`)', // 1 code
          '(\\*\\*[^*\\n]+\\*\\*)', // 2 strong
          '(__[^_\\n]+__)', // 3 strong
          '(~~[^~\\n]+~~)', // 4 strike
          '(\\*[^*\\n]+\\*)', // 5 em
          '(_[^_\\n]+_)', // 6 em
          '(!?\\[[^\\]\\n]*\\]\\([^)\\s]+\\))', // 7 link / image
          '(https?:\\/\\/[^\\s<>()]+)', // 8 bare url
        ].join('|'),
        'g',
      )
    }

    /**
     * Render inline markdown.
     *
     * @param {string} text - one inline run.
     * @param {object} ctx - render context: `knownIds` (Set), `exists` (path
     *   set), `onIssue`, `onFile`, `key`.
     */
    function renderInline(text, ctx, keyPrefix = 'i') {
      const nodes = []
      let cursor = 0
      let seq = 0
      const pattern = inlinePattern()
      // Variadic: the plain scanner contributes several nodes per run.
      const push = (...added) => {
        for (const node of added) nodes.push(node)
        seq += 1
      }

      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) push(...plainRun(text.slice(cursor, match.index), ctx, `${keyPrefix}p${seq}`))
        const token = match[0]
        if (match[1] !== undefined) {
          const value = token.slice(1, -1)
          push(codeSpan(value, ctx, `${keyPrefix}c${seq}`))
        } else if (match[2] !== undefined || match[3] !== undefined) {
          const value = token.slice(2, -2)
          push(
            h('strong', { key: `${keyPrefix}s${seq}` }, renderInline(value, ctx, `${keyPrefix}s${seq}-`)),
          )
        } else if (match[4] !== undefined) {
          push(h('del', { key: `${keyPrefix}d${seq}` }, renderInline(token.slice(2, -2), ctx, `${keyPrefix}d${seq}-`)))
        } else if (match[5] !== undefined || match[6] !== undefined) {
          push(h('em', { key: `${keyPrefix}e${seq}` }, renderInline(token.slice(1, -1), ctx, `${keyPrefix}e${seq}-`)))
        } else if (match[7] !== undefined) {
          const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)
          if (link) {
            const label = link[2] === '' ? link[3] : link[2]
            push(
              h(
                'a',
                {
                  key: `${keyPrefix}l${seq}`,
                  href: link[3],
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  className: 'bv-link',
                },
                renderInline(label, ctx, `${keyPrefix}l${seq}-`),
              ),
            )
          } else {
            push(...plainRun(token, ctx, `${keyPrefix}t${seq}`))
          }
        } else if (match[8] !== undefined) {
          push(
            h(
              'a',
              { key: `${keyPrefix}u${seq}`, href: token, target: '_blank', rel: 'noreferrer noopener', className: 'bv-link' },
              token,
            ),
          )
        }
        cursor = match.index + token.length
      }
      // A run with no inline markup at all never enters the loop; run the whole
      // string through the plain scanner so links and issue chips still appear.
      if (cursor < text.length) push(...plainRun(text.slice(cursor), ctx, `${keyPrefix}tail`))
      return nodes.length > 0 ? nodes : plainRun(text, ctx, `${keyPrefix}only`)
    }

    /** One inline code span; a path-shaped span becomes a file link. */
    function codeSpan(value, ctx, key) {
      const { path, line } = splitPathToken(value)
      const looksLikePath = new RegExp(`\\.${FILE_EXT}$`).test(path) && path.includes('.')
      if (looksLikePath && ctx.exists && ctx.exists.has(path)) {
        return h(
          'code',
          { key, className: 'bv-code bv-code-link', onClick: () => ctx.onFile?.(path, line), title: `Open ${path}` },
          value,
        )
      }
      return h('code', { key, className: 'bv-code' }, value)
    }

    /** Plain text split into issue-id chips and file links where recognized. */
    function plainRun(text, ctx, keyPrefix) {
      const nodes = []
      let cursor = 0
      let seq = 0

      const pushText = (value) => {
        if (value === '') return
        nodes.push(value)
        seq += 1
      }

      const pattern = new RegExp(`(?:${PATH_SRC})|${ISSUE_ID_SRC}`, 'g')
      let match
      while ((match = pattern.exec(text)) !== null) {
        const token = match[0]
        const pathToken = matchedPath(match)
        const issueToken = match.groups?.iid
        if (pathToken) {
          const { path, line } = splitPathToken(pathToken)
          if (ctx.exists && ctx.exists.has(path)) {
            if (match.index > cursor) pushText(text.slice(cursor, match.index))
            nodes.push(
              h(
                'button',
                {
                  key: `${keyPrefix}f${seq}`,
                  type: 'button',
                  className: 'bv-filelink',
                  onClick: () => ctx.onFile?.(path, line),
                  title: `Open ${path}${line ? `:${line}` : ''}`,
                },
                path,
                line ? h('span', { className: 'bv-fileline' }, `:${line}`) : null,
              ),
            )
            cursor = match.index + pathToken.length
            continue
          }
        } else if (issueToken) {
          if (ctx.knownIds && ctx.knownIds.has(issueToken)) {
            if (match.index > cursor) pushText(text.slice(cursor, match.index))
            nodes.push(
              h(
                'button',
                {
                  key: `${keyPrefix}i${seq}`,
                  type: 'button',
                  className: 'bv-issuelink',
                  onClick: () => ctx.onIssue?.(issueToken),
                  title: `Open ${issueToken}`,
                },
                issueToken,
              ),
            )
            cursor = match.index + issueToken.length
            continue
          }
        }
      }
      pushText(text.slice(cursor))
      return nodes.length > 0 ? nodes : [text]
    }

    /** Render a block list to React nodes. */
    function renderBlocks(blocks, ctx, keyPrefix = 'b') {
      return blocks.map((block, index) => {
        const key = `${keyPrefix}${index}`
        switch (block.type) {
          case 'heading': {
            const depth = Math.min(block.depth + 2, 6)
            return h(
              `h${depth}`,
              { key, className: `bv-h bv-h${block.depth}` },
              renderInline(block.text, ctx, `${key}-`),
            )
          }
          case 'code':
            return h(
              'pre',
              { key, className: 'bv-pre' },
              block.lang ? h('span', { className: 'bv-lang' }, block.lang) : null,
              h('code', null, block.text),
            )
          case 'hr':
            return h('hr', { key, className: 'bv-hr' })
          case 'quote':
            return h('blockquote', { key, className: 'bv-quote' }, renderBlocks(block.blocks, ctx, `${key}-`))
          case 'table':
            return h(
              'div',
              { key, className: 'bv-tablewrap' },
              h(
                'table',
                { className: 'bv-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    block.header.map((cell, cellIndex) =>
                      h('th', { key: `${key}h${cellIndex}` }, renderInline(cell, ctx, `${key}h${cellIndex}-`)),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  block.rows.map((row, rowIndex) =>
                    h(
                      'tr',
                      { key: `${key}r${rowIndex}` },
                      row.map((cell, cellIndex) =>
                        h('td', { key: `${key}r${rowIndex}c${cellIndex}` }, renderInline(cell, ctx, `${key}r${rowIndex}c${cellIndex}-`)),
                      ),
                    ),
                  ),
                ),
              ),
            )
          case 'list':
            return renderList(block, ctx, key)
          default:
            return h('p', { key, className: 'bv-p' }, renderInline(block.text, ctx, `${key}-`))
        }
      })
    }

    /**
     * Render a list, nesting by indentation.
     *
     * Beads prose nests bullets two or three levels deep; grouping by the
     * recorded indent (rather than assuming one level) keeps those trees
     * intact instead of flattening them.
     */
    function renderList(block, ctx, key) {
      const grouped = groupByIndent(block.items)
      return h(
        block.ordered ? 'ol' : 'ul',
        { key, className: 'bv-mlist' },
        grouped.map((node, index) => renderListItem(node, ctx, `${key}-${index}`)),
      )
    }

    /** Turn a flat item run into a tree of `{ text, children }` nodes. */
    function groupByIndent(items) {
      const roots = []
      const stack = []
      for (const item of items) {
        const node = { text: item.text, ordered: item.ordered, children: [] }
        while (stack.length > 0 && stack[stack.length - 1].indent >= item.indent) stack.pop()
        if (stack.length === 0) roots.push(node)
        else stack[stack.length - 1].node.children.push(node)
        stack.push({ indent: item.indent, node })
      }
      return roots
    }

    function renderListItem(node, ctx, key) {
      const task = /^\[( |x|X)\]\s+/.exec(node.text)
      const text = task ? node.text.slice(task[0].length) : node.text
      return h(
        'li',
        { key, className: task ? 'bv-mli bv-mli-task' : 'bv-mli' },
        task
          ? h('input', {
              type: 'checkbox',
              checked: task[1].toLowerCase() === 'x',
              readOnly: true,
              className: 'bv-check',
              'aria-label': 'task done',
            })
          : null,
        h('span', null, renderInline(text, ctx, `${key}-`)),
        node.children.length > 0
          ? h(
              node.children.some((child) => child.ordered) ? 'ol' : 'ul',
              { className: 'bv-mlist bv-mlist-nested' },
              node.children.map((child, index) => renderListItem(child, ctx, `${key}-n${index}`)),
            )
          : null,
      )
    }

    function Markdown({ text, ctx }) {
      const blocks = React.useMemo(() => parseBlocks(text), [text])
      return h('div', { className: 'bv-md' }, renderBlocks(blocks, ctx))
    }

    /* ------------------------------------------------------------------ *
     * Data hooks
     * ------------------------------------------------------------------ */

    /**
     * @param {object} forceRef - ref whose `current` is true for the one load the
     *   user explicitly asked for (the Refresh control), and reset once used.
     */
    function useBeads(cwd, sessionId, revision, forceRef) {
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      React.useEffect(() => {
        if (!cwd) {
          setState({ loading: false, error: null, data: null, reason: 'no-cwd' })
          return undefined
        }
        const controller = new AbortController()
        setState((prev) => ({ ...prev, loading: true, error: null }))
        // `force` matters for the Refresh button: the Host caches the list for a
        // few seconds, so without it a click inside that window would return the
        // same bytes and the button would look dead. The flag is consumed here so
        // a later focus refresh still gets the cache.
        const force = forceRef?.current === true
        if (forceRef) forceRef.current = false
        api({ cwd, action: 'overview', force: force ? 1 : undefined }, controller.signal)
          .then((data) => {
            if (controller.signal.aborted) return
            setState({ loading: false, error: null, data })
          })
          .catch((error) => {
            if (controller.signal.aborted || error?.name === 'AbortError') return
            setState({ loading: false, error: String(error?.message ?? error), data: null })
          })
        return () => controller.abort()
      }, [cwd, sessionId, revision])
      return state
    }

    function useIssue(cwd, id) {
      const [state, setState] = React.useState({ loading: false, error: null, data: null })
      React.useEffect(() => {
        if (!cwd || !id) {
          setState({ loading: false, error: null, data: null })
          return undefined
        }
        const controller = new AbortController()
        setState({ loading: true, error: null, data: null })
        api({ cwd, action: 'issue', id }, controller.signal)
          .then((data) => {
            if (controller.signal.aborted) return
            setState({ loading: false, error: data?.ok === false ? data.message : null, data })
          })
          .catch((error) => {
            if (controller.signal.aborted || error?.name === 'AbortError') return
            setState({ loading: false, error: String(error?.message ?? error), data: null })
          })
        return () => controller.abort()
      }, [cwd, id])
      return state
    }

    /**
     * Which candidate paths exist in the workspace, and where each one lives.
     *
     * The existence set keeps a mention from becoming a dead link, and the
     * absolute path is what the file address is built from: the Beads workspace
     * may sit above the session's cwd, so a workspace-relative path alone would
     * resolve against the wrong root.
     */
    function useExistingPaths(cwd, paths) {
      const [resolved, setResolved] = React.useState({ exists: new Set(), absolute: new Map() })
      const key = paths.join('\n')
      React.useEffect(() => {
        if (!cwd || paths.length === 0) {
          setResolved({ exists: new Set(), absolute: new Map() })
          return undefined
        }
        const controller = new AbortController()
        api({ cwd, action: 'files', paths: key, sessionCwd: cwd }, controller.signal)
          .then((data) => {
            if (controller.signal.aborted) return
            const exists = new Set()
            const absolute = new Map()
            for (const row of data?.files ?? []) {
              if (!row.exists) continue
              exists.add(row.path)
              // Prefer the session-relative spelling: the sidebar dedupes a file
              // tab by address, so the relative form lands on the tab the chat
              // already opened instead of a second one.
              const target = row.sessionPath ?? row.absolute
              if (target) absolute.set(row.path, target)
            }
            setResolved({ exists, absolute })
          })
          .catch(() => {
            if (!controller.signal.aborted) setResolved({ exists: new Set(), absolute: new Map() })
          })
        return () => controller.abort()
      }, [cwd, key])
      return resolved
    }

    /* ------------------------------------------------------------------ *
     * Presentational pieces
     * ------------------------------------------------------------------ */

    function StatusDot({ status }) {
      return h('span', {
        className: 'bv-dot',
        style: { background: statusTone(status) },
        title: status,
      })
    }

    /*
     * Solid badge palette.
     *
     * Hue carries the meaning, so a reader can triage a list without reading the
     * text: red is urgent or broken, amber is a warning, blue is normal work,
     * green is a task, grey is inert. Every fill is a `--dsw-static-*` mid-tone
     * and every label colour was chosen by computing contrast, not by eye — each
     * pair clears WCAG AA (4.5:1). Static mid-tones are identical in both themes
     * (verified against the shipped theme CSS), so a filled badge reads the same
     * on a light and a dark sidebar; the ink is dark-on-warm and white-on-dark
     * per fill rather than one ink for all.
     */
    /*
     * Ink is derived, never chosen per badge: a light fill takes black text and a
     * dark fill takes white. The threshold is WCAG's own crossover — the
     * luminance at which black and white are exactly equal in contrast
     * (`sqrt(0.05 * 1.05) - 0.05` ≈ 0.179). Picking ink by eye is what produced
     * a palette where some badges had white text on a mid-tone and some had
     * black, with no rule behind the difference.
     */
    const INK_DARK = '#0f0f0f'
    const INK_LIGHT = '#ffffff'
    const INK_CROSSOVER = 0.1791

    /** Relative luminance of a `#rrggbb` string (WCAG 2.x). */
    function luminanceOf(hex) {
      const value = String(hex).replace('#', '')
      const channel = (index) => {
        const c = parseInt(value.slice(index, index + 2), 16) / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
    }

    /** Black or white, whichever the fill calls for. */
    function inkFor(hex) {
      return luminanceOf(hex) > INK_CROSSOVER ? INK_DARK : INK_LIGHT
    }

    /**
     * One badge fill. `lit` is the literal that stands in when the CSS variable
     * is missing, and it is also what the ink rule is computed from, so the two
     * can never disagree.
     */
    const fill = (token, lit) => ({ bg: `var(--dsw-static-${token}, ${lit})`, ink: inkFor(lit) })

    /** @type {Record<string, {bg: string, ink: string}>} */
    const PRIORITY_BADGE = {
      0: fill('red-500', '#ef4444'),
      1: fill('amber-500', '#f59e0b'),
      2: fill('blue-500', '#3b82f6'),
      // Cyan is not one of this theme's six hue families, so it is a literal:
      // the point is a hue the eye can tell from P2's blue at a glance.
      3: { bg: '#06b6d4', ink: inkFor('#06b6d4') },
      4: { bg: '#a2a4a6', ink: inkFor('#a2a4a6') },
    }

    const TYPE_BADGE = {
      bug: fill('red-500', '#ef4444'),
      // Fuchsia, not the indigo it was: as indigo it sat deltaE 5 from P2's blue,
      // right beside it in every row. This is 50 from its nearest neighbour.
      feature: { bg: '#d946ef', ink: inkFor('#d946ef') },
      // Deep violet: as slate it was indistinguishable from `closed`'s grey and
      // from `pinned`, and no slate tone could clear both greys at once.
      epic: { bg: '#581c87', ink: inkFor('#581c87') },
      task: fill('green-500', '#22c55e'),
      // Orange: as amber-600 it sat 18 from P1's amber.
      decision: { bg: '#ea580c', ink: inkFor('#ea580c') },
      chore: { bg: '#545557', ink: inkFor('#545557') },
    }

    const STATUS_BADGE = {
      // Indigo, not blue-600: P2 is already blue and the two sat 19 apart on the
      // same row, so "open" and "medium priority" looked like one colour.
      open: { bg: '#4f46e5', ink: inkFor('#4f46e5') },
      // Yellow, not the indigo/amber it was: `open` is blue and the two sat
      // within deltaE 18, which reads as the same colour at a glance. Yellow is
      // 158 away from that blue and 34 from P1's amber, so both neighbours are
      // distinguishable.
      in_progress: { bg: '#fde047', ink: inkFor('#fde047') },
      blocked: fill('red-500', '#ef4444'),
      closed: { bg: '#545557', ink: inkFor('#545557') },
      deferred: { bg: '#a2a4a6', ink: inkFor('#a2a4a6') },
      // Navy, not the slate it shared with `closed`/`chore`: that slate was 18
      // from the greys, which is below the point where a hue reads as different.
      pinned: { bg: '#1e3a8a', ink: inkFor('#1e3a8a') },
      // Teal, not the indigo it was: indigo sat 25 from P2's blue.
      hooked: { bg: '#0d9488', ink: inkFor('#0d9488') },
    }

    /** The badge pair for one dimension value, or undefined when unlisted. */
    function badgeFor(kind, value) {
      const table = kind === 'priority' ? PRIORITY_BADGE : kind === 'type' ? TYPE_BADGE : STATUS_BADGE
      const key = kind === 'priority' ? value : String(value ?? '').toLowerCase()
      return table[key]
    }

    /**
     * A filled badge. `kind` picks the dimension so the palette stays in one place;
     * `plain` renders the old outline chip for values with no assigned hue.
     */
    function Badge({ children, kind, value, title, plain }) {
      const pair = plain ? undefined : badgeFor(kind, value)
      if (pair === undefined) {
        return h('span', { className: 'bv-badge', title }, children)
      }
      return h(
        'span',
        {
          className: `bv-badge bv-badge-solid bv-badge-${kind}`,
          style: { background: pair.bg, color: pair.ink },
          title: title ?? `${kind}: ${value}`,
        },
        children,
      )
    }

    function IconButton({ label, onClick, title, children, active }) {
      return h(
        'button',
        {
          type: 'button',
          className: active ? 'bv-iconbtn bv-iconbtn-active' : 'bv-iconbtn',
          onClick,
          title: title ?? label,
          'aria-label': title ?? label,
        },
        children ?? label,
      )
    }

    function FilterChip({ label, count, active, onClick, tone }) {
      return h(
        'button',
        {
          type: 'button',
          className: active ? 'bv-chip bv-chip-active' : 'bv-chip',
          onClick,
          style: active && tone ? { borderColor: tone, color: tone } : undefined,
        },
        label,
        count === undefined ? null : h('span', { className: 'bv-chip-count' }, count),
      )
    }

    /* ------------------------------------------------------------------ *
     * The panel
     * ------------------------------------------------------------------ */

    const SORTS = [
      { id: 'updated', labelKey: 'sortUpdated' },
      { id: 'priority', labelKey: 'sortPriority' },
      { id: 'created', labelKey: 'sortCreated' },
      { id: 'id', labelKey: 'sortId' },
    ]

    function BeadsPanel(props) {
      const { sessionId, useSessions, inputActions } = props
      // Keep hook order fixed: the language subscription is declared before any
      // early return. The Host re-renders slot occupants on a locale change, but
      // this makes the copy correct even if it does not.
      const [, setLocaleRevision] = React.useState(0)
      React.useEffect(() => {
        if (localeService === null || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => {
          // Same contract as above: read the snapshot, do not expect an argument.
          const active = localeService.getSnapshot?.()?.active
          dictionary = active === 'zh' ? ZH : EN
          setLocaleRevision((revision) => revision + 1)
        })
      }, [])
      // The tab seat hands every body one bound `useTabInfo`, stable for the
      // lifetime of this mount, so reading it once here keeps hook order fixed.
      const tabInfoHook = props.useTabInfo
      let tabInfo = null
      if (typeof tabInfoHook === 'function') {
        try {
          tabInfo = tabInfoHook()
        } catch {
          // A body can be asked for its tab before the record is committed; the
          // panel still renders, it just cannot open a sibling tab yet.
          tabInfo = null
        }
      }
      const tabActions = tabInfo?.tab?.actions
      const cwd = useSessions
        ? useSessions((sessions) => {
            const session = sessions?.byId?.[sessionId]
            return session?.cwd ?? undefined
          })
        : undefined

      const [revision, setRevision] = React.useState(0)
      /** Set just before the revision bump so the next load bypasses the cache. */
      const forceNextRef = React.useRef(false)
      const [query, setQuery] = React.useState('')
      const [status, setStatus] = React.useState('active')
      const [sort, setSort] = React.useState('updated')
      const [openId, setOpenId] = React.useState(null)
      const [limit, setLimit] = React.useState(LIST_PAGE)
      const [toast, setToast] = React.useState(null)
      const [showAllComments, setShowAllComments] = React.useState(false)
      const searchRef = React.useRef(null)

      const list = useBeads(cwd, sessionId, revision, forceNextRef)
      const detail = useIssue(cwd, openId)

      const issues = list.data?.issues ?? []
      const knownIds = React.useMemo(() => new Set(issues.map((issue) => issue.id)), [issues])
      const counts = React.useMemo(() => {
        const out = { total: issues.length, active: 0 }
        for (const issue of issues) {
          out[issue.status] = (out[issue.status] ?? 0) + 1
          if (issue.status !== 'closed') out.active += 1
          if (issue.ready === true) out.ready = (out.ready ?? 0) + 1
          // Counted, not deduced: `open - ready` would be wrong the moment
          // `bd ready` stops being exactly the open-and-unblocked set.
          if (issue.ready === false && issue.status === 'open') out.waiting = (out.waiting ?? 0) + 1
        }
        return out
      }, [issues])

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        let rows = issues.filter((issue) => {
          if (status === 'ready') {
            // Readiness is bd's own answer; a row without the flag (an older
            // Host, or a failed `bd ready`) simply never matches this chip.
            if (issue.ready !== true) return false
          } else if (status === 'waiting') {
            if (issue.status !== 'open' || issue.ready !== false) return false
          } else if (status === 'active') {
            if (issue.status === 'closed') return false
          } else if (status !== 'all' && issue.status !== status) return false
          if (needle === '') return true
          return (
            issue.id.toLowerCase().includes(needle) ||
            issue.title.toLowerCase().includes(needle) ||
            issue.labels.some((label) => label.toLowerCase().includes(needle)) ||
            issue.type.toLowerCase().includes(needle)
          )
        })
        const rank = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }
        rows = rows.slice().sort((left, right) => {
          if (sort === 'priority') {
            const delta = (rank[priorityLabel(left.priority)] ?? 9) - (rank[priorityLabel(right.priority)] ?? 9)
            if (delta !== 0) return delta
          }
          if (sort === 'created') return String(right.createdAt).localeCompare(String(left.createdAt))
          if (sort === 'id') return left.id.localeCompare(right.id)
          return String(right.updatedAt).localeCompare(String(left.updatedAt))
        })
        return rows
      }, [issues, query, status, sort])

      // Whether the readiness signal is usable decides whether its chips exist at
      // all: offering "Ready 0" when the question could not be asked would be a
      // lie, and a "Blocked" chip over a project with no dependency graph is noise.
      const readinessLive = list.data?.readiness === 'live'
      // A project with no dependency edges has nothing to wait on, so a Blocked
      // chip would be a permanent zero; Ready still earns its place because it
      // answers "can I start the whole backlog right now".
      const hasEdges = issues.some((issue) => issue.dependencyCount > 0)

      React.useEffect(() => setLimit(LIST_PAGE), [query, status, sort])

      const flash = React.useCallback((message) => {
        setToast(message)
        window.setTimeout(() => setToast((current) => (current === message ? null : current)), 1800)
      }, [])

      // The callback is created before the resolver's state exists on the first
      // render, so it reads the latest value through a ref written below.
      const resolvedRef = React.useRef({ absolute: new Map() })

      const openFile = React.useCallback(
        (path, line) => {
          const opener = tabActions
          const params = line === undefined ? {} : { params: { line } }
          // Address the file by its absolute path when the Host resolved one: the
          // Beads workspace may sit above the session cwd, and a relative path
          // would then resolve against the wrong root.
          const absolute = resolvedRef.current?.absolute?.get(path) ?? path
          try {
            if (opener && typeof opener.openResource === 'function') {
              opener.openResource(fileAddress(sessionId, absolute), params)
              return
            }
          } catch (error) {
            console.error('[dsh-beads-viewer] openResource failed', error)
          }
          flash(`Could not open ${path}`)
        },
        [tabActions, sessionId, flash],
      )

      const copyId = React.useCallback(
        async (id) => {
          const ok = await copyText(id)
          flash(ok ? `Copied ${id}` : 'Copy failed')
        },
        [flash],
      )

      const insertId = React.useCallback(
        (id) => {
          if (!inputActions || typeof inputActions.captureInsertion !== 'function') {
            flash('The composer is not available in this view')
            return
          }
          const span = inputActions.captureInsertion()
          const inserted = inputActions.insertText(`${id} `, span)
          flash(inserted ? `Inserted ${id}` : 'Could not insert — click the composer first')
        },
        [inputActions, flash],
      )

      React.useEffect(() => {
        // Refreshing on window focus is a courtesy for a visible panel; a
        // `keepMounted` panel behind another tab would spend a `bd` call per
        // window focus for nothing.
        if (tabInfo?.tab?.visible === false) return undefined
        const onFocus = () => setRevision((value) => value + 1)
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [tabInfo?.tab?.visible])

      React.useEffect(() => {
        // A window-level listener has to prove it may act before it does.
        //
        // `keepMounted` keeps this panel alive while another tab is in front, so
        // without `visible` a hidden panel would still answer keys meant for the
        // composer. And a `contenteditable` composer is neither an INPUT nor a
        // TEXTAREA, so the old tag test let "/" be stolen from it — the composer
        // lost focus mid-word and the next characters went into this search box.
        if (tabInfo?.tab?.visible === false) return undefined
        const editable = (node) => {
          if (!node || typeof node !== 'object') return false
          if (node.isContentEditable === true) return true
          const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
          // `closest` is the only reliable way to see the editable ancestor of
          // the focused leaf the browser reports as activeElement.
          return typeof node.closest === 'function' && node.closest('[contenteditable]:not([contenteditable="false"])') !== null
        }
        const onKey = (event) => {
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key === 'Escape' && openId !== null) {
            // Escape closes this panel's detail view, but it must not be taken
            // from the composer, where it may dismiss a menu of its own.
            if (editable(document.activeElement)) return
            event.stopPropagation()
            setOpenId(null)
            return
          }
          if (event.key !== '/') return
          if (editable(document.activeElement)) return
          event.preventDefault()
          searchRef.current?.focus()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [openId, tabInfo?.tab?.visible])

      const refresh = () => {
        forceNextRef.current = true
        setRevision((value) => value + 1)
      }

      /* ---- shared render context for markdown ---- */
      const detailPaths = React.useMemo(() => {
        if (!detail.data) return []
        const blob = [
          detail.data.issue?.description ?? '',
          detail.data.issue?.design ?? '',
          detail.data.issue?.notes ?? '',
          detail.data.issue?.acceptanceCriteria ?? '',
          ...(detail.data.comments ?? []).map((comment) => comment.text),
        ].join('\n')
        return extractPaths(blob)
      }, [detail.data])
      const resolved = useExistingPaths(cwd, detailPaths)
      resolvedRef.current = resolved

      const mdCtx = React.useMemo(
        () => ({
          exists: resolved.exists,
          knownIds,
          onFile: openFile,
          onIssue: (id) => {
            setOpenId(id)
          },
        }),
        [resolved, knownIds, openFile],
      )

      if (!cwd) {
        return h(
          'div',
          { className: 'bv-root' },
          h(StyleSheet, null),
          h('div', { className: 'bv-empty' }, 'Open a session in a project folder to browse its Beads issues.'),
        )
      }

      return h(
        'div',
        { className: 'bv-root' },
        h(StyleSheet, null),

        openId === null
          ? h(
              'div',
              { className: 'bv-listview' },
              h(
                'div',
                { className: 'bv-toolbar' },
                h('input', {
                  ref: searchRef,
                  className: 'bv-search',
                  value: query,
                  placeholder: t('search'),
                  onChange: (event) => setQuery(event.target.value),
                  spellCheck: false,
                }),
                h(IconButton, { label: '⟳', title: t('refresh'), onClick: refresh }),
              ),
              h(
                'div',
                { className: 'bv-chips' },
                readinessLive
                  ? h(FilterChip, {
                      label: t('filterReady'),
                      count: counts.ready ?? 0,
                      active: status === 'ready',
                      onClick: () => setStatus('ready'),
                      tone: statusTone('open'),
                    })
                  : null,
                readinessLive && hasEdges
                  ? h(FilterChip, {
                      // "Waiting", not "Blocked": `blocked` is a lifecycle status the
                      // chip row already offers, while this counts open issues whose
                      // blocking dependencies are still open.
                      label: t('filterWaiting'),
                      count: counts.waiting ?? 0,
                      active: status === 'waiting',
                      onClick: () => setStatus('waiting'),
                      tone: 'var(--dsw-alias-state-warn-primary, #d29922)',
                    })
                  : null,
                h(FilterChip, {
                  label: t('filterActive'),
                  count: counts.active,
                  active: status === 'active',
                  onClick: () => setStatus('active'),
                }),
                h(FilterChip, {
                  label: t('statusOpen'),
                  count: counts.open,
                  active: status === 'open',
                  onClick: () => setStatus('open'),
                  tone: statusTone('open'),
                }),
                h(FilterChip, {
                  label: t('statusInProgress'),
                  count: counts.in_progress,
                  active: status === 'in_progress',
                  onClick: () => setStatus('in_progress'),
                  tone: statusTone('in_progress'),
                }),
                h(FilterChip, {
                  label: t('statusBlocked'),
                  count: counts.blocked,
                  active: status === 'blocked',
                  onClick: () => setStatus('blocked'),
                  tone: statusTone('blocked'),
                }),
                h(FilterChip, {
                  label: t('statusClosed'),
                  count: counts.closed,
                  active: status === 'closed',
                  onClick: () => setStatus('closed'),
                  tone: statusTone('closed'),
                }),
                h(FilterChip, {
                  label: t('filterAll'),
                  count: counts.total,
                  active: status === 'all',
                  onClick: () => setStatus('all'),
                }),
              ),
              h(
                'div',
                { className: 'bv-subbar' },
                h(
                  'select',
                  {
                    className: 'bv-sort',
                    value: sort,
                    onChange: (event) => setSort(event.target.value),
                    title: t('sortLabel'),
                  },
                  SORTS.map((option) => h('option', { key: option.id, value: option.id }, t(option.labelKey))),
                ),
                h('span', { className: 'bv-subtle' }, t('shown', { n: visible.length })),
              ),
              renderListBody(),
            )
          : renderDetail(),
      )

      function renderListBody() {
        if (list.loading && list.data === null) {
          return h('div', { className: 'bv-empty' }, t('loadingList'))
        }
        if (list.error) {
          return h('div', { className: 'bv-empty bv-error' }, list.error)
        }
        if (list.data && list.data.ok === false) {
          return h(FailureCard, { data: list.data, cwd, onRetry: refresh })
        }
        if (visible.length === 0) {
          // Three different empty states, each with its own next step. "No issues
          // match this filter" is wrong for a tracker that has no issues at all,
          // and "no issues yet" is wrong when a filter is simply too narrow.
          const total = issues.length
          const message =
            total === 0
              ? 'This project has a Beads workspace but no issues yet. `bd create` adds the first one.'
              : `No issue matches this filter (${total} in the tracker).`
          return h('div', { className: 'bv-empty' }, message)
        }
        const rows = visible.slice(0, limit).map((issue) =>
          h(
            'div',
            {
              key: issue.id,
              className: 'bv-row',
              role: 'button',
              tabIndex: 0,
              onClick: () => setOpenId(issue.id),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setOpenId(issue.id)
                }
              },
            },
            h(
              'div',
              { className: 'bv-row-top' },
              h(StatusDot, { status: issue.status }),
              h('span', { className: 'bv-row-title' }, issue.title),
              // The date rides with the title, as `bv` does: on the badge line it
              // was pushed onto a third line by the badges and cost every row a
              // line of height.
              h('span', { className: 'bv-subtle bv-row-age' }, relativeTime(issue.updatedAt)),
            ),
            h(
              'div',
              { className: 'bv-row-meta' },
              h('span', { className: 'bv-mono bv-row-id' }, issue.id),
              // The three dimensions a triager scans for, each with its own hue:
              // status, priority, then type. Previously type was plain text and
              // priority only coloured at P0/P1, which read as an accident.
              h(Badge, { kind: 'status', value: issue.status }, issue.status.replace(/_/g, ' ')),
              h(Badge, { kind: 'priority', value: issue.priority }, priorityLabel(issue.priority)),
              h(Badge, { kind: 'type', value: issue.type }, issue.type),
              // A startable issue says so; a blocked one keeps its dependency
              // count, which is the number that explains the wait.
              issue.ready === true
                ? h('span', { className: 'bv-ready' }, t('ready'))
                : issue.ready === false && issue.status === 'open' && issue.dependencyCount > 0
                  ? h('span', { className: 'bv-waiting' }, t('waitingOn', { n: issue.dependencyCount }))
                  : null,
              issue.commentCount > 0 ? h('span', { className: 'bv-subtle' }, `💬 ${issue.commentCount}`) : null,
              issue.ready !== true && issue.dependencyCount > 0
                ? h('span', { className: 'bv-subtle' }, `⛓ ${issue.dependencyCount}`)
                : null,
            ),
            // Always rendered, even when empty: it is the row's third track, and
            // omitting it made label-less issues a line shorter than the rest.
            h(
              'div',
              { className: 'bv-row-labels' },
              issue.labels.slice(0, 4).map((label) => h('span', { key: label, className: 'bv-label' }, label)),
            ),
          ),
        )
        return h(
          'div',
          { className: 'bv-list' },
          rows,
          visible.length > limit
            ? h(
                'button',
                { type: 'button', className: 'bv-more', onClick: () => setLimit((value) => value + LIST_PAGE) },
                `Show ${Math.min(LIST_PAGE, visible.length - limit)} more`,
              )
            : null,
        )
      }

      function renderDetail() {
        const data = detail.data
        return h(
          'div',
          { className: 'bv-detailview' },
          h(
            'div',
            { className: 'bv-detailbar' },
            h(IconButton, { label: '←', title: t('back'), onClick: () => setOpenId(null) }),
            h('span', { className: 'bv-mono bv-detailid' }, openId),
            h('span', { className: 'bv-spacer' }),
            h(IconButton, { label: '⧉', title: t('copyIssueId'), onClick: () => copyId(openId) }),
            h(IconButton, { label: '↵', title: t('insertIssueId'), onClick: () => insertId(openId) }),
          ),
          detail.loading
            ? h('div', { className: 'bv-empty' }, t('loadingIssue'))
            : detail.error
              ? h('div', { className: 'bv-empty bv-error' }, detail.error)
              : data && data.ok === false
                ? h(FailureCard, { data, cwd, onRetry: () => setRevision((value) => value + 1) })
                : data
                  ? renderIssue(data.issue, data.comments, data.dependents)
                  : null,
        )
      }

      function renderIssue(issue, comments, dependents) {
        return h(
          'div',
          { className: 'bv-issue' },
          h(
            'div',
            { className: 'bv-issue-head' },
            h('h2', { className: 'bv-issue-title' }, issue.title),
            h(
              'div',
              { className: 'bv-issue-badges' },
              h(Badge, { kind: 'status', value: issue.status }, issue.status.replace(/_/g, ' ')),
              h(Badge, { kind: 'priority', value: issue.priority }, priorityLabel(issue.priority)),
              h(Badge, { kind: 'type', value: issue.type }, issue.type),
              issue.assignee ? h(Badge, null, `@${issue.assignee}`) : null,
              ...issue.labels.map((label) => h(Badge, { key: label }, label)),
            ),
            h(
              'div',
              { className: 'bv-issue-meta' },
              h('span', null, `created ${relativeTime(issue.createdAt)}`),
              h('span', null, `updated ${relativeTime(issue.updatedAt)}`),
              issue.closedAt ? h('span', null, `closed ${relativeTime(issue.closedAt)}`) : null,
              h('span', null, t('comments', { n: issue.commentCount })),
            ),
            h(
              'div',
              { className: 'bv-issue-actions' },
              h(
                'button',
                { type: 'button', className: 'bv-action', onClick: () => copyId(issue.id) },
                t('copyId'),
              ),
              h(
                'button',
                { type: 'button', className: 'bv-action', onClick: () => insertId(issue.id) },
                t('insertId'),
              ),
            ),
          ),
          issue.description
            ? h('div', { className: 'bv-description' }, h(Markdown, { text: issue.description, ctx: mdCtx }))
            : h('div', { className: 'bv-empty' }, t('noDescription')),
          issue.acceptanceCriteria
            ? h(
                'section',
                { className: 'bv-section' },
                h('h3', { className: 'bv-section-title' }, 'Acceptance criteria'),
                h(Markdown, { text: issue.acceptanceCriteria, ctx: mdCtx }),
              )
            : null,
          issue.design
            ? h(
                'section',
                { className: 'bv-section' },
                h('h3', { className: 'bv-section-title' }, 'Design'),
                h(Markdown, { text: issue.design, ctx: mdCtx }),
              )
            : null,
          issue.notes
            ? h(
                'section',
                { className: 'bv-section' },
                h('h3', { className: 'bv-section-title' }, 'Notes'),
                h(Markdown, { text: issue.notes, ctx: mdCtx }),
              )
            : null,
          issue.closeReason
            ? h(
                'section',
                { className: 'bv-section' },
                h('h3', { className: 'bv-section-title' }, 'Close reason'),
                h(Markdown, { text: issue.closeReason, ctx: mdCtx }),
              )
            : null,
          issue.dependencies.length > 0
            ? h(
                'section',
                { className: 'bv-section' },
                h('h3', { className: 'bv-section-title' }, `Depends on (${issue.dependencies.length})`),
                h(
                  'div',
                  { className: 'bv-relations' },
                  issue.dependencies.map((dep) =>
                    h(RelationRow, {
                      key: `${dep.id}-${dep.type}`,
                      id: dep.id,
                      title: dep.title,
                      type: dep.type,
                      status: dep.status,
                      known: knownIds.has(dep.id),
                      onOpen: () => setOpenId(dep.id),
                    }),
                  ),
                ),
              )
            : null,
          dependents.length > 0
            ? h(
                'section',
                { className: 'bv-section' },
                h('h3', { className: 'bv-section-title' }, `Blocks (${dependents.length})`),
                h(
                  'div',
                  { className: 'bv-relations' },
                  dependents.map((dep) =>
                    h(RelationRow, {
                      key: `${dep.id}-${dep.type}`,
                      id: dep.id,
                      title: dep.title,
                      type: dep.type,
                      status: dep.status,
                      known: knownIds.has(dep.id),
                      onOpen: () => setOpenId(dep.id),
                    }),
                  ),
                ),
              )
            : null,
          comments.length > 0
            ? h(
                'section',
                { className: 'bv-section' },
                h(
                  'div',
                  { className: 'bv-section-head' },
                  h('h3', { className: 'bv-section-title' }, `Comments (${comments.length})`),
                  comments.length > COLLAPSED_COMMENTS
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'bv-linkbtn',
                          onClick: () => setShowAllComments((value) => !value),
                        },
                        showAllComments
                          ? t('collapse')
                          : t('showAll', { n: comments.length }),
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'bv-comments' },
                  // A long thread opens on its most recent activity: that is what a
                  // reader returns to, and the older comments stay one click away.
                  comments
                    .slice(showAllComments ? 0 : -COLLAPSED_COMMENTS)
                    .map((comment, index) =>
                      h(
                        'article',
                        { key: comment.id || index, className: 'bv-comment' },
                        h(
                          'header',
                          { className: 'bv-comment-head' },
                          h('span', { className: 'bv-comment-author' }, comment.author || 'unknown'),
                          h('span', { className: 'bv-subtle' }, relativeTime(comment.createdAt)),
                        ),
                        h(Markdown, { text: comment.text, ctx: mdCtx }),
                      ),
                    ),
                  !showAllComments && comments.length > COLLAPSED_COMMENTS
                    ? h(
                        'div',
                        { className: 'bv-subtle bv-comments-hidden' },
                        `${comments.length - COLLAPSED_COMMENTS} earlier comments hidden`,
                      )
                    : null,
                ),
              )
            : null,
          toast ? h('div', { className: 'bv-toast' }, toast) : null,
        )
      }
    }

    function RelationRow({ id, title, type, status, known, onOpen }) {
      return h(
        'button',
        {
          type: 'button',
          className: known ? 'bv-relation bv-relation-link' : 'bv-relation',
          onClick: known ? onOpen : undefined,
          disabled: !known,
          title: known ? `Open ${id}` : `${id} is not in the current list`,
        },
        h(StatusDot, { status }),
        h('span', { className: 'bv-mono bv-relation-id' }, id),
        h('span', { className: 'bv-relation-title' }, title || type || ''),
        h('span', { className: 'bv-subtle' }, type),
      )
    }

    function FailureCard({ data, cwd, onRetry }) {
      const hints = {
        'no-workspace': 'Run `bd init` in this project to create one.',
        'needs-migration': 'Follow the upgrade guide the bd CLI printed below, then retry.',
        'bd-missing': 'Install Beads (brew install beads) so the panel can read the issue database.',
        'bad-json': 'The bd output was not JSON — check the CLI version.',
      }
      return h(
        'div',
        { className: 'bv-failure' },
        h('div', { className: 'bv-failure-title' }, data.message ?? 'Beads is unavailable'),
        hints[data.code] ? h('div', { className: 'bv-failure-hint' }, hints[data.code]) : null,
        data.cwd ? h('div', { className: 'bv-subtle bv-mono bv-failure-cwd' }, data.cwd) : null,
        data.detail
          ? h('pre', { className: 'bv-failure-detail' }, String(data.detail).slice(0, 1200))
          : null,
        h(
          'button',
          { type: 'button', className: 'bv-action', onClick: onRetry },
          t('retry'),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles (theme tokens only)
     * ------------------------------------------------------------------ */

    /*
     * Issue tables are wider than the ~390px pane. `width:max-content` keeps each
     * column at its natural width and lets `.bv-tablewrap` scroll; `width:100%`
     * squeezed a `#` column to one character and broke words mid-glyph.
     */
    const CSS = `
.bv-root{
  /* One local base for the whole panel. Jumps of -1px per step below are computed
     from the user's own text size, so the sidebar tracks the setting exactly
     instead of through a clamped derived token. */
  /* Panel scales from the user's text size. */
  --bv-font: calc(var(--dsh-content-font-size, 14px) - 1px);
  --bv-teal: #14b8a6;
  --bv-line: 1.7;
  display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--dsh-font-family-text,var(--dsw-font-family,system-ui,-apple-system,sans-serif));font-size:var(--bv-font);line-height:1.55;background:transparent}
.bv-listview,.bv-detailview{display:flex;flex-direction:column;min-height:0;height:100%}
.bv-toolbar{display:flex;gap:6px;align-items:center;padding:8px 10px 4px}
.bv-search{flex:1;min-width:0;min-height:calc(var(--bv-font) * 2);padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:calc(var(--bv-font) - 1px)}
.bv-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.bv-iconbtn{min-height:calc(var(--bv-font) * 2);min-width:calc(var(--bv-font) * 2);padding:2px 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:var(--bv-font);line-height:1}
.bv-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.bv-iconbtn-active{border-color:var(--dsw-alias-brand-primary)}
.bv-chips{display:flex;flex-wrap:wrap;gap:4px;padding:2px 10px 6px}
.bv-chip{display:inline-flex;align-items:center;gap:4px;min-height:calc(var(--bv-font) * 1.7);padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:calc(var(--bv-font) - 2px);cursor:pointer}
.bv-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))}
.bv-chip-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.bv-chip-count{opacity:.6;font-variant-numeric:tabular-nums}
.bv-subbar{display:flex;align-items:center;gap:8px;padding:0 10px 6px}
.bv-sort{min-height:calc(var(--bv-font) * 1.8);border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:calc(var(--bv-font) - 2px);padding:1px 4px}
.bv-subtle{color:var(--dsw-alias-label-secondary);font-size:calc(var(--bv-font) - 2px)}
.bv-mono{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)}
.bv-list{flex:1;min-height:0;overflow:auto;padding:0 6px 12px}
/* Rows are plain until pointed at; the teal wash is a hover signal, not a resting
   surface. Mixed from one hue against transparent rather than a fixed light value:
   the theme ships no teal family, and a literal teal-100 (#e6faed) leaves white
   text at 1.09:1 on the dark surface. Mixing keeps 12-14:1 in both themes. */
.bv-row{
  /* Exactly three line boxes: title, badges, labels. The height is 3lh plus the
     vertical padding, so it follows the text metrics instead of any pixel or
     font-size multiplier. The label track is reserved even when an issue has none,
     which is what keeps every row identical; the three tracks split that height
     evenly so content cannot change it. */
  --bv-row-pad-y: .45em;
  line-height:var(--bv-line);
  height:calc(3 * 1lh + 2 * var(--bv-row-pad-y));
  box-sizing:border-box;overflow:hidden;
  display:grid;grid-template-rows:repeat(3, 1fr);align-items:stretch;
  padding:var(--bv-row-pad-y) .6em;border-radius:8px;cursor:pointer;
  border:1px solid transparent}
.bv-row:hover{
  background:color-mix(in srgb, var(--bv-teal) 14%, transparent);
  border-color:color-mix(in srgb, var(--bv-teal) 38%, transparent)}
.bv-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.bv-row-top{
  display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;
  column-gap:6px;min-width:0;min-height:0}
.bv-row-title{
  /* One line, cut at the container edge. A clamped two-line title made every row a
     different height, so the list could not be scanned down a column. */
  grid-column:2;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.bv-row-meta{
  /* One line, never wrapped: a second line would make this row taller than its
     neighbours. Whatever does not fit scrolls out of sight rather than reflowing. */
  display:flex;align-items:center;gap:6px;flex-wrap:nowrap;
  overflow:hidden;min-height:0}
.bv-row-id{font-size:calc(var(--bv-font) - 2px);color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
/* The badges and the date never break across lines; only the id gives way. */
.bv-row-meta>.bv-badge,.bv-row-meta>.bv-ready,.bv-row-meta>.bv-waiting{flex:none}
.bv-ready{font-size:calc(var(--bv-font) - 3px);letter-spacing:.03em;color:var(--dsw-alias-state-success-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);border-radius:4px;padding:0 4px;line-height:1.35}
.bv-waiting{font-size:calc(var(--bv-font) - 3px);color:var(--dsw-alias-state-warn-primary);opacity:.9}
.bv-row-labels{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;overflow:hidden;min-height:0}
.bv-right{margin-left:auto}
.bv-row-age{grid-column:3;font-size:calc(var(--bv-font) - 2.5px);padding-left:8px}
.bv-titleicon{display:inline-flex;align-items:center;flex:none;margin-right:5px;vertical-align:-2px}\n.bv-dot{width:.55em;height:.55em;border-radius:50%;flex:none;display:inline-block;margin-top:.3em}
.bv-badge{display:inline-flex;align-items:center;min-height:calc(var(--bv-font) * 1.35);padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);font-size:calc(var(--bv-font) - 2.5px);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bv-badge-solid{border-color:transparent;font-weight:600;letter-spacing:.01em}
/* Shape repeats what the hue says, because three dimensions share one row and
   only a handful of hue families exist: a pill is a status, a sharp-cornered
   block is a priority, a soft square is a type. */
.bv-badge-status{border-radius:999px;text-transform:lowercase}
.bv-badge-priority{border-radius:3px;font-family:var(--ds-font-family-code, ui-monospace, Menlo, monospace)}
.bv-badge-type{border-radius:5px;font-weight:500}
.bv-label{font-size:calc(var(--bv-font) - 2.5px);padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.bv-more{margin:8px auto;display:block;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:calc(var(--bv-font) - 1.5px)}
.bv-empty{padding:24px 16px;color:var(--dsw-alias-label-secondary);font-size:calc(var(--bv-font) - 1px);text-align:center}
.bv-error{color:var(--dsw-alias-state-error-primary)}
.bv-detailbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;background:var(--dsw-alias-bg-base);z-index:2}
.bv-detailid{font-size:calc(var(--bv-font) - 1.5px);color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bv-spacer{flex:1}
.bv-issue{flex:1;min-height:0;overflow:auto;padding:10px 12px 24px}
.bv-issue-head{padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:10px}
.bv-issue-title{margin:0 0 6px;font-size:calc(var(--bv-font) + 2px);line-height:1.4;font-weight:600}
.bv-issue-badges{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
.bv-issue-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-alias-label-secondary);font-size:calc(var(--bv-font) - 2px)}
.bv-issue-actions{display:flex;gap:6px;margin-top:8px}
.bv-action{min-height:calc(var(--bv-font) * 1.8);padding:1px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:calc(var(--bv-font) - 1.5px);cursor:pointer}
.bv-action:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bv-md{overflow-wrap:break-word}
.bv-description{
  /* The description gets breathing room of its own. Applied here rather than on
     .bv-md, because sections render their own .bv-md inside padding they already
     have and would end up with a double inset. */
  padding:12px 14px;border-radius:8px}
.bv-md>*:first-child{margin-top:0}
.bv-p{margin:0 0 9px}
.bv-h{margin:16px 0 7px;line-height:1.35;font-weight:600}
.bv-h1{font-size:calc(var(--bv-font) + 2px);padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.bv-h2{font-size:calc(var(--bv-font) + 1px)}
.bv-h3{font-size:var(--bv-font)}
.bv-h4,.bv-h5,.bv-h6{font-size:calc(var(--bv-font) + 0.5px);color:var(--dsw-alias-label-secondary)}
.bv-mlist{
  /* A native marker is placed just outside the content box at whatever width the
     glyph needs, so a wide marker like "10." reaches further left than a bullet and
     the list looks less indented. The gutter below is a fixed-width box instead, so
     numbers and bullets start at the same x. */
  list-style:none;margin:0 0 9px;padding-left:1.9em}
/* A number is wider than a bullet, so at an equal gutter its ink sits further left
   and the list reads as LESS indented. The ordered list therefore gets a wider
   gutter: the number's ink starts on the same line as a bullet's, and the numbered
   text lands further right. */
.bv-mli{position:relative}
.bv-mli::before{
  position:absolute;left:-1.9em;width:1.9em;box-sizing:border-box;
  text-align:right;padding-right:.28em;
  color:var(--dsw-alias-label-secondary);content:""}

ul.bv-mlist>.bv-mli::before{content:"•"}
ol.bv-mlist{counter-reset:bv-li;padding-left:2.35em}
ol.bv-mlist>.bv-mli{counter-increment:bv-li}
ol.bv-mlist>.bv-mli::before{left:-2.35em;width:2.35em;content:counter(bv-li) "."}
.bv-mlist-nested{margin:3px 0 0;padding-left:1.7em}
.bv-mlist-nested>.bv-mli::before{left:-1.7em;width:1.7em}
.bv-mli{margin:2px 0}
.bv-mli-task{list-style:none;margin-left:-16px;display:flex;gap:6px;align-items:flex-start}
.bv-check{margin-top:4px;flex:none}
.bv-code{font-family:var(--ds-font-family-code, ui-monospace, Menlo, monospace);font-size:var(--dsh-code-font-size,11px);padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.bv-code-link{cursor:pointer;color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent)}
.bv-code-link:hover{text-decoration:underline}
.bv-pre{position:relative;margin:0 0 10px;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow:auto;font-size:var(--dsh-code-font-size,11px);line-height:1.5}
.bv-pre code{font-family:var(--ds-font-family-code, ui-monospace, Menlo, monospace);white-space:pre}
.bv-lang{position:absolute;top:5px;right:8px;font-size:calc(var(--bv-font) - 3.5px);letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.7;text-transform:uppercase}
.bv-hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0}
.bv-quote{margin:0 0 10px;padding:2px 0 2px 10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.bv-tablewrap{overflow-x:auto;margin:0 0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.bv-table{border-collapse:collapse;width:max-content;min-width:100%;font-size:calc(var(--bv-font) - 1.5px)}
.bv-table th,.bv-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top;overflow-wrap:normal;word-break:normal}
.bv-table th{background:var(--dsw-alias-bg-layer-1);font-weight:600;white-space:nowrap}
.bv-table td:first-child{white-space:nowrap}
.bv-table tr:last-child td{border-bottom:none}
.bv-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.bv-link:hover{text-decoration:underline}
.bv-filelink{display:inline;padding:0 3px;margin:0 1px;border-radius:4px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code, ui-monospace, Menlo, monospace);font-size:calc(var(--bv-font) - 1.5px);cursor:pointer}
.bv-filelink:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bv-fileline{opacity:.6}
.bv-issuelink{padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-family:var(--ds-font-family-code, ui-monospace, Menlo, monospace);font-size:calc(var(--bv-font) - 2px);cursor:pointer}
.bv-issuelink:hover{border-color:var(--dsw-alias-brand-primary)}
.bv-section{
  /* Secondary content — design, notes, acceptance criteria, close reason — gets a
     faint wash so the description stays the thing you read first. Mixed from the
     panel accent against transparent rather than a literal gray-50: that value is
     theme-invariant and leaves light text at 1.0:1 on the dark surface. */
  margin-top:12px;padding:9px 11px;border-radius:8px;
  background:color-mix(in srgb, var(--bv-teal) 4%, transparent);
  border:1px solid color-mix(in srgb, var(--bv-teal) 14%, transparent)}
.bv-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.bv-section-head .bv-section-title{
  margin:0;font-size:calc(var(--bv-font) - 2px);font-weight:600;
  letter-spacing:.02em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary)}
.bv-linkbtn{border:none;background:transparent;padding:0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:calc(var(--bv-font) - 2px);cursor:pointer}
.bv-linkbtn:hover{text-decoration:underline}
.bv-comments-hidden{text-align:center;padding:2px 0 4px}
.bv-section-title{margin:0 0 8px;font-size:calc(var(--bv-font) - 2px);letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);font-weight:600}
.bv-relations{display:flex;flex-direction:column;gap:3px}
.bv-relation{display:flex;align-items:center;gap:7px;width:100%;padding:4px 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default}
.bv-relation-link{cursor:pointer}
.bv-relation-link:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.bv-relation-id{font-size:calc(var(--bv-font) - 2px);color:var(--dsw-alias-label-secondary);flex:none}
.bv-relation-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(var(--bv-font) - 1px)}
.bv-comments{display:flex;flex-direction:column;gap:8px}
.bv-comment{
  /* Transparent, because the comments section already carries the wash: tinting
     both stacked two 4% layers into 8% and the thread looked heavier than the
     description it is supposed to sit behind. The border alone separates entries. */
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;padding:8px 10px;background:transparent}
.bv-comment-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
.bv-comment-author{font-size:calc(var(--bv-font) - 1.5px);font-weight:600}
.bv-failure{margin:16px 12px;padding:12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1)}
.bv-failure-title{font-weight:600;margin-bottom:4px}
.bv-failure-hint{color:var(--dsw-alias-label-secondary);font-size:calc(var(--bv-font) - 1px);margin-bottom:6px}
.bv-failure-cwd{font-size:calc(var(--bv-font) - 2.5px);margin-bottom:6px;word-break:break-all}
.bv-failure-detail{margin:0 0 8px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:calc(var(--bv-font) - 2px);white-space:pre-wrap;max-height:220px;overflow:auto}
.bv-toast{position:sticky;bottom:8px;margin:8px auto 0;width:max-content;padding:5px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);font-size:calc(var(--bv-font) - 1.5px);box-shadow:0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)}
`

    function StyleSheet() {
      return h('style', { 'data-dsh-plugin-css': 'dsh-beads-viewer' }, CSS)
    }

    /* ------------------------------------------------------------------ *
     * Guide glyph
     * ------------------------------------------------------------------ */

    /**
     * The tab chip's own title.
     *
     * The sidebar renders a chip from the tab record unless the type contributes a
     * component at `sidebar.right.pane.tab.title`. Without one the chip shows text
     * only — which is why the start-list entry (that uses `guide[].icon`) had a
     * glyph while the open tab did not. Same key as the body, so both follow one
     * record.
     */
    function BeadsTitle(props) {
      const info = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const title = info?.tab?.title ?? t('tab')
      return h(
        React.Fragment,
        null,
        h('span', { className: 'bv-titleicon' }, h(BeadsGlyph, { size: 14 })),
        title,
      )
    }

    function BeadsGlyph({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M5.2 1.6h5.6L13.4 5v6L10.8 13.6H5.2L2.6 11V5L5.2 1.6Z',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 5.6, cy: 7.6, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 10.2, r: 1.15, fill: 'currentColor' }),
        h('circle', { cx: 10.4, cy: 7.6, r: 1.15, fill: 'currentColor' }),
        h('path', { d: 'M5.6 7.6 8 10.2l2.4-2.6', stroke: 'currentColor', strokeWidth: '1' }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Dictionaries
     * ------------------------------------------------------------------ */

    /*
     * Copy lives here rather than inline so the panel can follow the Host's
     * Language setting. Placeholders use the same `{name}` form the Host's own
     * dictionaries use, so `locale.bind` substitution works unchanged.
     */
    const ZH = {
      tab: 'Beads',
      guideDesc: '浏览本项目的 Beads 议题：筛选、阅读 Markdown、点开文件、复制或插入 issue id',
      search: '搜索议题…  ( / )',
      refresh: '刷新',
      filterReady: '可开工',
      filterWaiting: '等待中',
      filterActive: '进行中',
      filterAll: '全部',
      statusOpen: '待办',
      statusInProgress: '处理中',
      statusBlocked: '受阻',
      statusClosed: '已完成',
      statusDeferred: '搁置',
      statusPinned: '已固定',
      statusHooked: '挂接',
      sortLabel: '排序',
      sortUpdated: '按更新',
      sortPriority: '按优先级',
      sortCreated: '按创建',
      sortId: '按编号',
      shown: '共 {n} 条',
      loadingList: '正在读取 Beads 议题…',
      loadingIssue: '正在读取议题…',
      copyId: '复制 ID',
      insertId: '插入输入框',
      noDescription: '没有描述。',
      collapse: '收起',
      showAll: '展开全部 {n} 条',
      earlierHidden: '更早的 {n} 条评论已折叠',
      retry: '重试',
      back: '返回列表（Esc）',
      copyIssueId: '复制 issue id',
      insertIssueId: '把 issue id 插入输入框',
      comments: '{n} 条评论',
      created: '创建',
      updated: '更新',
      priority: '优先级',
      acceptance: '验收标准',
      notes: '备注',
      design: '设计',
      closeReason: '关闭原因',
      ready: '可开工',
      waitingOn: '等待 {n} 项',
    }
    const EN = {
      tab: 'Beads',
      guideDesc: 'Browse this project\u2019s Beads issues \u2014 filter, read the rendered Markdown, open referenced files, copy or insert ids',
      search: 'Search issues\u2026  ( / )',
      refresh: 'Refresh',
      filterReady: 'Ready',
      filterWaiting: 'Waiting',
      filterActive: 'Active',
      filterAll: 'All',
      statusOpen: 'Open',
      statusInProgress: 'In progress',
      statusBlocked: 'Blocked',
      statusClosed: 'Closed',
      statusDeferred: 'Deferred',
      statusPinned: 'Pinned',
      statusHooked: 'Hooked',
      sortLabel: 'Sort',
      sortUpdated: 'Updated',
      sortPriority: 'Priority',
      sortCreated: 'Created',
      sortId: 'ID',
      shown: '{n} shown',
      loadingList: 'Loading Beads issues\u2026',
      loadingIssue: 'Loading issue\u2026',
      copyId: 'Copy id',
      insertId: 'Insert into composer',
      noDescription: 'No description.',
      collapse: 'Collapse',
      showAll: 'Show all {n}',
      earlierHidden: '{n} earlier comments hidden',
      retry: 'Retry',
      back: 'Back to the list (Esc)',
      copyIssueId: 'Copy issue id',
      insertIssueId: 'Insert issue id into the composer',
      comments: '{n} comments',
      created: 'Created',
      updated: 'Updated',
      priority: 'Priority',
      acceptance: 'Acceptance criteria',
      notes: 'Notes',
      design: 'Design',
      closeReason: 'Close reason',
      ready: 'ready',
      waitingOn: 'waiting on {n}',
    }

    /**
     * Dictionary the panel is currently drawing from. The Host drives the swap: it
     * re-renders slot occupants on a locale change, and this value is refreshed by
     * the subscription set up in `apply`, so the next render reads the new words.
     */
    let dictionary = EN

    /**
     * The Host locale service, once `apply` has seen it. The panel subscribes
     * through this so its copy refreshes even if a change lands while this
     * particular slot is not being re-rendered.
     */
    let localeService = null

    /** One copy string with `{name}` placeholders filled in. */
    function t(key, params) {
      const template = dictionary[key] ?? EN[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) =>
        params[name] === undefined ? whole : String(params[name]),
      )
    }

    /* ------------------------------------------------------------------ *
     * Activation
     * ------------------------------------------------------------------ */

    /**
     * Activate the panel.
     *
     * `sidebarRightTabs` is not in the module's `inject` list on purpose: it is
     * a registry another package provides, and a profile without the right
     * sidebar should simply show nothing rather than fail this plugin. Waiting
     * for it through `ctx.inject` also survives activation order, and both
     * registrations are owned by that child context, so they disappear with the
     * service instead of pointing at a dead registry.
     */
    function apply(ctx) {
      // Locale is optional: without it the tab keeps its English copy instead of
      // showing raw keys, and the panel still works.
      let translate = (key) => EN[key] ?? key
      const locale = ctx.get ? ctx.get('locale') : undefined
      if (locale !== undefined) {
        localeService = locale
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'beads-viewer: dictionaries')
        translate = locale.bind(NS)
        // The Host re-renders slot occupants on a locale change, but the render
        // reads the module dictionary, so it has to be swapped before that render
        // happens. Reading the snapshot once also covers a language chosen before
        // this plugin loaded.
        if (typeof locale.subscribe === 'function') {
          // The Host notifies subscribers with no argument (`fn()`), so the
          // snapshot has to be read back from the service. Destructuring the
          // callback parameter instead throws inside the Host's notify loop,
          // which is caught and logged as "locale subscriber crashed" — the
          // dictionary then never changes and the language switch looks dead.
          const readLanguage = () =>
            typeof locale.getSnapshot === 'function' ? locale.getSnapshot()?.active : undefined
          ctx.effect(
            () =>
              locale.subscribe(() => {
                dictionary = readLanguage() === 'zh' ? ZH : EN
              }),
            'beads-viewer: active dictionary',
          )
          dictionary = readLanguage() === 'zh' ? ZH : EN
        }
      }

      const wire = (scope) => {
        const tabs = scope.get ? scope.get('sidebarRightTabs') : undefined
        if (tabs === undefined) return
        scope.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              // Keeping the body mounted is what makes the panel feel like a
              // page rather than a query: the chosen filter, the search text, the
              // open issue and the scroll position all survive a tab switch.
              keepMounted: true,
              title: () => translate('tab'),
              guide: [
                {
                  id: TAB_KIND,
                  order: 40,
                  title: () => translate('tab'),
                  description: () => translate('guideDesc'),
                  icon: BeadsGlyph,
                },
              ],
            }),
          'beads-viewer: tab type',
        )
        scope.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, BeadsPanel),
            ),
          'beads-viewer: panel body',
        )
        // The chip needs its own seat; the body registration does not cover it.
        scope.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, BeadsTitle),
            ),
          'beads-viewer: tab chip title',
        )
      }

      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs', 'slots'], (scope) => wire(scope))
      } else {
        wire(ctx)
      }
    }

    return {
      inject: ['slots'],
      apply,
      /** Test seam: pure helpers exercised by `npm test` in Node. */
      __test: {
        BeadsTitle,
        // Copy and the active-dictionary switch, so the suites can prove a
        // language change reaches the rendered strings.
        t,
        setLanguage(language) {
          dictionary = language === 'zh' ? ZH : EN
        },
        /** Install (or clear) the locale service the panel subscribes to. */
        setLocaleService(service) {
          localeService = service
        },
        /** The service `apply` published for the panel's own subscription. */
        getLocaleService() {
          return localeService
        },
        ZH,
        EN,
        parseBlocks,
        extractPaths,
        splitPathToken,
        fileAddress,
        relativeTime,
        renderBlocks,
        renderInline,
        plainRun,
        Markdown,
        BeadsPanel,
        statusTone,
        priorityLabel,
        Badge,
        badgeFor,
        PRIORITY_BADGE,
        TYPE_BADGE,
        STATUS_BADGE,
      },
    }
  },
})
