/**
 * StatusIndicator unit tests (chat-list session status) + the unread-dot
 * regression:
 *   - four states render waiting (amber pulse) / running (spinner) /
 *     unread (green dot) / idle (nothing);
 *   - the store still marks a session unread on turn/end and clears it on
 *     select (behavior contract);
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

test('turn/end marks the session unread; selecting it clears the flag', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ sessions: [meta(a), meta(b)], activeSessionId: null })

  state.applyProjectionFrame({
    type: 'session/event',
    sessionId: a,
    event: { type: 'turn/end', seq: 9, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
  })
  assert.equal(useAppStore.getState().sessions.find((s) => s.sessionId === a)?.unread, true)
  assert.equal(useAppStore.getState().sessions.find((s) => s.sessionId === b)?.unread, undefined)

  // A running -> idle host transition marks unread too.
  useAppStore.setState({ sessions: [meta(b, { running: true }), ...useAppStore.getState().sessions.filter((s) => s.sessionId !== b)] })
  state.applyHostFrame({ type: 'host/session-status', sessionId: b, running: false })
  assert.equal(useAppStore.getState().sessions.find((s) => s.sessionId === b)?.unread, true)

  await state.selectSession(a)
  assert.equal(useAppStore.getState().sessions.find((s) => s.sessionId === a)?.unread, false)
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
