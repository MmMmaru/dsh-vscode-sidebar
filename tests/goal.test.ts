/** Durable Goal projection, CAS action, session-isolation, and GoalBar tests. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import type { GoalId, SessionId } from '../src/extension/protocol/brand'
import type { SessionFollowFrame } from '../src/extension/protocol/follow'
import type { GoalPhase, GoalProjection } from '../src/extension/protocol/goals'
import { goalBarVisible } from '../src/webview/components/composer/GoalBar'
import { GoalBar } from '../src/webview/components/composer/GoalBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const a = 'goal-session-a' as SessionId
const b = 'goal-session-b' as SessionId
const demo = 's-demo' as SessionId

function projection(id: string, revision = 1, phase: GoalPhase = 'active', objective = 'Ship Goal bar'): GoalProjection {
  return {
    goal: { id: id as GoalId, revision, objective, phase, maxGoalRounds: 4 },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

test('history installs the goal projection, while stale history and control frames cannot overwrite it', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ activeSessionId: a, goal: undefined })

  state.applyGoalHistory(a, { goal: projection('a') })
  assert.equal(useAppStore.getState().goal?.goal.id, 'a')

  state.applyGoalHistory(b, { goal: projection('b') })
  assert.equal(useAppStore.getState().goal?.goal.id, 'a')

  // The control stream is Host-wide: a projection for another session is not
  // this session's goal and must not be installed.
  state.applyGoalProjection({ type: 'projection', sessionId: b, key: 'goal', value: projection('b'), seq: 2 })
  assert.equal(useAppStore.getState().goal?.goal.id, 'a')

  // A non-`goal` key belongs to another slice.
  state.applyGoalProjection({ type: 'projection', sessionId: a, key: 'title', value: 'renamed', seq: 2 })
  assert.equal(useAppStore.getState().goal?.goal.id, 'a')

  state.applyGoalProjection({ type: 'projection', sessionId: a, key: 'goal', value: projection('a', 2, 'paused'), seq: 3 })
  assert.equal(useAppStore.getState().goal?.goal.phase, 'paused')

  // `null` is the durable clear tombstone, not "keep the last value".
  state.applyGoalProjection({ type: 'projection', sessionId: a, key: 'goal', value: null, seq: 4 })
  assert.equal(useAppStore.getState().goal, null)

  // With no active session there is nothing to project onto.
  useAppStore.setState({ activeSessionId: null, goal: undefined })
  state.applyGoalProjection({ type: 'projection', sessionId: a, key: 'goal', value: projection('a'), seq: 5 })
  assert.equal(useAppStore.getState().goal, undefined)
})

test('null, absent and complete projections hide the bar; complete is still stored', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()

  useAppStore.setState({ activeSessionId: a, goal: undefined })
  state.applyGoalHistory(a, {})
  assert.equal(useAppStore.getState().goal, undefined)
  assert.equal(goalBarVisible(useAppStore.getState().goal), false)

  state.applyGoalHistory(a, { goal: projection('complete', 1, 'complete') })
  assert.equal(useAppStore.getState().goal?.goal.phase, 'complete')
  assert.equal(goalBarVisible(useAppStore.getState().goal), false)
})

test('clearConversation and deleteSession reset goal; non-active delete preserves it', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()

  useAppStore.setState({ activeSessionId: a, goal: projection('delete-me'), sessions: [
    { sessionId: a, title: null, updatedAt: 2, running: false, blank: false },
    { sessionId: b, title: null, updatedAt: 1, running: false, blank: false },
  ] })
  await state.deleteSession(b)
  assert.equal(useAppStore.getState().goal?.goal.id, 'delete-me')

  useAppStore.setState({ sessions: [{ sessionId: a, title: null, updatedAt: 2, running: false, blank: false }] })
  await state.deleteSession(a)
  assert.equal(useAppStore.getState().activeSessionId, null)
  assert.equal(useAppStore.getState().goal, undefined)
})

test('mutations send the latest projection ref via RPC without optimistic updates', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')
  const { mockBridge, mockGoalRpcLog } = await import('../src/webview/mock/bridge')

  // `agentId` is the session id; the mutation request rides a nested `request`.
  const created = await mockBridge.rpc<{ ref: { id: GoalId; revision: number } }>('goals/create', {
    agentId: demo,
    request: { objective: 'action target', maxGoalRounds: 2 },
  })
  useAppStore.setState({ activeSessionId: demo, goal: projection(created.ref.id, created.ref.revision, 'active', 'action target') })
  mockGoalRpcLog.length = 0

  await useAppStore.getState().pauseGoal()
  assert.equal(mockGoalRpcLog.at(-1)?.method, 'goals/pause')
  assert.deepEqual(mockGoalRpcLog.at(-1)?.params, { agentId: demo, ref: { id: created.ref.id, revision: 1 } })
  // No optimistic update: the projection only changes when the control frame lands.
  assert.equal(useAppStore.getState().goal?.goal.revision, 1)
  assert.equal(useAppStore.getState().goal?.goal.phase, 'active')

  useAppStore.getState().applyGoalProjection({ type: 'projection', sessionId: demo, key: 'goal', value: projection(created.ref.id, 2, 'paused', 'action target'), seq: 1 })
  await useAppStore.getState().resumeGoal()
  assert.equal(mockGoalRpcLog.at(-1)?.method, 'goals/resume')
  assert.deepEqual(mockGoalRpcLog.at(-1)?.params.ref, { id: created.ref.id, revision: 2 })

  useAppStore.getState().applyGoalProjection({ type: 'projection', sessionId: demo, key: 'goal', value: projection(created.ref.id, 3, 'active', 'action target'), seq: 2 })
  await useAppStore.getState().editGoal('New objective')
  assert.equal(mockGoalRpcLog.at(-1)?.method, 'goals/edit')
  assert.deepEqual(mockGoalRpcLog.at(-1)?.params, {
    agentId: demo,
    ref: { id: created.ref.id, revision: 3 },
    request: { objective: 'New objective' },
  })

  useAppStore.getState().applyGoalProjection({ type: 'projection', sessionId: demo, key: 'goal', value: projection(created.ref.id, 4, 'active', 'New objective'), seq: 3 })
  await useAppStore.getState().clearGoal()
  assert.equal(mockGoalRpcLog.at(-1)?.method, 'goals/clear')
  assert.deepEqual(mockGoalRpcLog.at(-1)?.params, { agentId: demo, ref: { id: created.ref.id, revision: 4 } })
  // `goals/clear` answers the cleared ref; the tombstone arrives on the stream.
  assert.equal(useAppStore.getState().goal?.goal.revision, 4)

  useAppStore.getState().applyGoalProjection({ type: 'projection', sessionId: demo, key: 'goal', value: null, seq: 4 })
  assert.equal(useAppStore.getState().goal, null)
})

test('the session/follow opening snapshot installs the goal projection from its baseline', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')
  const sessionId = 's-goal-hist' as SessionId
  useAppStore.setState({ activeSessionId: sessionId, goal: undefined })

  // History is no longer a unary load: the `session/follow` generation opens
  // with one snapshot whose complete projection cut carries the goal value.
  const snapshot: SessionFollowFrame = {
    type: 'snapshot',
    header: { version: 1, id: sessionId, createdAt: 1, isSeeded: false },
    cursor: 3,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 3, values: { goal: projection('from-snapshot') } },
  }
  useAppStore.getState().applySessionFrame(snapshot)
  assert.equal(useAppStore.getState().goal?.goal.id, 'from-snapshot')

  // A cut that omits `goal` means the unit is absent, not "keep the last one".
  useAppStore.getState().applySessionFrame({ ...snapshot, projections: { asOfSeq: 4, values: {} } })
  assert.equal(useAppStore.getState().goal, undefined)

  // A superseded generation for another session must not install its goal.
  useAppStore.setState({ activeSessionId: sessionId, goal: projection('keep-me') })
  useAppStore.getState().applySessionFrame({ ...snapshot, header: { ...snapshot.header, id: b } })
  assert.equal(useAppStore.getState().goal?.goal.id, 'keep-me')
})

test('goalRef refuses a mutation with no active session or no goal', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')

  // No active session: the CAS ref cannot be addressed at all.
  useAppStore.setState({ activeSessionId: null, goal: projection('orphan') })
  await assert.rejects(useAppStore.getState().pauseGoal(), /当前会话没有可操作的目标/)

  // Active session, but the projection has not arrived yet (undefined = loading).
  useAppStore.setState({ activeSessionId: a, goal: undefined })
  await assert.rejects(useAppStore.getState().resumeGoal(), /当前会话没有可操作的目标/)

  // Cleared tombstone: there is no goal to edit either.
  useAppStore.setState({ activeSessionId: a, goal: null })
  await assert.rejects(useAppStore.getState().editGoal('New objective'), /当前会话没有可操作的目标/)
  await assert.rejects(useAppStore.getState().clearGoal(), /当前会话没有可操作的目标/)
})

test('a failed mutation keeps the projection and surfaces the error to the caller', async () => {
  ;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
  const { useAppStore } = await import('../src/webview/store')
  const state = useAppStore.getState()
  useAppStore.setState({ activeSessionId: a, goal: projection('not-in-mock') })
  await assert.rejects(state.pauseGoal(), /revision conflict/)
  assert.equal(useAppStore.getState().goal?.goal.id, 'not-in-mock')
})

test('GoalBar SSR exposes phase, blocked reason tooltip, aria actions and hides complete goals', () => {
  const noop = async (): Promise<void> => undefined
  const active = renderToStaticMarkup(React.createElement(GoalBar, {
    goal: projection('ui'), onEdit: noop, onPause: noop, onResume: noop, onClear: noop,
  }))
  assert.match(active, /data-goal-bar/)
  assert.match(active, /进行中/)
  assert.match(active, /aria-label="暂停目标"/)
  assert.match(active, /aria-label="编辑目标"/)
  assert.match(active, /aria-label="清除目标"/)

  const paused = renderToStaticMarkup(React.createElement(GoalBar, {
    goal: projection('paused', 2, 'paused'), onEdit: noop, onPause: noop, onResume: noop, onClear: noop,
  }))
  assert.match(paused, /已暂停/)
  assert.match(paused, /aria-label="恢复目标"/)

  const blocked = renderToStaticMarkup(React.createElement(GoalBar, {
    goal: { ...projection('blocked'), goal: { ...projection('blocked').goal, phase: 'blocked', blockedReason: { code: 'stalled', message: '连续三轮没有进展' } } },
    onEdit: noop, onPause: noop, onResume: noop, onClear: noop,
  }))
  assert.match(blocked, /已受阻/)
  assert.match(blocked, /连续三轮没有进展/)

  const complete = renderToStaticMarkup(React.createElement(GoalBar, {
    goal: projection('done', 1, 'complete'), onEdit: noop, onPause: noop, onResume: noop, onClear: noop,
  }))
  assert.equal(complete, '')
})

test('GoalBar editor wires prefill, blank-save gate, cancel and trimmed Enter save', async () => {
  const edits: string[] = []
  const noop = async (): Promise<void> => undefined
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(React.createElement(GoalBar, {
      goal: projection('edit-ui'),
      onEdit: async (objective: string): Promise<void> => { edits.push(objective) },
      onPause: noop,
      onResume: noop,
      onClear: noop,
    }))
  })
  try {
    act(() => { renderer.root.findByProps({ 'aria-label': '编辑目标' }).props.onClick() })
    let input = renderer.root.findByProps({ 'aria-label': '目标内容' })
    assert.equal(input.props.value, 'Ship Goal bar')
    act(() => { input.props.onChange({ target: { value: '   ' } }) })
    assert.equal(renderer.root.findByProps({ 'aria-label': '保存目标' }).props.disabled, true)
    act(() => { input.props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false } }) })
    assert.throws(() => renderer.root.findByProps({ 'aria-label': '目标内容' }))

    act(() => { renderer.root.findByProps({ 'aria-label': '编辑目标' }).props.onClick() })
    input = renderer.root.findByProps({ 'aria-label': '目标内容' })
    act(() => { input.props.onChange({ target: { value: 'cancelled draft' } }) })
    act(() => { renderer.root.findByProps({ 'aria-label': '取消编辑' }).props.onClick() })
    assert.throws(() => renderer.root.findByProps({ 'aria-label': '目标内容' }))

    act(() => { renderer.root.findByProps({ 'aria-label': '编辑目标' }).props.onClick() })
    input = renderer.root.findByProps({ 'aria-label': '目标内容' })
    act(() => { input.props.onChange({ target: { value: '  New objective  ' } }) })
    await act(async () => {
      input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault: () => undefined })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(edits, ['New objective'])
    assert.throws(() => renderer.root.findByProps({ 'aria-label': '目标内容' }))
  } finally {
    await act(async () => { renderer.unmount() })
  }
})
