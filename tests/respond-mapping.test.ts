/**
 * Unit tests for the bridge `respond` correlation mapping (W5): the webview
 * answers answerable frames by approvalId/sessionId (frame rpcIds never reach
 * it), and DshClient recovers the rpcId from its pending tables before
 * POSTing /api/respond. All traffic hits the in-process fake host.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalRequestId, SessionId } from '../src/extension/protocol/brand'
import { DshClient } from '../src/extension/dsh-client'
import { startFakeHost, type FakeHost } from './fake-host'

/** Connect a client to the fake host and always dispose it afterwards. */
async function withClient(fake: FakeHost, run: (client: DshClient) => Promise<void>): Promise<void> {
  const client = new DshClient()
  await client.connect({ port: fake.port, spawnedByUs: false })
  try {
    await run(client)
  } finally {
    await client.dispose()
  }
}

/** Push one mux frame and wait for the client to process it. */
async function pushMux(fake: FakeHost, rpcId: string, payload: unknown): Promise<void> {
  fake.pushFrame('/api/events.mux', { rpcId, payload })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('resolveApprovalByApprovalId recovers the frame rpcId and answers', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      await pushMux(fake, 'approval-rpc-a', {
        type: 'approval/requested', sessionId: 's-1', approvalId: 'a-1', toolName: 'bash',
      })
      await client.resolveApprovalByApprovalId('a-1' as ApprovalRequestId, 'allow-once')
      assert.equal(fake.responds.length, 1)
      assert.deepEqual(fake.responds[0], {
        rpcId: 'approval-rpc-a',
        result: { ok: true, value: { sessionId: 's-1', approvalId: 'a-1', outcome: 'allowed-once' } },
      })
    })
  } finally {
    await fake.close()
  }
})

test('resolveApprovalByApprovalId rejects for an unknown approvalId', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      await assert.rejects(
        client.resolveApprovalByApprovalId('nope' as ApprovalRequestId, 'refuse'),
        /unknown or already-resolved approval/,
      )
      assert.equal(fake.responds.length, 0)
    })
  } finally {
    await fake.close()
  }
})

test('approval/resolved clears the pending entry so a later answer rejects', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      await pushMux(fake, 'approval-rpc-b', {
        type: 'approval/requested', sessionId: 's-1', approvalId: 'a-2', toolName: 'bash',
      })
      await pushMux(fake, 'approval-resolved-b', {
        type: 'approval/resolved', sessionId: 's-1', approvalId: 'a-2', outcome: 'cancelled',
      })
      await assert.rejects(
        client.resolveApprovalByApprovalId('a-2' as ApprovalRequestId, 'refuse'),
        /unknown or already-resolved approval/,
      )
    })
  } finally {
    await fake.close()
  }
})

test('answerQuestionBySessionId recovers the frame rpcId and answers the batch', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      await pushMux(fake, 'question-rpc-a', {
        type: 'question/requested',
        sessionId: 's-9',
        questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      })
      await client.answerQuestionBySessionId('s-9' as SessionId, [{ id: 'q1', selected: ['B'], custom: 'note' }])
      assert.equal(fake.responds.length, 1)
      assert.deepEqual(fake.responds[0], {
        rpcId: 'question-rpc-a',
        result: { ok: true, value: { sessionId: 's-9', answer: { answers: [{ id: 'q1', selected: ['B'], custom: 'note' }] } } },
      })
    })
  } finally {
    await fake.close()
  }
})

test('question/resolved clears the pending entry by questionRpcId', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      await pushMux(fake, 'question-rpc-b', {
        type: 'question/requested',
        sessionId: 's-9',
        questions: [{ id: 'q1', question: 'pick one' }],
      })
      await pushMux(fake, 'question-resolved-b', {
        type: 'question/resolved', sessionId: 's-9', questionRpcId: 'question-rpc-b', outcome: 'answered',
      })
      await assert.rejects(
        client.answerQuestionBySessionId('s-9' as SessionId, [{ id: 'q1', selected: [] }]),
        /unknown or already-resolved question/,
      )
      assert.equal(fake.responds.length, 0)
    })
  } finally {
    await fake.close()
  }
})
