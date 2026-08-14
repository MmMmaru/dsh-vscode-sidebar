/**
 * Unit tests for DshClient: rpc id pairing, business/transport error
 * propagation, WS frame dispatch, approval answering, and reconnect.
 * All traffic hits an in-process fake host (tests/fake-host.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshClient, RpcBusinessError } from '../src/extension/dsh-client'
import type { MuxFrame } from '../src/extension/protocol/events'
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

test('rpc pairs request/response by rpcId and returns the value', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      const value = await client.rpc<{ items: unknown[] }>('session.list', {})
      assert.deepEqual(value, { items: [] })
      assert.equal(fake.calls.length, 1)
      const call = fake.calls[0]
      assert.ok(call)
      assert.equal(call.method, 'session.list')
      assert.equal(typeof call.rpcId, 'string')
      assert.ok(call.rpcId.length > 0)
    })
  } finally {
    await fake.close()
  }
})

test('rpc propagates business errors as RpcBusinessError with the code', async () => {
  const fake = await startFakeHost({ failRpcs: true })
  try {
    await withClient(fake, async (client) => {
      await assert.rejects(
        client.rpc('session.list', {}),
        (error: unknown) => error instanceof RpcBusinessError
          && error.code === 'internal'
          && error.message.includes('fake failure'),
      )
    })
  } finally {
    await fake.close()
  }
})

test('rpc rejects when the host echoes a mismatched rpcId', async () => {
  const fake = await startFakeHost({ corruptRpcId: true })
  try {
    await withClient(fake, async (client) => {
      await assert.rejects(client.rpc('session.list', {}), /rpcId mismatch/)
    })
  } finally {
    await fake.close()
  }
})

test('mux frames are dispatched and approval answers echo the frame rpcId', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      const frames: MuxFrame[] = []
      client.onMuxEvent((frame) => frames.push(frame))
      fake.pushFrame('/api/events.mux', {
        rpcId: 'approval-rpc-1',
        payload: { type: 'approval/requested', sessionId: 's-1', approvalId: 'a-1', toolName: 'bash', reason: 'run tests' },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(frames.length, 1)
      assert.equal(frames[0]?.type, 'approval/requested')

      await client.resolveApproval('approval-rpc-1', 'allow-once')
      assert.equal(fake.responds.length, 1)
      const respond = fake.responds[0]
      assert.ok(respond)
      assert.equal(respond.rpcId, 'approval-rpc-1')
      assert.deepEqual(respond.result, {
        ok: true,
        value: { sessionId: 's-1', approvalId: 'a-1', outcome: 'allowed-once' },
      })

      // refuse maps to 'rejected'
      fake.pushFrame('/api/events.mux', {
        rpcId: 'approval-rpc-2',
        payload: { type: 'approval/requested', sessionId: 's-1', approvalId: 'a-2', toolName: 'bash' },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await client.resolveApproval('approval-rpc-2', 'refuse')
      const second = fake.responds[1]
      assert.ok(second)
      assert.deepEqual(second.result, {
        ok: true,
        value: { sessionId: 's-1', approvalId: 'a-2', outcome: 'rejected' },
      })

      // unknown request id rejects
      await assert.rejects(client.resolveApproval('nope', 'refuse'), /unknown or already-resolved/)
    })
  } finally {
    await fake.close()
  }
})

test('question answers carry the batch payload echoing the frame rpcId', async () => {
  const fake = await startFakeHost()
  try {
    await withClient(fake, async (client) => {
      fake.pushFrame('/api/events.mux', {
        rpcId: 'question-rpc-1',
        payload: {
          type: 'question/requested',
          sessionId: 's-9',
          questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'A' }, { label: 'B' }] }],
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await client.answerQuestion('question-rpc-1', [{ id: 'q1', selected: ['A'] }])
      const respond = fake.responds[0]
      assert.ok(respond)
      assert.equal(respond.rpcId, 'question-rpc-1')
      assert.deepEqual(respond.result, {
        ok: true,
        value: { sessionId: 's-9', answer: { answers: [{ id: 'q1', selected: ['A'] }] } },
      })
    })
  } finally {
    await fake.close()
  }
})

test('socket drop flips status down and the client reconnects with backoff', async () => {
  const fake = await startFakeHost()
  const statuses: boolean[] = []
  const client = new DshClient()
  client.onStatus((connected) => statuses.push(connected))
  await client.connect({ port: fake.port, spawnedByUs: false })
  try {
    assert.deepEqual(statuses, [true])

    // Simulate a host crash: both WS paths die.
    const muxReupgrade = fake.waitForUpgrade('/api/events.mux')
    const hostReupgrade = fake.waitForUpgrade('/api/events.host')
    fake.dropSockets('/api/events.mux')
    fake.dropSockets('/api/events.host')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(statuses, [true, false])

    // First backoff is 500ms; the reconnect must bring both streams back up.
    await Promise.all([muxReupgrade, hostReupgrade])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(statuses, [true, false, true])
  } finally {
    await client.dispose()
    await fake.close()
  }
})
