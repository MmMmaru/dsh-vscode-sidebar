/**
 * ChatListPanel (W2): the top region of the sidebar — "Chats" header with
 * history / settings / new-chat icon buttons, the session list (status dot,
 * title, relative time, hover menu: rename / fork / archive), and a
 * "View all (N)" expander that also reveals the search box.
 * Contract: no props — reads the sessions slice (ARCHITECTURE.md section 5.3).
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { SessionId } from '../../../extension/protocol/brand'
import { useAppStore } from '../../store'
import type { SessionMeta } from '../../types'
import './chat-list.css'

/** Compact relative time: 刚刚 / N分钟 / N小时 / Nd. */
function relativeTime(updatedAt: number): string {
  const diff = Date.now() - updatedAt
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  return `${Math.floor(hours / 24)}d`
}

/** Status dot priority: waiting (amber, if this session has the pending overlay) > running (green) > idle. */
function dotClass(session: SessionMeta, waitingSessionId: SessionId | null): string {
  if (waitingSessionId !== null && session.sessionId === waitingSessionId) return 'status-dot status-dot-waiting'
  if (session.running) return 'status-dot status-dot-running'
  return 'status-dot'
}

/** Inline icon set (16px stroke icons, no dependency). */
function Icon(props: { name: 'clock' | 'gear' | 'pencil' | 'dots' | 'search' }): JSX.Element {
  const paths: Record<typeof props.name, JSX.Element> = {
    clock: (
      <>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5V8l2.5 1.5" />
      </>
    ),
    gear: (
      <>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
      </>
    ),
    pencil: (
      <>
        <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z" />
        <path d="M9.5 4l2.5 2.5" />
      </>
    ),
    dots: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />,
    search: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </>
    ),
  }
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      {paths[props.name]}
    </svg>
  )
}

/** One session row with its hover "⋯" menu. */
function SessionRow(props: { session: SessionMeta; waitingSessionId: SessionId | null }): JSX.Element {
  const { session } = props
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const selectSession = useAppStore((s) => s.selectSession)
  const renameSession = useAppStore((s) => s.renameSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const forkSession = useAppStore((s) => s.forkSession)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the hover menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const title = session.title ?? '新会话'
  const active = session.sessionId === activeSessionId

  const submitRename = (): void => {
    const next = draft.trim()
    setRenaming(false)
    if (next !== '' && next !== session.title) void renameSession(session.sessionId, next)
  }

  if (renaming) {
    return (
      <li className="session-row session-row-editing">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        className={`session-row${active ? ' session-row-active' : ''}`}
        onClick={() => void selectSession(session.sessionId)}
        title={title}
      >
        <span className={dotClass(session, props.waitingSessionId)} />
        <span className="session-title">{title}</span>
        {!session.blank && <span className="session-time">{relativeTime(session.updatedAt)}</span>}
        <span
          className="session-menu-trigger"
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
        >
          <Icon name="dots" />
        </span>
      </button>
      {menuOpen && (
        <div className="session-menu" ref={menuRef}>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false)
              setDraft(session.title ?? '')
              setRenaming(true)
            }}
          >
            重命名
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false)
              void forkSession(session.sessionId)
            }}
          >
            分叉新对话
          </button>
          <button
            type="button"
            className="session-menu-danger"
            onClick={() => {
              setMenuOpen(false)
              if (window.confirm(`归档会话「${title}」？`)) void deleteSession(session.sessionId)
            }}
          >
            删除
          </button>
        </div>
      )}
    </li>
  )
}

/** The panel: header buttons + inline recent list + a dropdown full-history layer. */
export function ChatListPanel(): JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const newChat = useAppStore((s) => s.newChat)
  const openSettings = useAppStore((s) => s.openSettings)
  const pendingApproval = useAppStore((s) => s.pendingApproval)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const panelRef = useRef<HTMLElement>(null)

  // The session holding the pending overlay drives the amber "waiting" dot.
  const waitingSessionId = pendingApproval?.sessionId ?? pendingQuestion?.sessionId ?? null

  // 250ms debounce for the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [query])

  // The history dropdown closes on outside pointer-down and on Escape.
  useEffect(() => {
    if (!expanded) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return
      setExpanded(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded])

  const filtered = debounced === ''
    ? sessions
    : sessions.filter((s) => (s.title ?? '').toLowerCase().includes(debounced))
  const visible = filtered.slice(0, 5)

  return (
    <section className="region-chat-list chat-list" data-region="ChatListPanel" ref={panelRef}>
      <div className="chat-list-header">
        <span className="chat-list-title">Chats</span>
        <span className="chat-list-actions">
          <button
            type="button"
            className={`icon-btn${expanded ? ' icon-btn-active' : ''}`}
            title="历史会话"
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name="clock" />
          </button>
          <button type="button" className="icon-btn" title="设置" onClick={openSettings}>
            <Icon name="gear" />
          </button>
          <button type="button" className="icon-btn" title="新建对话" onClick={() => void newChat()}>
            <Icon name="pencil" />
          </button>
        </span>
      </div>
      <ul className="session-list">
        {visible.map((s) => (
          <SessionRow key={s.sessionId} session={s} waitingSessionId={waitingSessionId} />
        ))}
      </ul>
      {filtered.length > 5 && (
        <button type="button" className="chat-list-viewall" onClick={() => setExpanded(true)}>
          View all ({filtered.length})
        </button>
      )}
      {expanded && (
        <div className="chat-list-dropdown">
          <div className="chat-list-search">
            <Icon name="search" />
            <input
              autoFocus
              placeholder="搜索会话…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="session-list chat-list-dropdown-list">
            {filtered.map((s) => (
              <SessionRow key={s.sessionId} session={s} waitingSessionId={waitingSessionId} />
            ))}
            {filtered.length === 0 && <li className="chat-list-empty">无匹配会话</li>}
          </ul>
        </div>
      )}
    </section>
  )
}
