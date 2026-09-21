/**
 * Regression tests for the five TODO items:
 *   1. IDE content insertion formatting (pure helpers).
 *   2. askuserquestion replay after the webview is recreated (overlay store).
 *   3. Cross-workspace session isolation (api-session/added cwd guard).
 *   4. Sessions move to the top after the user sends a message.
 *   5. A background-running session resumes its turn timer on re-entry.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the two retired frame
 * families (`mux` / `host`) are gone. Session-list state now arrives on the
 * `remote` channel (`api-session/added|activity|status|removed`), answerable
 * requests arrive pre-shaped as `PendingOverlayReplay` values keyed by
 * `eventId`, and history is no longer a unary `loadHistory`: the
 * `session/follow` opening snapshot rebuilds the transcript, so the timer tests
 * feed `applySessionFrame` a snapshot instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionId } from '../src/extension/protocol/brand'
import type { AskUserQuestionItem } from '../src/extension/protocol/events'
import type { SessionFollowFrame } from '../src/extension/protocol/follow'
import type { SessionEvent } from '../src/extension/protocol/session'
import type { HistoryEntry } from '../src/extension/protocol/sessions'
import type { SessionMeta } from '../src/webview/types'
import { formatIdeInsert, languageFromPath } from '../src/webview/ide-insert'

;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true

const a = 'sess-a' as SessionId
const b = 'sess-b' as SessionId
const c = 'sess-c' as SessionId
const MOCK_CWD = '/mock/workspace'

function meta(sessionId: SessionId, updatedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { sessionId, title: null, updatedAt, running: false, blank: false, ...extra }
}

/**
 * One `session/follow` opening snapshot wrapping the given journal events.
 * Every stream generation starts with one of these, and its records ARE the
 * whole window, so consumers replace their state instead of merging.
 */
function followSnapshot(sessionId: SessionId, events: SessionEvent[]): SessionFollowFrame {
  const last = events[events.length - 1]
  return {
    type: 'snapshot',
    header: { version: 1, id: sessionId, createdAt: events[0]?.time ?? 0, isSeeded: false },
    cursor: last?.seq ?? 0,
    records: events.map((event): HistoryEntry => ({ event })),
    hasMore: false,
  }
}

/**
 * One `api-session/added` broadcast summary. The list row is assembled from
 * these fields, so they must all be present on the wire.
 */
function sessionSummary(
  sessionId: SessionId,
  updatedAt: number,
  extra: { cwd?: string; running?: boolean } = {},
): Record<string, unknown> {
  return { sessionId, updatedAt, running: extra.running ?? false, blank: true, ...extra }
}


// ---------------------------------------------------------------------------
// ① IDE content insertion formatting
// ---------------------------------------------------------------------------

