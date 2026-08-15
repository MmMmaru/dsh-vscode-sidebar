/**
 * ToolCallRow (W3): every tool call renders collapsed as a single line —
 * status icon + tool name + summary (pending shows a spinner, error shows a
 * red dot plus the failure's first line). Clicking the row expands the
 * ToolCard whose kind follows the call's render intent (ToolCard.tsx).
 *
 * Summary derivation order (dsh ToolRow semantics, simplified):
 *   error  -> first line of the failure
 *   views  -> the active view's title (terminal command, diff header, ...)
 *   none   -> salient field of the arguments JSON (command/path/pattern/...)
 */

import { useState, type JSX } from 'react'
import type { ToolCallNode } from '../../types'
import { activeView, ToolCard } from './ToolCard'

/** Icon per card kind / tool-name heuristic. */
function toolIcon(node: ToolCallNode): string {
  const view = activeView(node)
  const kind = view?.card ?? guessKind(node.name)
  switch (kind) {
    case 'terminal':
      return '❯'
    case 'read':
      return '📄'
    case 'diff':
      return '✏️'
    case 'search':
      return '🔍'
    case 'web':
      return '🌐'
    default:
      return '🔧'
  }
}

/** Card kind guess from the bare tool name when no view was declared. */
function guessKind(name: string): string {
  const n = name.toLowerCase()
  if (/bash|shell|terminal|exec/.test(n)) return 'terminal'
  if (/read/.test(n)) return 'read'
  if (/edit|write|patch/.test(n)) return 'diff'
  if (/grep|glob|search/.test(n)) return 'search'
  if (/web|fetch/.test(n)) return 'web'
  return 'generic'
}

/** First non-empty line of a text (error summaries). */
function firstLine(text: string | undefined): string | null {
  if (text === undefined) return null
  const line = text.split('\n').find((l) => l.trim() !== '')
  return line ?? null
}

/** Salient summary derived from the raw arguments JSON of a view-less call. */
function argsSummary(node: ToolCallNode): string {
  try {
    const args = JSON.parse(node.arguments) as Record<string, unknown>
    // bash -> command; read/edit/write -> path; grep/glob -> pattern.
    for (const key of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
      const value = args[key]
      if (typeof value === 'string' && value !== '') return value
    }
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // Unparseable arguments: fall through to the bare status label.
  }
  return node.status === 'pending' ? '调用中…' : ''
}

/** Collapsed-row summary for one tool call. */
export function toolSummary(node: ToolCallNode): string {
  if (node.status === 'error') {
    return firstLine(node.resultText) ?? node.error?.name ?? '调用失败'
  }
  const view = activeView(node)
  if (view !== null && 'title' in view && typeof view.title === 'string' && view.title !== '') {
    return view.title
  }
  if (view !== null && view.card === 'search') {
    return `共 ${view.total} 条结果`
  }
  if (view !== null && view.card === 'read') {
    return view.path
  }
  if (view !== null && view.card === 'web') {
    return view.kind === 'fetch' ? view.url : `${view.sources.length} 个来源`
  }
  return argsSummary(node)
}

export function ToolCallRow(props: { node: ToolCallNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { node } = props
  return (
    <div className={`tool-row tool-row-${node.status}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-row-icon" aria-hidden>
          {node.status === 'pending' ? (
            <span className="tool-spinner" />
          ) : node.status === 'error' ? (
            <span className="tool-dot-error" />
          ) : (
            toolIcon(node)
          )}
        </span>
        <span className="tool-row-name">{node.name}</span>
        <span className="tool-row-dot">·</span>
        <span className={`tool-row-summary${node.status === 'error' ? ' tool-row-summary-error' : ''}`}>
          {toolSummary(node)}
        </span>
        <span className={`tool-row-chevron${open ? ' tool-row-chevron-open' : ''}`}>›</span>
      </button>
      {open && (
        <div className="tool-row-body">
          <ToolCard node={node} />
        </div>
      )}
    </div>
  )
}
