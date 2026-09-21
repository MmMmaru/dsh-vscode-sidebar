/**
 * Unit tests for the Remote Events answer path — the migration target of the
 * retired `POST /api/respond` correlation mapping (W5).
 *
 * Two layers are covered against the in-process new-protocol fake host:
 *   - `RemoteEventsClient` (src/extension/transport/events.ts): a waterfall frame
 *     becomes an answer that reaches the host as a UNARY `POST /api/$events/result`
 *     carrying `{clientId, eventId, outcome}`.
 *   - `DshClient` (src/extension/dsh-client.ts): waterfall frames surface through
 *     `onApprovalRequest` / `onQuestionRequest` as overlays keyed by `eventId`,
 *     `resolveApproval` / `answerQuestion` answer with that same id, and a host
 *     `cancel` frame reaches `onApprovalCleared`.
 *
 * There is no `/api/respond`, no `approvalId`, and no rpcId echoing anywhere in
 * this path; the tests assert the exact `$events/result` envelope instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteMuxClient } from '../src/extension/transport/mux'
import { RemoteEventsClient } from '../src/extension/transport/events'
import { DshClient, type ApprovalWaterfall, type QuestionWaterfall } from '../src/extension/dsh-client'
import { startFakeRemoteHost, type FakeRemoteHost } from './fake-remote-host'

/** Run a body against a fresh fake host, always releasing it. */
async function withHost(run: (host: FakeRemoteHost) => Promise<void>): Promise<void> {
  const host = await startFakeRemoteHost({})
  try {
    await run(host)
  } finally {
    await host.close()
  }
}

/** Poll until `check` holds; throws a labelled failure instead of hanging. */
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A subscribed events client plus the frame sinks the assertions read. */
interface EventsHarness {
  client: RemoteEventsClient
  waterfalls: { event: string; eventId: string; agentId: string; request: Record<string, unknown> }[]
  cancels: string[]
}

/**
 * Start a fake host, connect a mux client, and subscribe the events client.
 * @returns the live harness; the caller releases it with `close`.
 */
async function openEvents(host: FakeRemoteHost): Promise<{ harness: EventsHarness; close: () => void }> {
  const mux = new RemoteMuxClient(host.wsUrl)
  const harness: EventsHarness = { client: null as never, waterfalls: [], cancels: [] }
  const client = new RemoteEventsClient(mux, () => ({ baseUrl: host.baseUrl }), {
    onWaterfall: (request) => harness.waterfalls.push(request),
    onCancel: (eventId) => harness.cancels.push(eventId),
  })
  harness.client = client
  mux.connect()
  await mux.whenReady()
  void client.subscribe()
  await waitFor('the $events generation to open', () => client.clientId !== null)
  return {
    harness,
    close: () => {
      client.close()
      mux.dispose()
    },
  }
}

/**
 * Connect a real `DshClient` to the fake host and always dispose it afterwards.
 *
 * `connect()` resolves when the carrier is up; the `$events` subscription is
 * opened right after, asynchronously. A waterfall broadcast before the host has
 * the subscription on the wire is simply never delivered (the host does not
 * replay it), so gate on the host observing the `$events` open.
 */
async function withClient(host: FakeRemoteHost, run: (client: DshClient) => Promise<void>): Promise<void> {
  const client = new DshClient()
  await client.connect({ port: host.port, spawnedByUs: false })
  try {
    await waitFor(
      'the $events subscription to reach the host',
      () => host.streamOpens.some((open) => open.endpoint === '$events'),
    )
    await run(client)
  } finally {
    await client.dispose()
  }
}

// ---- RemoteEventsClient: the unary answer path ----

test('events: an approval decision posts unary $events/result with the mapped outcome', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const eventId = host.waterfall('approval/request', 's1', { toolName: 'Bash', reason: 'needs shell' })
      await waitFor('the waterfall frame', () => harness.waterfalls.length === 1)

      await harness.client.respondApproval(eventId, 'allowed-once')
      await host.waitForEventResults(1)
      assert.deepEqual(host.eventResults[0], {
        clientId: harness.client.clientId,
        eventId,
        outcome: { kind: 'result', value: 'allowed-once' },
      })
      // The action rides alone: no legacy rpcId echo, no flat top-level payload.
      assert.deepEqual(host.calls.map((call) => call.endpoint), ['$events/result'])
      assert.deepEqual(host.calls[0]?.args, {
        clientId: harness.client.clientId,
        eventId,
        outcome: { kind: 'result', value: 'allowed-once' },
      })
    } finally {
      close()
    }
  })
})

