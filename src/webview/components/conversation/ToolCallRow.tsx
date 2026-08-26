/**
 * ToolCallRow (W3): every tool call renders collapsed as a single line —
 * status icon + variant title + summary — aligned with the dsh web ToolRow:
 *   - the title is the friendly variant name (Bash / Read / Edit / Search /
 *     Web / Check), not the raw wire name; unknown tools keep the generic
 *     "Tool call" title and ride their real name in the summary slot;
 *   - pending keeps the kind icon, and the shared row glare sweep
 *     (conversation.css) carries the in-flight signal; error swaps the icon
 *     for a red dot and shows the failure's first line in the error color;
 *   - a single-file tool's path summary renders as an underlined link that
 *     opens the file in the IDE (stopPropagation keeps both gestures
 *     independent);
 *   - hovering the row swaps the leading icon for a chevron (the expand
 *     affordance); the whole head toggles the ToolCard whose kind follows the
 *     call's render intent (ToolCard.tsx).
 *
 * Summary derivation order (dsh ToolRow semantics, simplified):
 *   error  -> first line of the failure
 *   views  -> the active view's title (terminal command, diff header, ...)
 *   none   -> salient field of the arguments JSON (command/path/pattern/...)
 */

import { useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import { openFileInIde } from '../../bridge'
import { useAppStore } from '../../store'
import type { ToolCallNode } from '../../types'
import { activeView, ToolCard } from './ToolCard'
import {
  IconApi,
  IconBrowse,
  IconChevron,
  IconChecklist,
  IconEdit,
  IconGlobe,
  IconQuestion,
  IconSearch,
  IconSparkle,
} from './icons'

/**
 * Icon per card kind / tool-name heuristic (strictly aligned with dsh
 * VARIANT_ICONS and toolviews):
 *   terminal -> IconApiOutline14
 *   read     -> IconBrowseOutline16
 *   diff     -> IconEditOutline16
 *   search   -> IconSearchOutline16
 *   web      -> web_fetch: IconBrowse, web_search: IconGlobe (dsh WebRow rule)
 *   check    -> IconChecklistOutline14
 *   ask      -> IconQuestionOutline14
 *   generic  -> IconSparkle16 (dsh others row)
 */
function toolIcon(node: ToolCallNode): JSX.Element {
  const view = activeView(node)
  const kind = view?.card ?? guessKind(node.name)
  switch (kind) {
    case 'terminal':
      return <IconApi size={14} />
    case 'read':
      return <IconBrowse size={14} />
    case 'diff':
      return <IconEdit size={14} />
    case 'search':
      return <IconSearch size={14} />
    case 'web': {
      // dsh WebRow: web_fetch reads one URL (browse glyph), web_search queries (globe glyph).
      const isFetch = view?.card === 'web' ? view.kind === 'fetch' : /fetch/.test(node.name.toLowerCase())
      return isFetch ? <IconBrowse size={14} /> : <IconGlobe size={14} />
    }
    case 'check':
      return <IconChecklist size={14} />
    case 'ask':
      return <IconQuestion size={14} />
    default:
      return <IconSparkle size={14} />
  }
}

/** Card kind guess from the bare tool name when no view was declared. */
export function guessKind(name: string): string {
  const n = name.toLowerCase()
  if (/bash|shell|terminal|exec/.test(n)) return 'terminal'
  if (/read/.test(n)) return 'read'
  if (/edit|write|patch/.test(n)) return 'diff'
  if (/grep|glob|search/.test(n)) return 'search'
  if (/web|fetch/.test(n)) return 'web'
  if (/ask.*question|question|^ask_/.test(n)) return 'ask'
  return 'generic'
}

/** Friendly collapsed-row titles per card kind (dsh VARIANT_TITLES / WEB_TITLES / locale). */
const KIND_TITLES: Record<string, string> = {
  terminal: 'Bash',
  read: 'Read',
  diff: 'Edit',
  search: 'Search',
  web: 'Web',
  check: 'Check',
  ask: '提问',
  generic: 'Tool call',
}

/** The active render-intent card kind of a call ('generic' when undeclared). */
function rowKind(node: ToolCallNode): string {
  const view = activeView(node)
  return view?.card ?? guessKind(node.name)
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

/**
 * The workspace path a single-file tool operates on, when one can be derived:
 * the read/diff result views carry it authoritatively; otherwise the args'
 * path fields are probed (write before its view exists). null = no path.
 */
function filePathOf(node: ToolCallNode): string | null {
  const view = activeView(node)
  if (view !== null && view.card === 'read') return view.path
  if (view !== null && view.card === 'diff') return view.diffs[0]?.path ?? null
  try {
    const args = JSON.parse(node.arguments) as Record<string, unknown>
    for (const key of ['path', 'file_path', 'filePath']) {
      const value = args[key]
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // Mid-stream truncation: no path to offer.
  }
  return null
}

/**
 * The open-in-editor target of the collapsed row: offered only when the
 * visible summary IS the derived path (read rows, path-bearing args), so a
 * multi-file diff header or other prose never links to one arbitrary file.
 */
function linkPathOf(node: ToolCallNode): string | null {
  const path = filePathOf(node)
  if (path === null || node.status === 'error') return null
  return toolSummary(node) === path ? path : null
}

/** Collapsed-row summary body for one tool call (before the name prefix). */
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
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const { node } = props
  const kind = rowKind(node)
  const title = KIND_TITLES[kind] ?? 'Tool call'
  const summaryBody = toolSummary(node)
  // Unknown tools keep their wire name visible: dsh's "others" row rides the
  // name in the summary slot (`name · derived summary`).
  const summary = kind === 'generic' && node.name !== '' ? `${node.name} · ${summaryBody}` : summaryBody
  // A failing call's summary IS the failure prose — never a path link.
  const path = linkPathOf(node)

  const toggle = (): void => setOpen((v) => !v)
  // Div-with-role=head instead of <button> so the path link below can be a
  // real button (nested buttons are invalid HTML); Enter/Space replicated.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    toggle()
  }
  const openPath = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    if (path === null) return
    const session = sessions.find((s) => s.sessionId === activeSessionId)
    void openFileInIde({ path, ...(session?.cwd === undefined ? {} : { cwd: session.cwd }) }).catch(() => {
      // An unresolvable path has no row surface to report on; the host
      // receipt is dropped and the collapsed link stays unchanged.
    })
  }
  // Keep Enter/Space on the focused link from reaching the head's keydown,
  // which would preventDefault() it and toggle expand instead (keyboard
  // analogue of the click stopPropagation).
  const linkKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
  }

  return (
    <div className={`tool-row tool-row-${node.status}`}>
      <div
        className={`disclosure-head tool-row-head${open ? ' disclosure-open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span className="row-leading" aria-hidden>
          <span className="row-leading-idle">
            {node.status === 'error' ? <span className="tool-dot-error" /> : toolIcon(node)}
          </span>
          <IconChevron size={14} className="row-leading-chevron" />
        </span>
        <span className="tool-row-name">{title}</span>
        {path !== null ? (
          <button
            type="button"
            className="tool-row-path"
            title={`在编辑器中打开 ${path}`}
            onClick={openPath}
            onKeyDown={linkKeyDown}
          >
            {summary}
          </button>
        ) : (
          <span className={`tool-row-summary${node.status === 'error' ? ' tool-row-summary-error' : ''}`}>
            {summary}
          </span>
        )}
      </div>
      {open && (
        <div className="tool-row-body">
          <ToolCard node={node} />
        </div>
      )}
    </div>
  )
}
