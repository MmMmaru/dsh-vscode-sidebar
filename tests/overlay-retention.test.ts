/**
 * OverlayRetention tests: the extension-side replay buffer that keeps
 * answerable requests across a sidebar webview dispose/re-resolve, so a request
 * that arrived while the sidebar was hidden re-appears in the next init payload.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the buffer is keyed by
 * `eventId` now. An answerable request arrives as a `$events` waterfall frame
 * carrying a unique `eventId` and is retracted by a `cancel` frame naming that
 * same id, so the old per-`sessionId` "requested/resolved" slots no longer
 * exist — one session can hold an approval and a question at once.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionId } from '../src/extension/protocol/brand'
import type { PendingApprovalOverlay, PendingQuestionOverlay } from '../src/shared/bridge'
import { OverlayRetention } from '../src/extension/overlay-retention'

const a = 'sess-a' as SessionId
const b = 'sess-b' as SessionId

/** One approval request exactly as the Bridge records it from the waterfall. */
function approval(
  eventId: string,
  agentId: SessionId = a,
  extra: Partial<PendingApprovalOverlay> = {},
): PendingApprovalOverlay {
  return { kind: 'approval', eventId, agentId, toolName: 'bash', ...extra }
}

/** One ask-user-questions batch exactly as the Bridge records it. */
function question(eventId: string, agentId: SessionId = a): PendingQuestionOverlay {
  return { kind: 'question', eventId, agentId, questions: [{ id: 'q1', question: '继续？' }] }
}

test('a pending request survives the webview being disposed and re-created', () => {
  const retention = new OverlayRetention()
  // Webview 1 receives both requests and is hidden/disposed right after.
  retention.recordPending(approval('ev-1', a, { callId: 'call-1', reason: 'run' }))
  retention.recordPending(question('ev-2', b))

  // Webview 2 is resolved later and builds its init payload from the buffer.
  const replays = retention.replay()
  assert.equal(replays.length, 2)
  const replayedApproval = replays.find(
    (entry): entry is PendingApprovalOverlay => entry.kind === 'approval',
  )
  const replayedQuestion = replays.find(
    (entry): entry is PendingQuestionOverlay => entry.kind === 'question',
  )
  assert.equal(replayedApproval?.eventId, 'ev-1')
  assert.equal(replayedApproval?.agentId, a)
  assert.equal(replayedApproval?.toolName, 'bash')
  assert.equal(replayedApproval?.callId, 'call-1')
  assert.equal(replayedApproval?.reason, 'run')
  assert.equal(replayedQuestion?.eventId, 'ev-2')
  assert.equal(replayedQuestion?.agentId, b)
  assert.equal(replayedQuestion?.questions[0]?.id, 'q1')
  assert.equal(retention.hasPending(), true)

  // A replay is a read, never a drain: a third webview still sees both.
  assert.equal(retention.replay().length, 2)
})

test('recordCleared drops exactly the matching eventId and leaves the rest', () => {
  const retention = new OverlayRetention()
  retention.recordPending(approval('ev-1'))
  retention.recordPending(approval('ev-2', b, { toolName: 'write' }))

  // A retraction this buffer never held must not clear anything.
  retention.recordCleared('ev-other')
  assert.deepEqual(retention.replay().map((entry) => entry.eventId), ['ev-1', 'ev-2'])

  retention.recordCleared('ev-1')
  assert.deepEqual(retention.replay().map((entry) => entry.eventId), ['ev-2'])
  assert.equal(retention.hasPending(), true)

  retention.recordCleared('ev-2')
  assert.deepEqual(retention.replay(), [])
  assert.equal(retention.hasPending(), false)
})

test('an approval and a question can be pending at once without colliding', () => {
  const retention = new OverlayRetention()
  retention.recordPending(approval('ev-1', a))
  retention.recordPending(question('ev-2', a))

  // Answering/retracting the approval leaves the question answerable.
  retention.recordCleared('ev-1')
  const remaining = retention.replay()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.kind, 'question')
  assert.equal(remaining[0]?.eventId, 'ev-2')

  retention.recordCleared('ev-2')
  assert.equal(retention.replay().length, 0)
  assert.equal(retention.hasPending(), false)
})

test('same-kind requests of one session are retained per eventId, not per session', () => {
  const retention = new OverlayRetention()
  retention.recordPending(approval('ev-1', a, { toolName: 'bash' }))
  retention.recordPending(approval('ev-2', a, { toolName: 'write' }))

  assert.deepEqual(retention.replay().map((entry) => entry.eventId), ['ev-1', 'ev-2'])

  retention.recordCleared('ev-1')
  const remaining = retention.replay()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.kind === 'approval' ? remaining[0].toolName : undefined, 'write')
})
