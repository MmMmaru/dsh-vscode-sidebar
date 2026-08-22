/**
 * ChatListPanel (W2): the top region of the sidebar — "Chats" header with
 * history / settings / new-chat icon buttons. While no session is active the
 * panel also shows the recent session list (status dot, title, relative time,
 * hover menu: rename / fork / archive) and a "View all (N)" expander; once a
 * session is active, history is only reachable through the clock button's
 * dropdown layer (which also reveals the search box).
 * Contract: no props — reads the sessions slice (ARCHITECTURE.md section 5.3).
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SessionId } from '../../../extension/protocol/brand'
import { useAppStore } from '../../store'
import { waitingSessionId as firstWaitingSessionId } from '../../store/overlay'
import type { SessionMeta } from '../../types'
import { ConfirmModal } from '../common/ConfirmModal'
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

/**
 * Session status indicator (priority: waiting > running > unread > idle):
 *   - waiting (this session holds the pending overlay): amber pulsing dot
 *   - running: spinning ring
 *   - unread (a turn finished while the session was not open): green dot
 *   - idle: renders nothing, so the title naturally aligns left
 */
export function StatusIndicator(props: { session: SessionMeta; waitingSessionId: SessionId | null }): JSX.Element | null {
  const { session, waitingSessionId } = props
  if (waitingSessionId !== null && session.sessionId === waitingSessionId) {
    return <span className="status-dot status-dot-waiting" />
  }
  if (session.running) return <span className="status-spin" />
  if (session.unread === true) return <span className="status-dot status-dot-done" />
  return null
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
    // Classic cog: lucide "settings" outline (24px grid) scaled by 2/3 to the 16px grid.
    gear: (
      <>
        <path d="M8.15 1.33h-.29a1.33 1.33 0 0 0-1.33 1.33v.12a1.33 1.33 0 0 1-.67 1.15l-.29.17a1.33 1.33 0 0 1-1.33 0l-.1-.05a1.33 1.33 0 0 0-1.82.49l-.15.25a1.33 1.33 0 0 0 .49 1.82l.1.07a1.33 1.33 0 0 1 .67 1.15v.34a1.33 1.33 0 0 1-.67 1.16l-.1.06a1.33 1.33 0 0 0-.49 1.82l.15.25a1.33 1.33 0 0 0 1.82.49l.1-.05a1.33 1.33 0 0 1 1.33 0l.29.17a1.33 1.33 0 0 1 .67 1.15V13.33a1.33 1.33 0 0 0 1.33 1.33h.29a1.33 1.33 0 0 0 1.33-1.33v-.12a1.33 1.33 0 0 1 .67-1.15l.29-.17a1.33 1.33 0 0 1 1.33 0l.1.05a1.33 1.33 0 0 0 1.82-.49l.15-.26a1.33 1.33 0 0 0-.49-1.82l-.1-.05a1.33 1.33 0 0 1-.67-1.16v-.33a1.33 1.33 0 0 1 .67-1.16l.1-.06a1.33 1.33 0 0 0 .49-1.82l-.15-.25a1.33 1.33 0 0 0-1.82-.49l-.1.05a1.33 1.33 0 0 1-1.33 0l-.29-.17a1.33 1.33 0 0 1-.67-1.15V2.67a1.33 1.33 0 0 0-1.33-1.33z" />
        <circle cx="8" cy="8" r="2" />
      </>
    ),
    pencil: (
      <>
        <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z" />
        <path d="M9.5 4l2.5 2.5" />
      </>
    ),
    // Filled dots (solid circles read better than hairline stroked dots).
    dots: (
      <>
        <circle cx="3.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
      </>
    ),
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

/** One session row with its hover "⋯" menu. `onSelected` lets a host layer (the history dropdown) close itself on pick. */
function SessionRow(props: { session: SessionMeta; waitingSessionId: SessionId | null; onSelected?: () => void }): JSX.Element {
  const { session } = props
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const selectSession = useAppStore((s) => s.selectSession)
  const renameSession = useAppStore((s) => s.renameSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const forkSession = useAppStore((s) => s.forkSession)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the hover menu on outside click, window scroll, or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: Event): void => {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const title = session.title ?? '新会话'
  const active = session.sessionId === activeSessionId

  const submitRename = (): void => {
    const next = draft.trim()
    setRenaming(false)
    if (next !== '' && next !== session.title) void renameSession(session.sessionId, next)
  }

  // Archive the session through the store; a failed RPC keeps the dialog open
  // and shows the reason (window.confirm/alert are unavailable in a webview).
  const confirmDelete = async (): Promise<void> => {
    setDeleting(true)
    setDeleteFailure(null)
    try {
      await deleteSession(session.sessionId)
      setConfirming(false)
    } catch (error) {
      setDeleteFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
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
        onClick={() => {
          void selectSession(session.sessionId)
          props.onSelected?.()
        }}
        title={title}
      >
        <StatusIndicator session={session} waitingSessionId={props.waitingSessionId} />
        <span className="session-title">{title}</span>
        {!session.blank && <span className="session-time">{relativeTime(session.updatedAt)}</span>}
        <span
          className="session-menu-trigger"
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            if (menuOpen) {
              setMenuOpen(false)
              return
            }
            const rect = e.currentTarget.getBoundingClientRect()
            const spaceBelow = window.innerHeight - rect.bottom
            const top = spaceBelow < 120 && rect.top > 120 ? rect.bottom - 110 : rect.top
            const right = Math.max(8, window.innerWidth - rect.left + 4)
            setMenuPos({ top: Math.max(8, top), right })
            setMenuOpen(true)
          }}
        >
          <Icon name="dots" />
        </span>
      </button>
      {menuOpen && menuPos !== null && (
        <div
          className="session-menu"
          ref={menuRef}
          style={{ position: 'fixed', top: `${menuPos.top}px`, right: `${menuPos.right}px` }}
        >
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
              setDeleteFailure(null)
              setConfirming(true)
            }}
          >
            删除
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmModal
          title="删除会话"
          description={`会话「${title}」将被归档，从列表中移除。此操作不可撤销。`}
          confirmLabel="删除"
          busy={deleting}
          failure={deleteFailure}
          onConfirm={() => void confirmDelete()}
          onCancel={() => { if (!deleting) setConfirming(false) }}
        />
      )}
    </li>
  )
}

