/**
 * ToolCard (W3): the expanded detail card under a ToolCallRow. The card kind
 * follows the host-computed render intent (`ToolCallView`/`ToolResultView`
 * card field, see src/extension/protocol/tool-views.ts): terminal / diff /
 * read / search / web, with a generic IN/OUT text card as the fallback when
 * the call carries no view. All cards are height-capped and scroll internally.
 */

import type { JSX } from 'react'
import type { ContentBlock } from '../../../extension/protocol/llm'
import type {
  FileDiff,
  SearchResultView,
  ToolCallView,
  ToolResultView,
  WebResultView,
} from '../../../extension/protocol/tool-views'
import type { ToolCallNode } from '../../types'

// ---------------------------------------------------------------------------
// Lightweight line diff (LCS-based; no dependencies)
// ---------------------------------------------------------------------------

/** One rendered row of a line-level diff. */
export interface DiffRow {
  type: 'same' | 'add' | 'del'
  text: string
  /** 1-based line number on the respective side. */
  oldNo?: number
  newNo?: number
}

/** DP table size guard: past this, fall back to whole-block del+add. */
const DIFF_CELL_BUDGET = 200_000

/**
 * Diff two texts line by line via the classic LCS dynamic program.
 * `oldText === null` means a brand-new file: every new line is an add.
 */
export function diffLines(oldText: string | null, newText: string): DiffRow[] {
  const newLines = newText.split('\n')
  if (oldText === null) {
    return newLines.map((text, i) => ({ type: 'add', text, newNo: i + 1 }))
  }
  const oldLines = oldText.split('\n')
  const n = oldLines.length
  const m = newLines.length
  if (n * m > DIFF_CELL_BUDGET) {
    return [
      ...oldLines.map((text, i) => ({ type: 'del' as const, text, oldNo: i + 1 })),
      ...newLines.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 })),
    ]
  }
  // lcs[i][j] = LCS length of oldLines[i:] and newLines[j:].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const oldLine = oldLines[i]!
    const newLine = newLines[j]!
    if (oldLine === newLine) {
      rows.push({ type: 'same', text: oldLine, oldNo: i + 1, newNo: j + 1 })
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ type: 'del', text: oldLine, oldNo: i + 1 })
      i += 1
    } else {
      rows.push({ type: 'add', text: newLine, newNo: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: oldLines[i]!, oldNo: i + 1 })
    i += 1
  }
  while (j < m) {
    rows.push({ type: 'add', text: newLines[j]!, newNo: j + 1 })
    j += 1
  }
  return rows
}

// ---------------------------------------------------------------------------
// Per-kind cards
// ---------------------------------------------------------------------------

/** Flatten UI-facing content blocks to plain text (generic card sections). */
function blocksText(blocks: ContentBlock[] | undefined): string | null {
  if (blocks === undefined) return null
  const text = blocks
    .map((b) => (b.type === 'text' || b.type === 'reasoning' ? b.text : ''))
    .filter((t) => t !== '')
    .join('\n')
  return text === '' ? null : text
}

/** One labeled pre section of a generic IN/OUT card. */
function IoSection(props: { label: 'IN' | 'OUT'; text: string; error?: boolean }): JSX.Element {
  return (
    <div className="tool-io-section">
      <span className="tool-io-label">{props.label}</span>
      <pre className="tool-io-text" data-error={props.error === true || undefined}>
        {props.text}
      </pre>
    </div>
  )
}

/** Terminal card: cwd + command header, monospaced capped output, exit status. */
function TerminalCard(props: { node: ToolCallNode; view: Extract<ToolCallView | ToolResultView, { card: 'terminal' }> }): JSX.Element {
  const { view, node } = props
  // The call view carries cwd/description; the result view carries output/exit.
  const callView = node.callView?.card === 'terminal' ? node.callView : undefined
  const title = view.title ?? callView?.title ?? ''
  const description = callView?.description
  const cwd = callView?.cwd
  const output = 'output' in view ? view.output : undefined
  const exitCode = 'exitCode' in view ? view.exitCode : undefined
  const signal = 'signal' in view ? view.signal : undefined
  const body = output ?? (node.status === 'pending' ? null : node.resultText ?? null)
  const failed = exitCode !== undefined && exitCode !== 0
  return (
    <div className="tool-card tool-card-terminal">
      {description !== undefined && <div className="tool-terminal-desc">{description}</div>}
      <div className="tool-terminal-head">
        {cwd !== undefined && <span className="tool-terminal-cwd">{cwd}</span>}
        <span className="tool-terminal-cmd">❯ {title}</span>
      </div>
      {body !== null && <pre className="tool-terminal-out">{body}</pre>}
      {node.status === 'pending' ? (
        <div className="tool-terminal-status">运行中…</div>
      ) : (
        <div className={`tool-terminal-status${failed || signal !== undefined ? ' tool-status-error' : ''}`}>
          {signal !== undefined ? `signal ${signal}` : `exit code ${exitCode ?? 0}`}
        </div>
      )}
    </div>
  )
}

