/**
 * OverlayRetention tests (fix ②): the extension-side replay buffer that keeps
 * answerable frames across webview dispose/re-resolve, so a question that
 * arrived while the sidebar was hidden re-appears on the next init.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalRequestId, SessionId } from '../src/extension/protocol/brand'
import { OverlayRetention } from '../src/extension/overlay-retention'

const a = 'sess-a' as SessionId
const b = 'sess-b' as SessionId

test('retains requested frames and replays them with the full frame', () => {
  const retention = new OverlayRetention()
  retention.record({ type: 'approval/requested', sessionId: a, approvalId: 'ap-1' as ApprovalRequestId, toolName: 'bash', reason: 'run' })
  retention.record({ type: 'question/requested', sessionId: b, questions: [{ id: 'q1', question: '继续？' }] })

  const replays = retention.replay()
  assert.equal(replays.length, 2)
  const approval = replays.find((r) => r.kind === 'approval')
  const question = replays.find((r) => r.kind === 'question')
  assert.equal(approval?.frame.sessionId, a)
  assert.equal(approval?.frame.approvalId, 'ap-1')
  assert.equal(approval?.frame.reason, 'run')
  assert.equal(question?.frame.sessionId, b)
  assert.equal(question?.frame.questions[0]?.id, 'q1')
  assert.equal(retention.hasPending(), true)
})

test('resolved frames clear their slot; unrelated resolutions are ignored', () => {
  const retention = new OverlayRetention()
  retention.record({ type: 'approval/requested', sessionId: a, approvalId: 'ap-1' as ApprovalRequestId, toolName: 'bash' })
  // A resolution for a different approval id must not clear the pending one.
  retention.record({ type: 'approval/resolved', sessionId: a, approvalId: 'ap-other' as ApprovalRequestId, outcome: 'rejected' })
  assert.equal(retention.replay().length, 1)
  retention.record({ type: 'approval/resolved', sessionId: a, approvalId: 'ap-1' as ApprovalRequestId, outcome: 'allowed-once' })
  assert.equal(retention.replay().length, 0)
  assert.equal(retention.hasPending(), false)
})

test('approval and question slots of one session are independent', () => {
  const retention = new OverlayRetention()
  retention.record({ type: 'approval/requested', sessionId: a, approvalId: 'ap-1' as ApprovalRequestId, toolName: 'bash' })
  retention.record({ type: 'question/requested', sessionId: a, questions: [{ id: 'q1', question: 'x' }] })
  retention.record({ type: 'approval/resolved', sessionId: a, approvalId: 'ap-1' as ApprovalRequestId, outcome: 'allowed-once' })
  const replays = retention.replay()
  assert.equal(replays.length, 1)
  assert.equal(replays[0]?.kind, 'question')
  retention.record({ type: 'question/resolved', sessionId: a, questionRpcId: 'rpc-1' as never, outcome: 'answered' })
  assert.equal(retention.replay().length, 0)
})
