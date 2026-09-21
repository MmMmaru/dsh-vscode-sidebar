/**
 * StatusIndicator unit tests (chat-list session status) + the unread-dot
 * regression:
 *   - four states render waiting (amber pulse) / running (spinner) /
 *     unread (green dot) / idle (nothing);
 *   - the store still marks a session unread when it finishes while you are
 *     elsewhere, and clears the flag on select (behavior contract);
 *   - base.css must bundle BEFORE the component stylesheets. Root cause of
 *     "unread dot never shows": main.tsx imported base.css after App, so
 *     base.css landed last in media/style.css and its grey .status-dot
 *     background silently overrode the equal-specificity color modifiers
 *     (.status-dot-unread / .status-dot-waiting in chat-list.css).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MessageId, SessionId } from '../src/extension/protocol/brand'
import type { SessionMeta } from '../src/webview/types'

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true

const a = 'si-a' as SessionId
const b = 'si-b' as SessionId

function meta(sessionId: SessionId, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { sessionId, title: null, updatedAt: 1, running: false, blank: false, ...extra }
}

/** Read one session row out of a store snapshot. */
function rowIn(sessions: readonly SessionMeta[], sessionId: SessionId): SessionMeta | undefined {
  return sessions.find((entry) => entry.sessionId === sessionId)
}

/** Render the indicator to static HTML (dynamic import: see the flag note above). */
async function renderIndicator(session: SessionMeta, waitingSessionId: SessionId | null): Promise<string> {
  const { createElement } = await import('react')
  const { StatusIndicator } = await import('../src/webview/components/chat-list/ChatListPanel')
  return renderToStaticMarkup(createElement(StatusIndicator, { session, waitingSessionId }))
}

// ---------------------------------------------------------------------------
// Four states
// ---------------------------------------------------------------------------

test('waiting session renders the amber pulsing dot', async () => {
  const html = await renderIndicator(meta(a), a)
  assert.match(html, /class="status-dot status-dot-waiting"/)
})

test('waiting wins over running and unread', async () => {
  const html = await renderIndicator(meta(a, { running: true, unread: true }), a)
  assert.match(html, /status-dot-waiting/)
})

test('running session renders the spinning ring', async () => {
  const html = await renderIndicator(meta(a, { running: true }), null)
  assert.match(html, /class="status-spin"/)
})

test('unread session renders the green done dot', async () => {
  const html = await renderIndicator(meta(a, { unread: true }), null)
  assert.match(html, /class="status-dot status-dot-done"/)
})

test('idle session renders nothing', async () => {
  const html = await renderIndicator(meta(a), b)
  assert.equal(html, '')
})

// ---------------------------------------------------------------------------
// Store behavior contract: turn/end marks unread, select clears it
// ---------------------------------------------------------------------------

test('a session that finishes while unselected turns unread; selecting it clears the flag', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ sessions: [meta(a), meta(b, { running: true })], activeSessionId: null })

  // Two seconds after the run started, nothing is unread yet: `b` is still busy.
  state.applyRemoteEvent('api-session/status', [b, true])
  assert.equal(rowIn(useAppStore.getState().sessions, b)?.unread, undefined)
  assert.equal(rowIn(useAppStore.getState().sessions, b)?.running, true)

  // The run finishes while the user is looking elsewhere. The unread dot is the
  // only signal, so it must appear on the transition and on no other session.
  state.applyRemoteEvent('api-session/status', [b, false])
  assert.equal(rowIn(useAppStore.getState().sessions, b)?.unread, true)
  assert.equal(rowIn(useAppStore.getState().sessions, b)?.running, false)
  assert.equal(rowIn(useAppStore.getState().sessions, a)?.unread, undefined)

  // A repeat idle frame is not a transition and must not re-flag anything.
  useAppStore.setState({ sessions: useAppStore.getState().sessions.map((row) => ({ ...row, unread: false })) })
  state.applyRemoteEvent('api-session/status', [b, false])
  assert.equal(rowIn(useAppStore.getState().sessions, b)?.unread, false)

  // Selecting the session clears the flag as well as reading it.
  useAppStore.setState({ sessions: useAppStore.getState().sessions.map((row) => ({ ...row, unread: true })) })
  await state.selectSession(b)
  assert.equal(rowIn(useAppStore.getState().sessions, b)?.unread, false)
})

test('api-session/activity carries the ordering key, and a malformed frame is refused', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ sessions: [meta(a, { updatedAt: 1 })], activeSessionId: null })

  // `activity` replaces the old turn/end-driven list touch: its updatedAt IS the
  // list ordering key ("the later of creation and the latest human prompt").
  state.applyRemoteEvent('api-session/activity', [a, 500])
  assert.equal(rowIn(useAppStore.getState().sessions, a)?.updatedAt, 500)

  // A malformed frame warns instead of corrupting state. `updatedAt` is pinned by
  // `noUncheckedIndexedAccess`, so the sink must be primed with a real baseline.
  const before = useAppStore.getState().sessions.length
  state.applyRemoteEvent('api-session/status', [a, 'yes'])
  assert.equal(rowIn(useAppStore.getState().sessions, a)?.running, false)
  assert.equal(useAppStore.getState().sessions.length, before)
  state.applyRemoteEvent('api-session/activity', [a])
  assert.equal(rowIn(useAppStore.getState().sessions, a)?.updatedAt, 500)
})

// ---------------------------------------------------------------------------
// Regression: base.css must precede component stylesheets in the bundle
// ---------------------------------------------------------------------------

test('main.tsx imports base.css before App (equal-specificity modifiers must win)', () => {
  const entry = readFileSync('src/webview/main.tsx', 'utf8')
  const base = entry.indexOf("import './styles/base.css'")
  const app = entry.indexOf("from './App'")
  assert.ok(base !== -1 && app !== -1)
  assert.ok(
    base < app,
    'base.css must import before App, otherwise its .status-dot background overrides the unread/waiting modifiers',
  )
})