/** Diff card: one line-level diff per file; oldText null renders as new file. */
function DiffCard(props: { view: Extract<ToolCallView | ToolResultView, { card: 'diff' }> }): JSX.Element {
  return (
    <div className="tool-card tool-card-diff">
      {props.view.diffs.map((d: FileDiff) => (
        <div key={d.path} className="tool-diff-file">
          <div className="tool-diff-path">
            {d.path}
            {d.oldText === null && <span className="tool-diff-badge">新文件</span>}
          </div>
          <pre className="tool-diff-body">
            {diffLines(d.oldText, d.newText).map((row, i) => (
              <div key={i} className={`tool-diff-line tool-diff-${row.type}`}>
                <span className="tool-diff-no">{row.oldNo ?? ''}</span>
                <span className="tool-diff-no">{row.newNo ?? ''}</span>
                <span className="tool-diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
                <span className="tool-diff-text">{row.text}</span>
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  )
}

/** Read card: line-numbered window of the read file. */
function ReadCard(props: { view: Extract<ToolResultView, { card: 'read' }> }): JSX.Element {
  const { view } = props
  return (
    <div className="tool-card tool-card-read">
      <div className="tool-read-path">
        {view.path}
        <span className="tool-read-range">{`${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines} 行`}</span>
      </div>
      <pre className="tool-read-body">
        {view.lines.map((line) => (
          <div key={line.number} className="tool-read-line">
            <span className="tool-read-no">{line.number}</span>
            <span className="tool-read-text">{line.text}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

/** Search card: matches grouped by file, or a flat path list (glob). */
function SearchCard(props: { view: SearchResultView }): JSX.Element {
  const { view } = props
  return (
    <div className="tool-card tool-card-search">
      {view.shape === 'matches'
        ? view.files.map((file) => (
            <div key={file.path} className="tool-search-file">
              <div className="tool-search-path">{file.path}</div>
              {file.matches.map((m) => (
                <div key={m.lineNumber} className="tool-search-match">
                  <span className="tool-search-no">{m.lineNumber}</span>
                  <span className="tool-search-line">{m.line}</span>
                </div>
              ))}
            </div>
          ))
        : (
          <ul className="tool-search-paths">
            {view.paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      <div className="tool-search-foot">
        共 {view.total} 条{view.truncated ? '（已截断）' : ''}
      </div>
    </div>
  )
}

/** Web card: search = answer + source list; fetch = URL + status code. */
function WebCard(props: { view: WebResultView }): JSX.Element {
  const { view } = props
  if (view.kind === 'fetch') {
    return (
      <div className="tool-card tool-card-web">
        <div className="tool-web-fetch">
          <a href={view.url} target="_blank" rel="noreferrer">{view.url}</a>
          <span className="tool-web-status">{`HTTP ${view.statusCode}`}</span>
          {view.truncated && <span className="tool-web-status">（内容已截断）</span>}
        </div>
      </div>
    )
  }
  return (
    <div className="tool-card tool-card-web">
      {view.answer !== undefined && <div className="tool-web-answer">{view.answer}</div>}
      <ul className="tool-web-sources">
        {view.sources.map((s) => (
          <li key={s.url} className="tool-web-source">
            <a href={s.url} target="_blank" rel="noreferrer">{s.title ?? s.url}</a>
            {s.snippet !== undefined && <div className="tool-web-snippet">{s.snippet}</div>}
          </li>
        ))}
      </ul>
      {view.truncated && <div className="tool-search-foot">来源列表已截断</div>}
    </div>
  )
}

/** Generic fallback card: IN (raw input / arguments) + OUT (result text). */
function GenericCard(props: { node: ToolCallNode; view: Extract<ToolCallView | ToolResultView, { card: 'generic' }> | null }): JSX.Element {
  const view = props.view
  const raw = view !== null && 'rawInput' in view ? view.rawInput : undefined
  const input =
    raw !== undefined
      ? typeof raw === 'string'
        ? raw
        : JSON.stringify(raw, null, 2)
      : prettyJson(props.node.arguments)
  const content = blocksText(view?.content)
  const output = content ?? props.node.resultText ?? null
  return (
    <div className="tool-card tool-card-generic">
      {input !== '' && <IoSection label="IN" text={input} />}
      {output !== null && (
        <IoSection label="OUT" text={output} error={props.node.status === 'error'} />
      )}
      {input === '' && output === null && <div className="tool-card-empty">（无详情）</div>}
    </div>
  )
}

/** Pretty-print a JSON arguments string; pass through when not parseable. */
function prettyJson(raw: string): string {
  if (raw === '') return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The active render intent of a call: the result view outranks the pending
 * call view once the call has settled; null means no intent was declared.
 */
export function activeView(node: ToolCallNode): ToolCallView | ToolResultView | null {
  if (node.status !== 'pending' && node.resultView !== undefined) return node.resultView
  return node.callView ?? null
}

export function ToolCard(props: { node: ToolCallNode }): JSX.Element {
  const view = activeView(props.node)
  if (view === null) return <GenericCard node={props.node} view={null} />
  switch (view.card) {
    case 'terminal':
      return <TerminalCard node={props.node} view={view} />
    case 'diff':
      return <DiffCard view={view} />
    case 'read':
      return <ReadCard view={view} />
    case 'search':
      return <SearchCard view={view} />
    case 'web':
      return <WebCard view={view} />
    case 'generic':
      return <GenericCard node={props.node} view={view} />
  }
}
