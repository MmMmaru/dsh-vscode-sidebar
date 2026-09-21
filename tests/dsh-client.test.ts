/**
 * Unit tests for DshClient: unary pairing, business/transport error
 * propagation, four-channel dispatch, approval/question answering, and
 * reconnect. The socket traffic hits an in-process fake Typert Remote host
 * (tests/fake-remote-host.ts); the channel seam (`emitChannel`) is covered
 * without any host at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshClient, RpcBusinessError, type QuestionWaterfall } from '../src/extension/dsh-client'
import { RpcTransportError } from '../src/extension/transport/unary'
import type { SessionControlFrame, SessionFollowFrame } from '../src/extension/protocol/follow'
import type { WorkspaceFollowFrame } from '../src/extension/protocol/workspace'
import type { SessionId } from '../src/extension/protocol/brand'
import { startFakeRemoteHost, type FakeRemoteHost } from './fake-remote-host'

/**
 * Run a body against a fresh fake host and a connected client, always releasing
 * both. The two Host-wide streams are declared push-driven so the fake keeps
 * them open: the client opens `session/control` and `workspace/follow` itself.
 */
async function withClient(
  fakeOptions: NonNullable<Parameters<typeof startFakeRemoteHost>[0]>,
  run: (host: FakeRemoteHost, client: DshClient) => Promise<void>,
): Promise<void> {
  const host = await startFakeRemoteHost(fakeOptions)
  host.pushDriven('session/control')
  host.pushDriven('workspace/follow')
  const client = new DshClient()
  try {
    const token = fakeOptions.requireToken
    await client.connect({ port: host.port, spawnedByUs: false, ...(token === undefined ? {} : { token }) })
    await run(host, client)
  } finally {
    await client.dispose()
    await host.close()
  }
}

/** Poll until a predicate holds; fails the calling test when it never does. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'condition not met before the timeout')
}

/**
 * Wait until the client's `$events` subscription exists on the fake host.
 * `connect()` subscribes asynchronously, and a waterfall broadcast to a
 * subscription that does not exist yet is simply dropped.
 */
async function waitForEventSubscription(host: FakeRemoteHost): Promise<void> {
  await waitFor(() => host.streamOpens.some((open) => open.endpoint === '$events'))
}

test('rpc pairs each answer with its own request and returns the value', async () => {
  await withClient({}, async (host, client) => {
    host.handleValue('session/list', { items: [{ sessionId: 'a' }] })
    host.handleValue('goals/get', { phase: 'active' })

    // Two calls in flight at once: the transport must pair the responses.
    const [list, goal] = await Promise.all([
      client.rpc<{ items: { sessionId: string }[] }>('session/list', { _request: {} }),
      client.rpc<{ phase: string }>('goals/get', { agentId: 's1' }),
    ])
    assert.deepEqual(list, { items: [{ sessionId: 'a' }] })
    assert.deepEqual(goal, { phase: 'active' })
    assert.equal(host.calls.length, 2)
    // Arguments ride `payload.args`, and each method keeps its own envelope.
    assert.deepEqual(host.calls.find((call) => call.endpoint === 'goals/get')?.args, { agentId: 's1' })
  })
})

test('sessionList unwraps the list and sends the _request envelope', async () => {
  await withClient({}, async (host, client) => {
    host.handleValue('session/list', { items: [{ sessionId: 'a' }, { sessionId: 'b' }] })
    const rows = await client.sessionList()
    assert.deepEqual(rows.map((row) => row.sessionId), ['a', 'b'])
    // `session/list` is the one endpoint whose parameter is `_request`.
    assert.deepEqual(host.calls[0]?.args, { _request: {} })
  })
})

test('rpc propagates business failures as RpcBusinessError with the code', async () => {
  await withClient({}, async (host, client) => {
    host.handle('session/list', () => ({
      ok: false,
      error: { code: 'agent-busy', message: 'busy now', details: { reason: 'running' } },
    }))
    await assert.rejects(
      client.sessionList(),
      (error: unknown) => error instanceof RpcBusinessError
        && error.code === 'agent-busy'
        && error.message === 'busy now',
    )
  })
})

