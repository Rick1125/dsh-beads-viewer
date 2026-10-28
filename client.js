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

    /** Markdown-ish extensions that are worth offering as file links. */
    const FILE_EXT =
      '(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|css|scss|html|vue|svelte|yml|yaml|toml|ini|cfg|sh|bash|zsh|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|sql|txt|lock|env|proto|graphql|tf)'

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
      `(?<pfx>(?:\\.{0,2}\\/)?(?:[\\w.@+-]+\\/)+[\\w.@+-]+\\.${FILE_EXT}(?::\\d+(?:-\\d+)?)?)` +
      `|(?<pbare>(?:\\.{0,2}\\/)?[\\w.@+-]+\\.${FILE_EXT}(?::\\d+(?:-\\d+)?)?)`

    /** An issue id as Beads mints it: `prefix-abc123`, optionally with `.1` children. */
    // Beads mints ids as `prefix-suffix` with a mixed-case suffix (`proj-Phc908`),
    // so both cases are accepted; a candidate only becomes a link when it names an
    // issue in the list, which is what keeps ordinary hyphenated prose out.
    const ISSUE_ID_SRC = '(?<iid>[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-[A-Za-z0-9]{2,6}(?:\\.[0-9]+)*)'

    const BOUNDARY = '[\\s(`\'"\\[<,;:*]'

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
              items.push({ indent: item[1].replace(/\t/g, '  ').length, ordered, text: item[3] })
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

    function Badge({ children, tone, title }) {
      const style = tone === undefined ? undefined : { color: tone, borderColor: tone }
      return h('span', { className: 'bv-badge', style, title }, children)
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
      { id: 'updated', label: 'Updated' },
      { id: 'priority', label: 'Priority' },
      { id: 'created', label: 'Created' },
      { id: 'id', label: 'ID' },
    ]

    function BeadsPanel(props) {
      const { sessionId, useSessions, inputActions } = props
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
          } else if (status === 'blocked') {
            if (issue.status === 'closed' || issue.ready !== false) return false
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
        const onFocus = () => setRevision((value) => value + 1)
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && openId !== null) {
            event.stopPropagation()
            setOpenId(null)
            return
          }
          if (event.key === '/' && document.activeElement !== searchRef.current) {
            const tag = document.activeElement?.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA') return
            event.preventDefault()
            searchRef.current?.focus()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [openId])

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
                  placeholder: 'Search issues…  ( / )',
                  onChange: (event) => setQuery(event.target.value),
                  spellCheck: false,
                }),
                h(IconButton, { label: '⟳', title: 'Refresh', onClick: refresh }),
              ),
              h(
                'div',
                { className: 'bv-chips' },
                readinessLive
                  ? h(FilterChip, {
                      label: 'Ready',
                      count: counts.ready ?? 0,
                      active: status === 'ready',
                      onClick: () => setStatus('ready'),
                      tone: statusTone('open'),
                    })
                  : null,
                readinessLive && hasEdges
                  ? h(FilterChip, {
                      label: 'Blocked',
                      count: counts.waiting ?? 0,
                      active: status === 'blocked',
                      onClick: () => setStatus('blocked'),
                      tone: statusTone('blocked'),
                    })
                  : null,
                h(FilterChip, {
                  label: 'Active',
                  count: counts.active,
                  active: status === 'active',
                  onClick: () => setStatus('active'),
                }),
                h(FilterChip, {
                  label: 'Open',
                  count: counts.open,
                  active: status === 'open',
                  onClick: () => setStatus('open'),
                  tone: statusTone('open'),
                }),
                h(FilterChip, {
                  label: 'In progress',
                  count: counts.in_progress,
                  active: status === 'in_progress',
                  onClick: () => setStatus('in_progress'),
                  tone: statusTone('in_progress'),
                }),
                h(FilterChip, {
                  label: 'Blocked',
                  count: counts.blocked,
                  active: status === 'blocked',
                  onClick: () => setStatus('blocked'),
                  tone: statusTone('blocked'),
                }),
                h(FilterChip, {
                  label: 'Closed',
                  count: counts.closed,
                  active: status === 'closed',
                  onClick: () => setStatus('closed'),
                  tone: statusTone('closed'),
                }),
                h(FilterChip, {
                  label: 'All',
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
                    title: 'Sort',
                  },
                  SORTS.map((option) => h('option', { key: option.id, value: option.id }, option.label)),
                ),
                h('span', { className: 'bv-subtle' }, `${visible.length} shown`),
              ),
              renderListBody(),
            )
          : renderDetail(),
      )

      function renderListBody() {
        if (list.loading && list.data === null) {
          return h('div', { className: 'bv-empty' }, 'Loading Beads issues…')
        }
        if (list.error) {
          return h('div', { className: 'bv-empty bv-error' }, list.error)
        }
        if (list.data && list.data.ok === false) {
          return h(FailureCard, { data: list.data, cwd, onRetry: refresh })
        }
        if (visible.length === 0) {
          return h('div', { className: 'bv-empty' }, list.data && list.data.truncated ? 'No issue matches this filter.' : 'No issues match this filter.')
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
            ),
            h(
              'div',
              { className: 'bv-row-meta' },
              h('span', { className: 'bv-mono bv-row-id' }, issue.id),
              h(Badge, { tone: issue.priority <= 1 ? 'var(--dsw-alias-state-warn-primary, #d29922)' : undefined }, priorityLabel(issue.priority)),
              h('span', { className: 'bv-subtle' }, issue.type),
              // A startable issue says so; a blocked one keeps its dependency
              // count, which is the number that explains the wait.
              issue.ready === true
                ? h('span', { className: 'bv-ready' }, 'ready')
                : issue.ready === false && issue.status === 'open' && issue.dependencyCount > 0
                  ? h('span', { className: 'bv-waiting' }, `waiting on ${issue.dependencyCount}`)
                  : null,
              issue.commentCount > 0 ? h('span', { className: 'bv-subtle' }, `💬 ${issue.commentCount}`) : null,
              issue.ready !== true && issue.dependencyCount > 0
                ? h('span', { className: 'bv-subtle' }, `⛓ ${issue.dependencyCount}`)
                : null,
              h('span', { className: 'bv-subtle bv-right' }, relativeTime(issue.updatedAt)),
            ),
            issue.labels.length > 0
              ? h(
                  'div',
                  { className: 'bv-row-labels' },
                  issue.labels.slice(0, 4).map((label) => h('span', { key: label, className: 'bv-label' }, label)),
                )
              : null,
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
            h(IconButton, { label: '←', title: 'Back to the list (Esc)', onClick: () => setOpenId(null) }),
            h('span', { className: 'bv-mono bv-detailid' }, openId),
            h('span', { className: 'bv-spacer' }),
            h(IconButton, { label: '⧉', title: 'Copy issue id', onClick: () => copyId(openId) }),
            h(IconButton, { label: '↵', title: 'Insert issue id into the composer', onClick: () => insertId(openId) }),
          ),
          detail.loading
            ? h('div', { className: 'bv-empty' }, 'Loading issue…')
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
              h(Badge, { tone: statusTone(issue.status) }, issue.status),
              h(Badge, { tone: issue.priority <= 1 ? 'var(--dsw-alias-state-warn-primary, #d29922)' : undefined }, priorityLabel(issue.priority)),
              h(Badge, null, issue.type),
              issue.assignee ? h(Badge, null, `@${issue.assignee}`) : null,
              ...issue.labels.map((label) => h(Badge, { key: label }, label)),
            ),
            h(
              'div',
              { className: 'bv-issue-meta' },
              h('span', null, `created ${relativeTime(issue.createdAt)}`),
              h('span', null, `updated ${relativeTime(issue.updatedAt)}`),
              issue.closedAt ? h('span', null, `closed ${relativeTime(issue.closedAt)}`) : null,
              h('span', null, `${issue.commentCount} comments`),
            ),
            h(
              'div',
              { className: 'bv-issue-actions' },
              h(
                'button',
                { type: 'button', className: 'bv-action', onClick: () => copyId(issue.id) },
                'Copy id',
              ),
              h(
                'button',
                { type: 'button', className: 'bv-action', onClick: () => insertId(issue.id) },
                'Insert into composer',
              ),
            ),
          ),
          issue.description
            ? h(Markdown, { text: issue.description, ctx: mdCtx })
            : h('div', { className: 'bv-empty' }, 'No description.'),
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
                          ? 'Collapse'
                          : `Show all ${comments.length}`,
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
          'Retry',
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles (theme tokens only)
     * ------------------------------------------------------------------ */

    const CSS = `
.bv-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;background:transparent}
.bv-listview,.bv-detailview{display:flex;flex-direction:column;min-height:0;height:100%}
.bv-toolbar{display:flex;gap:6px;align-items:center;padding:8px 10px 4px}
.bv-search{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px}
.bv-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.bv-iconbtn{height:26px;min-width:26px;padding:0 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1}
.bv-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.bv-iconbtn-active{border-color:var(--dsw-alias-brand-primary)}
.bv-chips{display:flex;flex-wrap:wrap;gap:4px;padding:2px 10px 6px}
.bv-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.bv-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))}
.bv-chip-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.bv-chip-count{opacity:.6;font-variant-numeric:tabular-nums}
.bv-subbar{display:flex;align-items:center;gap:8px;padding:0 10px 6px}
.bv-sort{height:24px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:11px;padding:0 4px}
.bv-subtle{color:var(--dsw-alias-label-secondary);font-size:11px}
.bv-mono{font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)}
.bv-list{flex:1;min-height:0;overflow:auto;padding:0 6px 12px}
.bv-row{padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.bv-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.bv-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.bv-row-top{display:flex;align-items:baseline;gap:6px}
.bv-row-title{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bv-row-meta{display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap}
.bv-row-id{font-size:11px;color:var(--dsw-alias-label-secondary)}
.bv-ready{font-size:10px;letter-spacing:.03em;color:var(--dsw-alias-state-success-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);border-radius:4px;padding:0 4px;line-height:15px}
.bv-waiting{font-size:10px;color:var(--dsw-alias-state-warn-primary);opacity:.9}
.bv-row-labels{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
.bv-right{margin-left:auto}
.bv-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;margin-top:4px}
.bv-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bv-label{font-size:10.5px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.bv-more{margin:8px auto;display:block;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11.5px}
.bv-empty{padding:24px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.bv-error{color:var(--dsw-alias-state-error-primary)}
.bv-detailbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;background:var(--dsw-alias-bg-base);z-index:2}
.bv-detailid{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.bv-spacer{flex:1}
.bv-issue{flex:1;min-height:0;overflow:auto;padding:10px 12px 24px}
.bv-issue-head{padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:10px}
.bv-issue-title{margin:0 0 6px;font-size:15px;line-height:1.4;font-weight:600}
.bv-issue-badges{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
.bv-issue-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-alias-label-secondary);font-size:11px}
.bv-issue-actions{display:flex;gap:6px;margin-top:8px}
.bv-action{height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer}
.bv-action:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bv-md{overflow-wrap:anywhere}
.bv-md>*:first-child{margin-top:0}
.bv-p{margin:0 0 9px}
.bv-h{margin:16px 0 7px;line-height:1.35;font-weight:600}
.bv-h1{font-size:15px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.bv-h2{font-size:14px}
.bv-h3{font-size:13px}
.bv-h4,.bv-h5,.bv-h6{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.bv-mlist{margin:0 0 9px;padding-left:18px}
.bv-mlist-nested{margin:3px 0 0;padding-left:16px}
.bv-mli{margin:2px 0}
.bv-mli-task{list-style:none;margin-left:-16px;display:flex;gap:6px;align-items:flex-start}
.bv-check{margin-top:4px;flex:none}
.bv-code{font-family:var(--dsw-font-mono, ui-monospace, Menlo, monospace);font-size:11.5px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.bv-code-link{cursor:pointer;color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent)}
.bv-code-link:hover{text-decoration:underline}
.bv-pre{position:relative;margin:0 0 10px;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow:auto;font-size:11.5px;line-height:1.5}
.bv-pre code{font-family:var(--dsw-font-mono, ui-monospace, Menlo, monospace);white-space:pre}
.bv-lang{position:absolute;top:5px;right:8px;font-size:9.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.7;text-transform:uppercase}
.bv-hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0}
.bv-quote{margin:0 0 10px;padding:2px 0 2px 10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.bv-tablewrap{overflow:auto;margin:0 0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.bv-table{border-collapse:collapse;width:100%;font-size:11.5px}
.bv-table th,.bv-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top}
.bv-table th{background:var(--dsw-alias-bg-layer-1);font-weight:600;white-space:nowrap}
.bv-table tr:last-child td{border-bottom:none}
.bv-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.bv-link:hover{text-decoration:underline}
.bv-filelink{display:inline;padding:0 3px;margin:0 1px;border-radius:4px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono, ui-monospace, Menlo, monospace);font-size:11.5px;cursor:pointer}
.bv-filelink:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bv-fileline{opacity:.6}
.bv-issuelink{padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-family:var(--dsw-font-mono, ui-monospace, Menlo, monospace);font-size:11px;cursor:pointer}
.bv-issuelink:hover{border-color:var(--dsw-alias-brand-primary)}
.bv-section{margin-top:16px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.bv-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.bv-section-head .bv-section-title{margin:0}
.bv-linkbtn{border:none;background:transparent;padding:0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;cursor:pointer}
.bv-linkbtn:hover{text-decoration:underline}
.bv-comments-hidden{text-align:center;padding:2px 0 4px}
.bv-section-title{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);font-weight:600}
.bv-relations{display:flex;flex-direction:column;gap:3px}
.bv-relation{display:flex;align-items:center;gap:7px;width:100%;padding:4px 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default}
.bv-relation-link{cursor:pointer}
.bv-relation-link:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.bv-relation-id{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.bv-relation-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.bv-comments{display:flex;flex-direction:column;gap:8px}
.bv-comment{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}
.bv-comment-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
.bv-comment-author{font-size:11.5px;font-weight:600}
.bv-failure{margin:16px 12px;padding:12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1)}
.bv-failure-title{font-weight:600;margin-bottom:4px}
.bv-failure-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:6px}
.bv-failure-cwd{font-size:10.5px;margin-bottom:6px;word-break:break-all}
.bv-failure-detail{margin:0 0 8px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;white-space:pre-wrap;max-height:220px;overflow:auto}
.bv-toast{position:sticky;bottom:8px;margin:8px auto 0;width:max-content;padding:5px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);font-size:11.5px;box-shadow:0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)}
`

    function StyleSheet() {
      return h('style', { 'data-dsh-plugin-css': 'dsh-beads-viewer' }, CSS)
    }

    /* ------------------------------------------------------------------ *
     * Guide glyph
     * ------------------------------------------------------------------ */

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

    const ZH = {
      tab: 'Beads',
      guideDesc: '浏览本项目的 Beads 议题：筛选、阅读 Markdown、点开文件、复制或插入 issue id',
    }
    const EN = {
      tab: 'Beads',
      guideDesc: 'Browse this project’s Beads issues — filter, read the rendered Markdown, open referenced files, copy or insert ids',
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
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'beads-viewer: dictionaries')
        translate = locale.bind(NS)
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
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, BeadsPanel),
            ),
          'beads-viewer: panel body',
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
      },
    }
  },
})