test('events: a refusal maps to the rejected outcome on the wire', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const eventId = host.waterfall('approval/request', 's1', { toolName: 'Write' })
      await waitFor('the waterfall frame', () => harness.waterfalls.length === 1)

      await harness.client.respondApproval(eventId, 'rejected')
      await host.waitForEventResults(1)
      assert.deepEqual(host.eventResults[0]?.outcome, { kind: 'result', value: 'rejected' })
      assert.deepEqual(host.calls[0]?.args, {
        clientId: harness.client.clientId,
        eventId,
        outcome: { kind: 'result', value: 'rejected' },
      })
    } finally {
      close()
    }
  })
})

test('events: an answer is keyed by the waterfall eventId, not by arrival order', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const first = host.waterfall('approval/request', 's1', { toolName: 'Bash' })
      const second = host.waterfall('approval/request', 's2', { toolName: 'Write' })
      await waitFor('both waterfall frames', () => harness.waterfalls.length === 2)

      // Answer the SECOND event first: the id on the wire must follow the id the
      // caller passed, not the order the events were delivered in.
      await harness.client.respondApproval(second, 'allowed-once')
      await harness.client.respondApproval(first, 'rejected')
      await host.waitForEventResults(2)
      assert.deepEqual(
        host.eventResults.map((result) => [result.eventId, (result.outcome as { value: unknown }).value]),
        [[second, 'allowed-once'], [first, 'rejected']],
      )
    } finally {
      close()
    }
  })
})

test('events: a question answer wraps the answers array in an {answers} object', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const eventId = host.waterfall('user-questions/request', 's3', {
        questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }],
      })
      await waitFor('the waterfall frame', () => harness.waterfalls.length === 1)

      await harness.client.respondQuestions(eventId, [{ id: 'q1', selected: ['b'], custom: 'note' }])
      await host.waitForEventResults(1)
      // The host reads `value.answers`; a bare array would be a silent no-op.
      assert.deepEqual(host.calls[0]?.args, {
        clientId: harness.client.clientId,
        eventId,
        outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['b'], custom: 'note' }] } },
      })
    } finally {
      close()
    }
  })
})

test('events: an intermediate step answers {kind:next} before the terminal result', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const eventId = host.waterfall('approval/request', 's4', { toolName: 'Bash' })
      await waitFor('the waterfall frame', () => harness.waterfalls.length === 1)

      // Delegation to the next waterfall listener carries NO value.
      await harness.client.respond(eventId, { kind: 'next' })
      await host.waitForEventResults(1)
      assert.deepEqual(host.eventResults[0]?.outcome, { kind: 'next' })

      // The same request id is still answerable and can now be claimed.
      await harness.client.respondApproval(eventId, 'allowed-once')
      await host.waitForEventResults(2)
      assert.deepEqual(
        host.eventResults.map((result) => result.outcome),
        [{ kind: 'next' }, { kind: 'result', value: 'allowed-once' }],
      )
      assert.equal(host.calls.length, 2)
    } finally {
      close()
    }
  })
})

test('events: answering with no live generation is refused locally', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      // Close drops the generation; the host deliberately never saw a request.
      harness.client.close()
      await assert.rejects(
        () => harness.client.respondApproval('wf-1', 'allowed-once'),
        /no live generation/,
      )
      assert.equal(host.calls.length, 0)
      assert.deepEqual(host.eventResults, [])
    } finally {
      close()
    }
  })
})

// `respond` tracks which waterfall ids this generation DELIVERED and has not yet
// settled, mirroring the reference client (dsh-api-gateway remote-events.js:75-149).
// The host rejects an answer for an id it does not consider outstanding, so posting
// one is both useless and a way to corrupt its bookkeeping — it must be refused
// locally, before any HTTP call.
test('events: answering an unknown or already-answered eventId is refused locally', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const eventId = host.waterfall('approval/request', 's5', { toolName: 'Bash' })
      await waitFor('the waterfall frame', () => harness.waterfalls.length === 1)

      // Never delivered by this generation.
      const before = host.calls.length
      await assert.rejects(
        () => harness.client.respondApproval('never-delivered', 'allowed-once'),
        /unknown, already-answered or retracted/,
      )
      assert.equal(host.calls.length, before)
      assert.deepEqual(host.eventResults, [])

      // A delivered, still-outstanding id IS answerable — the guard must not be so
      // strict that it breaks the normal path.
      await harness.client.respondApproval(eventId, 'allowed-once')
      await host.waitForEventResults(1)
      assert.equal(host.eventResults.length, 1)

      // The same id a second time is already settled.
      await assert.rejects(
        () => harness.client.respondApproval(eventId, 'rejected'),
        /unknown, already-answered or retracted/,
      )
      assert.equal(host.calls.length, before + 1)
      assert.equal(host.eventResults.length, 1)
    } finally {
      close()
    }
  })
})

