/**
 * Unit tests for the Typert Remote transport layer: the unary carrier, the
 * `/api/remote.mux` stream carrier, and the forwarded-event client.
 * All traffic hits an in-process fake new-protocol host (tests/fake-remote-host.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RpcBusinessError, RpcTransportError, callRemoteOutcome, callRemoteUnary } from '../src/extension/transport/unary'
import { RemoteMuxClient, RemoteStreamError } from '../src/extension/transport/mux'
import { RemoteEventsClient } from '../src/extension/transport/events'
import { startFakeRemoteHost, type FakeRemoteHost } from './fake-remote-host'

/** Run a body against a fresh fake host, always releasing it. */
async function withHost(
  options: Parameters<typeof startFakeRemoteHost>[0],
  run: (host: FakeRemoteHost) => Promise<void>,
): Promise<void> {
  const host = await startFakeRemoteHost(options)
  try {
    await run(host)
  } finally {
    await host.close()
  }
}

test('unary: a success answer yields the method value', async () => {
  await withHost({}, async (host) => {
    host.handleValue('session/list', { items: [{ sessionId: 'a' }], hasMore: false })
    const value = await callRemoteUnary<{ items: unknown[] }>({ baseUrl: host.baseUrl }, 'session/list', { _request: {} })
    assert.equal(value.items.length, 1)
    assert.deepEqual(host.calls[0]?.args, { _request: {} })
  })
})

test('unary: args ride under payload.args, not at the top level', async () => {
  await withHost({}, async (host) => {
    host.handleValue('goals/get', { phase: 'active' })
    await callRemoteUnary({ baseUrl: host.baseUrl }, 'goals/get', { agentId: 's1' })
    // The fake host only ever reads payload.args; a flat payload would surface as {}.
    assert.deepEqual(host.calls[0]?.args, { agentId: 's1' })
  })
})

test('unary: a business failure raises RpcBusinessError with its code and details', async () => {
  await withHost({}, async (host) => {
    host.handle('session/prompt', () => ({
      ok: false,
      error: { code: 'agent-busy', message: 'busy now', details: { reason: 'running' } },
    }))
    await assert.rejects(
      () => callRemoteUnary({ baseUrl: host.baseUrl }, 'session/prompt', {}),
      (error: unknown) => {
        assert.ok(error instanceof RpcBusinessError)
        assert.equal(error.code, 'agent-busy')
        assert.equal(error.message, 'busy now')
        assert.deepEqual(error.details, { reason: 'running' })
        return true
      },
    )
  })
})

test('unary: an unknown route is a transport failure, not a JSON parse error', async () => {
  await withHost({}, async (host) => {
    const outcome = await callRemoteOutcome({ baseUrl: host.baseUrl }, 'host/describe', {})
    assert.equal(outcome.kind, 'transport')
    assert.equal(outcome.kind === 'transport' ? outcome.status : -1, 404)
    // The plain-text body must survive verbatim; the old client choked on this.
    assert.equal(outcome.kind === 'transport' ? outcome.body : '', 'not found')
    await assert.rejects(
      () => callRemoteUnary({ baseUrl: host.baseUrl }, 'host/describe', {}),
      (error: unknown) => error instanceof RpcTransportError && error.status === 404,
    )
  })
})

test('unary: a missing credential surfaces as 401 unauthorized', async () => {
  await withHost({ requireCookie: 'dsh-auth-x=good' }, async (host) => {
    host.handleValue('settings/describe', { namespaces: [] })
    const rejected = await callRemoteOutcome({ baseUrl: host.baseUrl }, 'settings/describe', {})
    assert.equal(rejected.kind === 'transport' ? rejected.status : -1, 401)
    assert.equal(rejected.kind === 'transport' ? rejected.body : '', 'unauthorized')
    const accepted = await callRemoteUnary(
      { baseUrl: host.baseUrl, cookie: 'dsh-auth-x=good' },
      'settings/describe',
      {},
    )
    assert.deepEqual(accepted, { namespaces: [] })
    assert.equal(host.calls[0]?.cookie, 'dsh-auth-x=good')
  })
})

