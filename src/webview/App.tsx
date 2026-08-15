/**
 * App shell: three-layer layout (chat list / conversation / composer) plus the
 * settings modal mount point and the host-status banner. Owns bootstrap: the
 * store's initialize() runs once on mount.
 */

import { useEffect, type JSX } from 'react'
import { ChatListPanel } from './components/chat-list/ChatListPanel'
import { ComposerCard } from './components/composer/ComposerCard'
import { ConversationView } from './components/conversation/ConversationView'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { useAppStore } from './store'

export function App(): JSX.Element {
  const initialized = useAppStore((s) => s.initialized)
  const hostStatus = useAppStore((s) => s.hostStatus)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)

  useEffect(() => {
    void useAppStore.getState().initialize()
  }, [])

  return (
    <main className="app-shell">
      {hostStatus !== 'ready' && (
        <div className={`host-banner host-banner-${hostStatus}`}>
          {hostStatus === 'starting' ? '正在连接 dsh host…' : 'dsh host 已断开，等待重连…'}
        </div>
      )}
      <ChatListPanel />
      {activeSessionId === null ? (
        <section className="region region-conversation" data-region="ConversationView">
          <div className="empty-hero">
            <div className="empty-hero-icon">
              <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-3.2 2.4a.5.5 0 0 1-.8-.4z" />
              </svg>
            </div>
            <div>{initialized ? '选择或新建一个会话' : '加载中…'}</div>
          </div>
        </section>
      ) : (
        <ConversationView key={activeSessionId} sessionId={activeSessionId} />
      )}
      <ComposerCard />
      {settingsOpen && <SettingsPanel onClose={closeSettings} />}
    </main>
  )
}
