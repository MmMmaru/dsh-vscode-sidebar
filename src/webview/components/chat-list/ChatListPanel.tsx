/**
 * ChatListPanel placeholder (owned by W2). Contract: no props — the panel
 * reads the sessions slice directly (ARCHITECTURE.md section 5.3). This
 * placeholder renders the region with a clickable session list so the
 * store/api/component wiring is exercisable before W2 lands.
 */

import type { JSX } from 'react'
import { useAppStore } from '../../store'

export function ChatListPanel(): JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const selectSession = useAppStore((s) => s.selectSession)
  const newChat = useAppStore((s) => s.newChat)

  return (
    <section className="region region-chat-list" data-region="ChatListPanel">
      <header className="region-header">
        <span>Chats ({sessions.length})</span>
        <button type="button" onClick={() => void newChat()}>+ New</button>
      </header>
      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              type="button"
              className={`session-row${s.sessionId === activeSessionId ? ' session-row-active' : ''}`}
              onClick={() => void selectSession(s.sessionId)}
            >
              <span className={`status-dot${s.running ? ' status-dot-running' : ''}`} />
              {s.title ?? '(untitled)'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