test('unary: a bearer token is sent when configured', async () => {
  await withHost({ requireToken: 'secret' }, async (host) => {
    host.handleValue('session/modelCatalog', { groups: [] })
    await callRemoteUnary({ baseUrl: host.baseUrl, token: 'secret' }, 'session/modelCatalog', {})
    assert.equal(host.calls.length, 1)
  })
})

test('mux: a logical stream yields every item then ends', async () => {
  await withHost({}, async (host) => {
    host.stream('workspace/follow', [
      { type: 'baseline', value: { items: [], archivedSessionIds: [] } },
      { type: 'upsert', workspace: { workspaceId: 'w1' } },
    ])
    const mux = new RemoteMuxClient(host.wsUrl)
    try {
      mux.connect()
      await mux.whenReady()
      const frames: unknown[] = []
      for await (const frame of mux.openStream('workspace/follow')) frames.push(frame)
      assert.deepEqual(frames, [
        { type: 'baseline', value: { items: [], archivedSessionIds: [] } },
        { type: 'upsert', workspace: { workspaceId: 'w1' } },
      ])
      assert.deepEqual(host.streamOpens[0]?.args, {})
    } finally {
      mux.dispose()
    }
  })
})

test('mux: a host stream error fails the iteration with its code', async () => {
  await withHost({}, async (host) => {
    const mux = new RemoteMuxClient(host.wsUrl)
    try {
      mux.connect()
      await mux.whenReady()
      const stream = mux.openStream('session/follow')
      await assert.rejects(
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _frame of stream) {
            // The host answers `gateway/not-found`; the loop must throw.
          }
        },
        (error: unknown) => error instanceof RemoteStreamError && error.code === 'gateway/invocation-unavailable',
      )
    } finally {
      mux.dispose()
    }
  })
})

test('mux: concurrent logical streams stay independent', async () => {
  await withHost({}, async (host) => {
    host.stream('session/control', [{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }])
    host.stream('workspace/follow', [{ type: 'baseline', value: { items: [], archivedSessionIds: [] } }])
    const mux = new RemoteMuxClient(host.wsUrl)
    try {
      mux.connect()
      await mux.whenReady()
      const control: unknown[] = []
      const workspace: unknown[] = []
      await Promise.all([
        (async () => {
          for await (const frame of mux.openStream('session/control')) control.push(frame)
        })(),
        (async () => {
          for await (const frame of mux.openStream('workspace/follow')) workspace.push(frame)
        })(),
      ])
      assert.equal(control.length, 1)
      assert.equal(workspace.length, 1)
      assert.equal(host.streamOpens.length, 2)
    } finally {
      mux.dispose()
    }
  })
})