test('an unmounted endpoint is a transport failure, not a business error', async () => {
  await withClient({}, async (host, client) => {
    // `host/describe` is retired in 0.1.5-rc.2: the host answers 404 with a
    // plain-text body rather than a business failure envelope.
    void host
    await assert.rejects(
      () => client.rpc('host/describe', {}),
      (error: unknown) => error instanceof RpcTransportError && error.status === 404,
    )
  })
})

test('promptSession mints the requestId the host requires', async () => {
  await withClient({}, async (host, client) => {
    host.handleValue('session/prompt', { accepted: true })
    await client.promptSession('s-1' as SessionId, [{ type: 'text', text: 'hi' }], 'steer')
    const request = host.calls[0]?.args['request'] as Record<string, unknown> | undefined
    assert.equal(typeof request?.['requestId'], 'string')
    assert.equal((request?.['requestId'] as string).length > 0, true)
    assert.equal(request?.['sessionId'], 's-1')
    assert.equal(request?.['mode'], 'steer')
    assert.deepEqual(request?.['content'], [{ type: 'text', text: 'hi' }])
  })
})

test('emitChannel dispatches every channel to its own listener family', async () => {
  const client = new DshClient()
  const control: SessionControlFrame[] = []
  const workspace: WorkspaceFollowFrame[] = []
  const session: SessionFollowFrame[] = []
  const remote: { event: string; args: unknown[] }[] = []
  client.onSessionControl((frame) => control.push(frame))
  client.onWorkspace((frame) => workspace.push(frame))
  client.onRemoteEvent((event, args) => remote.push({ event, args }))
  const followed = client.followSession({ kind: 'session', sessionId: 's-1' as SessionId }, (frame) => session.push(frame))
  try {
    client.emitChannel({ channel: 'control', frame: { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } } })
    client.emitChannel({ channel: 'workspace', frame: { type: 'baseline', value: { items: [], archivedSessionIds: [] } } })
    client.emitChannel({
      channel: 'session',
      frame: {
        type: 'snapshot',
        header: { version: 1, id: 's-1' as SessionId, createdAt: 0, isSeeded: false },
        cursor: 0,
        records: [],
        hasMore: false,
      },
    })
    client.emitChannel({ channel: 'remote', event: 'api-session/status', args: ['s-1', true] })

    assert.equal(control.length, 1)
    assert.equal(control[0]?.type, 'baseline')
    assert.equal(workspace.length, 1)
    assert.equal(session.length, 1)
    assert.equal(session[0]?.type, 'snapshot')
    assert.deepEqual(remote, [{ event: 'api-session/status', args: ['s-1', true] }])
  } finally {
    followed.cancel()
    await client.dispose()
  }
})

test('approval waterfalls arrive on the remote channel and answers carry their eventId', async () => {
  await withClient({}, async (host, client) => {
    const received: { eventId: string; agentId: string; toolName: string; reason?: string }[] = []
    const cleared: string[] = []
    client.onApprovalRequest((request) => received.push(request))
    client.onApprovalCleared((eventId) => cleared.push(eventId))
    await waitForEventSubscription(host)

    const eventId = host.waterfall('approval/request', 's-1', { toolName: 'bash', reason: 'run tests' })
    await waitFor(() => received.length === 1)
    assert.deepEqual(received[0], { eventId, agentId: 's-1', toolName: 'bash', reason: 'run tests' })

    await client.resolveApproval(eventId, 'allow-once')
    await host.waitForEventResults(1)
    assert.equal(host.eventResults[0]?.eventId, eventId)
    assert.deepEqual(host.eventResults[0]?.outcome, { kind: 'result', value: 'allowed-once' })

    // refuse maps to 'rejected'
    const second = host.waterfall('approval/request', 's-1', { toolName: 'bash' })
    await waitFor(() => received.length === 2)
    await client.resolveApproval(second, 'refuse')
    await host.waitForEventResults(2)
    assert.deepEqual(host.eventResults[1]?.outcome, { kind: 'result', value: 'rejected' })

    // The host retracting the request must clear the pending prompt.
    host.cancelWaterfall(second)
    await waitFor(() => cleared.length === 1)
    assert.deepEqual(cleared, [second])
  })
})