test('formatIdeInsert renders a source header plus a language-tagged fence', () => {
  const block = formatIdeInsert('active-file', 'export const x = 1\n', '/work/src/store/sessions.ts')
  assert.match(block, /### 文件：\/work\/src\/store\/sessions\.ts/)
  assert.match(block, /```ts/)
  assert.match(block, /export const x = 1/)
  assert.ok(block.endsWith('```'))
  // The trailing newline of document.getText() is trimmed: no blank line
  // between the content and the closing fence.
  assert.ok(!block.includes('1\n\n```'))
})

test('findIdeBlock strips IDE blocks from the user bubble and yields a hint', async () => {
  const { findIdeBlock } = await import('../src/webview/store/conversation')

  // Selection block (auto-injected): clean text keeps the question only.
  const selection = findIdeBlock('这个函数是做什么的？\n\n### 选中代码（/work/src/auto.ts）\n\n```ts\nfunction f() {}\n```')
  assert.equal(selection.clean, '这个函数是做什么的？')
  assert.deepEqual(selection.hint, { label: '选中代码（/work/src/auto.ts）', path: '/work/src/auto.ts' })

  // Current-file path block (auto-injected without selection).
  const pathOnly = findIdeBlock('这个文件是什么？\n\n### 当前文件：/work/src/context.ts')
  assert.equal(pathOnly.clean, '这个文件是什么？')
  assert.deepEqual(pathOnly.hint, { label: '当前文件：/work/src/context.ts', path: '/work/src/context.ts' })

  // Manual full-file block (insert command / chip).
  const manual = findIdeBlock('看看这个\n\n### 文件：/work/src/big.ts\n\n```ts\ncontent\n```')
  assert.equal(manual.clean, '看看这个')
  assert.equal(manual.hint?.label, '当前文件：/work/src/big.ts')

  // No block: text untouched.
  const plain = findIdeBlock('普通问题')
  assert.equal(plain.clean, '普通问题')
  assert.equal(plain.hint, null)
})

test('formatIdeInsert selection flavor names the source and drops unknown languages', () => {
  const block = formatIdeInsert('selection', 'SELECTED', '/work/README')
  assert.match(block, /### 选中代码（\/work\/README）/)
  assert.match(block, /```\nSELECTED/)
})

test('languageFromPath maps known extensions and ignores unknown ones', () => {
  assert.equal(languageFromPath('/a/b.tsx'), 'tsx')
  assert.equal(languageFromPath('/a/b.JSON'), 'json')
  assert.equal(languageFromPath('/a/b.sh'), 'bash')
  assert.equal(languageFromPath('/a/b'), undefined)
  assert.equal(languageFromPath(undefined), undefined)
  assert.equal(languageFromPath('/a/.hidden'), undefined)
})

// ---------------------------------------------------------------------------
// ③ Cross-workspace isolation + ④ session-to-top (sessions slice)
// ---------------------------------------------------------------------------

test('api-session/added from another workspace is ignored; same-cwd rows enter', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ cwd: MOCK_CWD, sessions: [meta(a, 3)], activeSessionId: null })

  // The broadcast summary carries the row's own cwd; a foreign one is dropped.
  state.applyRemoteEvent('api-session/added', [sessionSummary(b, 4, { cwd: '/other/workspace' })])
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [a])

  state.applyRemoteEvent('api-session/added', [sessionSummary(b, 4, { cwd: MOCK_CWD })])
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [b, a])

  // cwd-less legacy rows still enter (ungrouped sessions stay reachable).
  state.applyRemoteEvent('api-session/added', [sessionSummary(c, 5)])
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [c, b, a])
})

test('a sparse control baseline keeps the titles the init payload installed', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()

  // REGRESSION: the control stream's `projections` map is NOT a complete cut — a
  // cut exists only for sessions whose projection unit is mounted in that host
  // process (measured 10 cuts for 245 sessions on a live host). The baseline
  // handler used to recompute EVERY row from the cut, so a session the cut did not
  // mention lost its title and the whole list rendered as 新会话 right after the
  // init payload had supplied the titles.
  state.initSessions([
    meta(a, 3, { title: '问候与交流' }),
    meta(b, 2, { title: 'Work in /x' }),
    meta(c, 1, { title: 'third' }),
  ], MOCK_CWD)
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.title), ['问候与交流', 'Work in /x', 'third'])

  // The cut mentions ONE session, and only that row is recomputed.
  state.applyControlFrame({
    type: 'baseline',
    value: { queues: {}, jobs: {}, projections: { [b as string]: { asOfSeq: 9, values: { title: 'renamed-b' } } } },
  })
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.title), ['问候与交流', 'renamed-b', 'third'])

  // A PRESENT cut that omits `title` still clears that row: the projection unit
  // is mounted there and reports no title.
  state.applyControlFrame({
    type: 'baseline',
    value: { queues: {}, jobs: {}, projections: { [c as string]: { asOfSeq: 10, values: {} } } },
  })
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.title), ['问候与交流', 'renamed-b', null])
})

test('an empty control baseline does not wipe any title', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  state.initSessions([meta(a, 2, { title: 'kept' }), meta(b, 1, { title: 'also kept' })], MOCK_CWD)

  // A fresh host generation whose registry holds nothing yet: the frame arrives,
  // and every row must survive it.
  state.applyControlFrame({ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } })
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.title), ['kept', 'also kept'])
})

test('initSessions keeps only rows of the canonical workspace cwd', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  const rows = [
    meta(a, 1, { cwd: MOCK_CWD }),
    meta(b, 2, { cwd: '/other/workspace' }),
    meta(c, 3), // legacy cwd-less row stays visible
  ]
  state.initSessions(rows, MOCK_CWD)
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [c, a])
})

test('sending a message moves the session to the top of the list', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ cwd: MOCK_CWD, sessions: [meta(a, 100), meta(b, 50), meta(c, 10)] })

  // The host's `api-session/activity` broadcast carries the authoritative
  // prompt time (it is the later of creation and the latest human prompt).
  state.applyRemoteEvent('api-session/activity', [b, 200])
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [b, a, c])
  assert.equal(useAppStore.getState().sessions[0]?.updatedAt, 200)

  // touchSession with a newer time moves the row; an older time is a no-op.
  state.touchSession(c, 500)
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [c, b, a])
  state.touchSession(a, 1)
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [c, b, a])
  // Unknown sessions (foreign workspace frames) never touch the list.
  state.touchSession('sess-foreign' as SessionId, 999)
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [c, b, a])
})

// ---------------------------------------------------------------------------
// ② askuserquestion replay / per-session overlay tracking
// ---------------------------------------------------------------------------

const QUESTION: AskUserQuestionItem = { id: 'q-1', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }

test('question frames for a background session are recorded and surface on select', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const { waitingSessionId } = await import('../src/webview/store/overlay')
  const state = useAppStore.getState()
  useAppStore.setState({ cwd: MOCK_CWD, activeSessionId: a, overlayBySession: {}, pendingApproval: null, pendingQuestion: null, planReview: null })

  // A request for ANOTHER session is recorded but raises no panel for the
  // active session; the per-session record drives the amber waiting dot.
  state.applyPendingOverlay({ kind: 'question', eventId: 'ev-q-1', agentId: b, questions: [QUESTION] })
  const store = useAppStore.getState()
  assert.equal(store.pendingQuestion, null)
  assert.equal(store.overlayBySession[b]?.question?.questions[0]?.id, 'q-1')
  assert.equal(waitingSessionId(store.overlayBySession), b)

  // Selecting the waiting session derives the takeover panel.
  useAppStore.setState({ sessions: [meta(a, 1), meta(b, 2)], activeSessionId: b })
  state.refreshActiveOverlay()
  const derived = useAppStore.getState()
  assert.equal(derived.pendingQuestion?.sessionId, b)
  assert.equal(derived.pendingQuestion?.questions[0]?.id, 'q-1')

  // The host retracting the request (by eventId) clears the record and panel.
  state.clearPendingOverlay('ev-q-1')
  const cleared = useAppStore.getState()
  assert.equal(cleared.pendingQuestion, null)
  assert.equal(cleared.overlayBySession[b], undefined)
})

test('approval frames record, derive and clear per session', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ cwd: MOCK_CWD, activeSessionId: a, overlayBySession: {}, pendingApproval: null, pendingQuestion: null, planReview: null })

  state.applyPendingOverlay({ kind: 'approval', eventId: 'ap-1', agentId: a, toolName: 'bash', reason: 'run build' })
  assert.equal(useAppStore.getState().pendingApproval?.eventId, 'ap-1')
  // A retraction for a different eventId must not clear this one.
  state.clearPendingOverlay('ap-other')
  assert.equal(useAppStore.getState().pendingApproval?.eventId, 'ap-1')
  state.clearPendingOverlay('ap-1')
  assert.equal(useAppStore.getState().pendingApproval, null)
  assert.equal(useAppStore.getState().overlayBySession[a], undefined)
})

test('applyOverlays reinstalls replayed frames from the init payload', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ cwd: MOCK_CWD, activeSessionId: a, overlayBySession: {}, pendingApproval: null, pendingQuestion: null, planReview: null })

  // What the extension host replays after the webview was recreated hidden:
  // pre-shaped overlays keyed by eventId, not raw mux frames.
  state.applyOverlays([
    { kind: 'approval', eventId: 'ap-9', agentId: b, toolName: 'bash' },
    { kind: 'question', eventId: 'ev-q-9', agentId: a, questions: [QUESTION] },
  ])
  const store = useAppStore.getState()
  // The active session's panel is derived immediately.
  assert.equal(store.pendingQuestion?.sessionId, a)
  assert.equal(store.overlayBySession[b]?.approval?.eventId, 'ap-9')
  // The waiting dot points at the replayed question first (find order).
  const { waitingSessionId } = await import('../src/webview/store/overlay')
  assert.equal(waitingSessionId(store.overlayBySession), b)

  // clearOverlay drops the derived panel but keeps the per-session map
  // (session switch must not lose another session's pending overlay).
  state.clearOverlay()
  const afterClear = useAppStore.getState()
  assert.equal(afterClear.pendingQuestion, null)
  assert.equal(afterClear.overlayBySession[b]?.approval?.eventId, 'ap-9')
})

// ---------------------------------------------------------------------------
// ⑥ deleteSession failure path (TODO 10: the row must stay on rpc failure)
// ---------------------------------------------------------------------------

test('deleteSession rethrows with the reason and keeps the list on rpc failure', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const { mockRpcFailures } = await import('../src/webview/mock/bridge')
  const state = useAppStore.getState()
  useAppStore.setState({ sessions: [meta(a, 2), meta(b, 1)], activeSessionId: b })

  // The mock keys forced failures by the Remote endpoint name (the retired
  // `workspace.archiveSession` dotted name no longer reaches it).
  mockRpcFailures.add('workspace/archiveSession')
  try {
    await assert.rejects(state.deleteSession(a), /归档会话失败.*forced failure/)
    // The list and the active session stay untouched.
    assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [a, b])
    assert.equal(useAppStore.getState().activeSessionId, b)
  } finally {
    mockRpcFailures.delete('workspace/archiveSession')
  }

  // The happy path still removes the row.
  await state.deleteSession(a)
  assert.deepEqual(useAppStore.getState().sessions.map((s) => s.sessionId), [b])
})

// ---------------------------------------------------------------------------
// ⑤ Running-turn timer resume
// ---------------------------------------------------------------------------

test('entering a background-running session resumes the turn timer from the snapshot', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const running = 'sess-running' as SessionId
  const startedAt = Date.now() - 120_000
  useAppStore.setState({
    cwd: MOCK_CWD,
    sessions: [meta(running, Date.now(), { running: true }), meta(a, 1)],
    activeSessionId: running,
    turnStatus: 'idle',
    turnStartedAt: null,
  })
  // Selecting the session re-subscribes `session/follow`; the generation's
  // opening snapshot carries the still-open turn's turn/start, which resumes
  // the running state and the clock instead of resetting to idle.
  useAppStore.getState().applySessionFrame(
    followSnapshot(running, [{ type: 'turn/start', seq: 1, time: startedAt, data: { turn: 7 } }]),
  )
  const store = useAppStore.getState()
  assert.equal(store.turnStatus, 'running')
  assert.equal(store.turnStartedAt, startedAt)
})

test('a completed-turn session stays idle after its snapshot', async () => {
  const { useAppStore } = await import('../src/webview/store')
  const done = 'sess-done' as SessionId
  const startedAt = Date.now() - 60_000
  useAppStore.setState({
    cwd: MOCK_CWD,
    sessions: [meta(done, Date.now())],
    activeSessionId: done,
    turnStatus: 'idle',
    turnStartedAt: null,
  })
  useAppStore.getState().applySessionFrame(
    followSnapshot(done, [
      { type: 'turn/start', seq: 1, time: startedAt, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: startedAt + 5000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  )
  const store = useAppStore.getState()
  assert.equal(store.turnStatus, 'idle')
  assert.equal(store.turnStartedAt, null)
  assert.equal(store.lastTurnMs, 5000)
})