test('mux: cancelling a stream settles its iteration', async () => {
  await withHost({}, async (host) => {
    // No producer registered, so the stream stays open until cancelled.
    const mux = new RemoteMuxClient(host.wsUrl)
    try {
      mux.connect()
      await mux.whenReady()
      const stream = mux.openStream('session/follow')
      const drained = (async () => {
        for await (const _frame of stream) {
          // Nothing arrives before the cancel is observed.
        }
        return 'settled'
      })()
      stream.cancel()
      assert.equal(await drained, 'settled')
      // The local queue settles synchronously, so the frames reach the host on
      // a later tick; wait for it to observe the cancel before asserting.
      for (let attempt = 0; attempt < 100 && host.streamCancels.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.deepEqual(host.streamCancels.map((cancel) => cancel.endpoint), ['session/follow'])
      assert.deepEqual(host.streamOpens.map((open) => open.endpoint), ['session/follow'])
    } finally {
      mux.dispose()
    }
  })
})

test('mux: carrier loss fails live streams and reports a lost generation', async () => {
  await withHost({}, async (host) => {
    const mux = new RemoteMuxClient(host.wsUrl)
    try {
      mux.connect()
      await mux.whenReady()
      const lost: string[] = []
      mux.onCarrierLost(() => lost.push('lost'))
      const stream = mux.openStream('session/control')
      const drained = assert.rejects(
        async () => {
          for await (const _frame of stream) {
            // The carrier dies before anything is produced.
          }
        },
        (error: unknown) => error instanceof RemoteStreamError && error.carrier,
      )
      host.dropSockets()
      await drained
      assert.deepEqual(lost, ['lost'])
    } finally {
      mux.dispose()
    }
  })
})

test('remote events: ready/emit/waterfall arrive and answers reach the host', async () => {
  await withHost({}, async (host) => {
    const mux = new RemoteMuxClient(host.wsUrl)
    const emitted: { event: string; args: unknown[] }[] = []
    const waterfalls: { event: string; eventId: string; agentId: string }[] = []
    const client = new RemoteEventsClient(
      mux,
      () => ({ baseUrl: host.baseUrl }),
      {
        onEmit: (event, args) => emitted.push({ event, args }),
        onWaterfall: (request) => waterfalls.push(request),
      },
    )
    try {
      mux.connect()
      await mux.whenReady()
      const subscribed = client.subscribe()
      // Wait for the subscription to be established before broadcasting.
      for (let attempt = 0; attempt < 100 && client.clientId === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.notEqual(client.clientId, null)

      host.emit('api-session/status', ['s1', true])
      const approvalId = host.waterfall('approval/request', 's1', { toolName: 'Bash', reason: 'needs shell' })

      for (let attempt = 0; attempt < 100 && waterfalls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.deepEqual(emitted, [{ event: 'api-session/status', args: ['s1', true] }])
      assert.equal(waterfalls[0]?.event, 'approval/request')
      assert.equal(waterfalls[0]?.agentId, 's1')

      await client.respondApproval(approvalId, 'allowed-once')
      await host.waitForEventResults(1)
      assert.deepEqual(host.eventResults[0], {
        clientId: client.clientId,
        eventId: approvalId,
        outcome: { kind: 'result', value: 'allowed-once' },
      })

      client.close()
      subscribed.then(
        () => undefined,
        () => undefined,
      )
    } finally {
      client.close()
      mux.dispose()
    }
  })
})

test('remote events: a question answer carries the answers array', async () => {
  await withHost({}, async (host) => {
    const mux = new RemoteMuxClient(host.wsUrl)
    const waterfalls: { eventId: string }[] = []
    const client = new RemoteEventsClient(mux, () => ({ baseUrl: host.baseUrl }), {
      onWaterfall: (request) => waterfalls.push(request),
    })
    try {
      mux.connect()
      await mux.whenReady()
      void client.subscribe()
      for (let attempt = 0; attempt < 100 && client.clientId === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const eventId = host.waterfall('user-questions/request', 's2', {
        questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }],
      })
      for (let attempt = 0; attempt < 100 && waterfalls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await client.respondQuestions(eventId, [{ id: 'q1', selected: ['b'] }])
      await host.waitForEventResults(1)
      assert.deepEqual(host.eventResults[0]?.outcome, {
        kind: 'result',
        value: { answers: [{ id: 'q1', selected: ['b'] }] },
      })
    } finally {
      client.close()
      mux.dispose()
    }
  })
})

test('remote events: answering without a live generation is refused locally', async () => {
  await withHost({}, async (host) => {
    const mux = new RemoteMuxClient(host.wsUrl)
    const client = new RemoteEventsClient(mux, () => ({ baseUrl: host.baseUrl }), {})
    try {
      await assert.rejects(() => client.respondApproval('wf-1', 'allowed-once'), /no live generation/)
    } finally {
      client.close()
      mux.dispose()
    }
  })
})