test('question answers carry the batch payload with their eventId', async () => {
  await withClient({}, async (host, client) => {
    const received: QuestionWaterfall[] = []
    client.onQuestionRequest((request) => received.push(request))
    await waitForEventSubscription(host)

    const questions = [{ id: 'q1', question: 'pick one', options: [{ label: 'A' }, { label: 'B' }] }]
    const eventId = host.waterfall('user-questions/request', 's-9', { questions })
    await waitFor(() => received.length === 1)
    assert.equal(received[0]?.eventId, eventId)
    assert.equal(received[0]?.agentId, 's-9')
    assert.deepEqual(received[0]?.questions, questions)

    await client.answerQuestion(eventId, [{ id: 'q1', selected: ['A'] }])
    await host.waitForEventResults(1)
    assert.equal(host.eventResults[0]?.eventId, eventId)
    assert.deepEqual(host.eventResults[0]?.outcome, {
      kind: 'result',
      value: { answers: [{ id: 'q1', selected: ['A'] }] },
    })
  })
})

test('answering before the client is connected is refused locally', async () => {
  const client = new DshClient()
  await assert.rejects(() => client.resolveApproval('wf-1', 'refuse'), /not connected/)
  await assert.rejects(() => client.answerQuestion('wf-1', []), /not connected/)
})

test('socket drop flips status down and the client reconnects with backoff', async () => {
  const host = await startFakeRemoteHost()
  host.pushDriven('session/control')
  host.pushDriven('workspace/follow')
  const statuses: boolean[] = []
  const controls: SessionControlFrame[] = []
  const remotes: string[] = []
  const client = new DshClient()
  client.onStatus((connected) => statuses.push(connected))
  client.onSessionControl((frame) => controls.push(frame))
  client.onRemoteEvent((event) => remotes.push(event))
  try {
    await client.connect({ port: host.port, spawnedByUs: false })
    assert.deepEqual(statuses, [true])
    // Counted before the drop: the opening `open` frames may still be in flight,
    // so the reconnect is asserted as growth, never as an absolute count.
    const controlOpens = host.streamOpens.filter((open) => open.endpoint === 'session/control').length
    const eventOpens = host.streamOpens.filter((open) => open.endpoint === '$events').length

    // Simulate a host crash: the single carrier socket dies.
    host.dropSockets()
    await waitFor(() => statuses.length >= 2)
    assert.deepEqual(statuses, [true, false])

    // First backoff is 500ms; the reconnect must bring the carrier back up.
    await waitFor(() => statuses.length >= 3, 5_000)
    assert.deepEqual(statuses, [true, false, true])

    // A lost carrier ends EVERY generation, so the Host-wide streams and the
    // `$events` subscription have to be reopened: their `open` frames are
    // issued while the socket is still down and must survive until it opens.
    // Without those reopens the client reports itself connected while receiving
    // nothing for the rest of the session.
    await waitFor(() => host.streamOpens.filter((open) => open.endpoint === 'session/control').length > controlOpens, 5_000)
    await waitFor(() => host.streamOpens.filter((open) => open.endpoint === '$events').length > eventOpens, 5_000)
    host.pushStream('session/control', { type: 'projection', sessionId: 's-1', key: 'title', value: 't', seq: 1 })
    host.emit('api-session/status', ['s-1', true])
    await waitFor(() => controls.length >= 1 && remotes.length >= 1, 5_000)
    assert.equal(controls[0]?.type, 'projection')
    assert.deepEqual(remotes, ['api-session/status'])
  } finally {
    await client.dispose()
    await host.close()
  }
})

test('client works seamlessly with token auth', async () => {
  const token = 'client-auth-token-xyz'
  await withClient({ requireToken: token }, async (host, client) => {
    host.handleValue('session/list', { items: [{ sessionId: 'a' }] })
    const rows = await client.sessionList()
    assert.deepEqual(rows.map((row) => row.sessionId), ['a'])
    assert.equal(host.calls.length, 1)
  })
})