/** The panel: header buttons + an inline recent list (start screen only) + a dropdown full-history layer. */
export function ChatListPanel(): JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const newChat = useAppStore((s) => s.newChat)
  const openSettings = useAppStore((s) => s.openSettings)
  const overlayBySession = useAppStore((s) => s.overlayBySession)
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const panelRef = useRef<HTMLElement>(null)

  // The session holding a pending overlay drives the amber "waiting" dot —
  // any session, not just the active one (frames for background sessions are
  // recorded per-session; the takeover panel renders only when selected).
  const waiting = useMemo(() => firstWaitingSessionId(overlayBySession), [overlayBySession])

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

  // Background sessions still executing; drives the history button badge.
  const runningCount = sessions.filter((s) => s.running).length

  return (
    <section className="region-chat-list chat-list" data-region="ChatListPanel" ref={panelRef}>
      <div className="chat-list-header">
        <span className="chat-list-title">Chats</span>
        <span className="chat-list-actions">
          <button
            type="button"
            className={`icon-btn${expanded ? ' icon-btn-active' : ''}`}
            title={runningCount > 0 ? `历史会话（${runningCount} 个运行中）` : '历史会话'}
            onClick={() => setExpanded((v) => !v)}
          >
            {runningCount > 0 ? (
              <span className="chat-list-running-badge">
                <span className="chat-list-running-spinner" aria-hidden />
                <span className="chat-list-running-count">{runningCount}</span>
              </span>
            ) : (
              <Icon name="clock" />
            )}
          </button>
          <button type="button" className="icon-btn" title="设置" onClick={openSettings}>
            <Icon name="gear" />
          </button>
          <button type="button" className="icon-btn" title="新建对话" onClick={() => void newChat()}>
            <Icon name="pencil" />
          </button>
        </span>
      </div>
      {/* The persistent recent list only shows on the start screen; inside a
          session, history is reachable through the clock dropdown below. */}
      {activeSessionId === null && (
        <>
          <ul className="session-list">
            {visible.map((s) => (
              <SessionRow key={s.sessionId} session={s} waitingSessionId={waiting} />
            ))}
          </ul>
          {filtered.length > 5 && (
            <button type="button" className="chat-list-viewall" onClick={() => setExpanded(true)}>
              View all ({filtered.length})
            </button>
          )}
        </>
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
              <SessionRow
                key={s.sessionId}
                session={s}
                waitingSessionId={waiting}
                onSelected={() => setExpanded(false)}
              />
            ))}
            {filtered.length === 0 && <li className="chat-list-empty">无匹配会话</li>}
          </ul>
        </div>
      )}
    </section>
  )
}
