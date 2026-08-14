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
          <div className="empty-hero">{initialized ? '选择或新建一个会话' : '加载中…'}</div>
        </section>
      ) : (
        <ConversationView key={activeSessionId} sessionId={activeSessionId} />
      )}
      <ComposerCard />
      {settingsOpen && <SettingsPanel onClose={closeSettings} />}
    </main>
  )
}