test('events: a cancelled waterfall fires the retraction signal and is no longer answerable', async () => {
  await withHost(async (host) => {
    const { harness, close } = await openEvents(host)
    try {
      const eventId = host.waterfall('approval/request', 's6', { toolName: 'Bash' })
      await waitFor('the waterfall frame', () => harness.waterfalls.length === 1)

      host.cancelWaterfall(eventId)
      await waitFor('the cancel frame', () => harness.cancels.length === 1)
      assert.deepEqual(harness.cancels, [eventId])
      // The UI drops the overlay on this signal before any answer is attempted.
      assert.equal(host.calls.length, 0)

      // The host retracted the request, so it is no longer outstanding there and an
      // answer would be rejected. Racing a cancel is real (the tool can time out
      // while the overlay is on screen), so this must be a local refusal, not a
      // failed round trip the user sees as an error.
      await assert.rejects(
        () => harness.client.respondApproval(eventId, 'allowed-once'),
        /unknown, already-answered or retracted/,
      )
      assert.equal(host.calls.length, 0)
      assert.deepEqual(host.eventResults, [])
    } finally {
      close()
    }
  })
})

// ---- DshClient: overlay surface and the answer route ----

test('overlay: an approval/request waterfall surfaces as an overlay keyed by eventId', async () => {
  await withHost(async (host) => {
    await withClient(host, async (client) => {
      const approvals: ApprovalWaterfall[] = []
      client.onApprovalRequest((request) => approvals.push(request))

      const eventId = host.waterfall('approval/request', 'sess-a', {
        toolName: 'Bash',
        callId: 'call-7',
        reason: 'needs shell',
      })
      await waitFor('the approval overlay', () => approvals.length === 1)
      assert.deepEqual(approvals[0], {
        eventId,
        agentId: 'sess-a',
        toolName: 'Bash',
        callId: 'call-7',
        reason: 'needs shell',
      })

      // The overlay's own eventId is the reply key: no approvalId, no mapping.
      await client.resolveApproval(approvals[0]!.eventId, 'allow-once')
      await host.waitForEventResults(1)
      assert.equal(host.eventResults[0]?.eventId, eventId)
      assert.deepEqual(host.eventResults[0]?.outcome, { kind: 'result', value: 'allowed-once' })
      // The answer is correlated to the live generation's clientId.
      assert.notEqual(host.eventResults[0]?.clientId, undefined)
    })
  })
})

test('overlay: a user-questions waterfall surfaces with its batch and answers by eventId', async () => {
  await withHost(async (host) => {
    await withClient(host, async (client) => {
      const batches: QuestionWaterfall[] = []
      client.onQuestionRequest((request) => batches.push(request))

      const eventId = host.waterfall('user-questions/request', 'sess-b', {
        questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      })
      await waitFor('the question overlay', () => batches.length === 1)
      assert.equal(batches[0]?.eventId, eventId)
      assert.equal(batches[0]?.agentId, 'sess-b')
      assert.deepEqual(batches[0]?.questions, [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }])

      await client.answerQuestion(batches[0]!.eventId, [{ id: 'q1', selected: ['B'] }])
      await host.waitForEventResults(1)
      const answer = host.eventResults[0]
      assert.deepEqual(answer?.outcome, {
        kind: 'result',
        value: { answers: [{ id: 'q1', selected: ['B'] }] },
      })
      assert.equal(answer?.eventId, eventId)
      assert.equal(typeof answer?.clientId, 'string')
    })
  })
})

test('overlay: a refusal answers with rejected, and a retracted overlay clears the UI', async () => {
  await withHost(async (host) => {
    await withClient(host, async (client) => {
      const approvals: ApprovalWaterfall[] = []
      const cleared: string[] = []
      client.onApprovalRequest((request) => approvals.push(request))
      client.onApprovalCleared((id) => cleared.push(id))

      const refused = host.waterfall('approval/request', 'sess-c', { toolName: 'Bash' })
      await waitFor('the first overlay', () => approvals.length === 1)
      await client.resolveApproval(refused, 'refuse')
      await host.waitForEventResults(1)
      assert.deepEqual(host.eventResults[0]?.outcome, { kind: 'result', value: 'rejected' })

      const retracted = host.waterfall('approval/request', 'sess-c', { toolName: 'Write' })
      await waitFor('the second overlay', () => approvals.length === 2)
      host.cancelWaterfall(retracted)
      await waitFor('the retraction', () => cleared.length === 1)
      // Only the retracted request is cleared; the answered one is not re-announced.
      assert.deepEqual(cleared, [retracted])
    })
  })
})

test('overlay: answering through a disposed client is refused locally', async () => {
  const host = await startFakeRemoteHost({})
  try {
    const client = new DshClient()
    await client.connect({ port: host.port, spawnedByUs: false })
    await client.dispose()
    await assert.rejects(
      () => client.resolveApproval('wf-1', 'allow-once'),
      /not connected|no live generation/,
    )
    assert.equal(host.calls.length, 0)
  } finally {
    await host.close()
  }
})
