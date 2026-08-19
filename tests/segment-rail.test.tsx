/**
 * SegmentRail unit tests (TODO 19 rework): N user messages render N ticks in
 * a vertically centered cluster; previewText truncates to 10 code points
 * (emoji-safe). Tick visuals (10px × 2px dash, 22px rail) live in
 * conversation.css; here we assert each tick renders one .segment-rail-dash.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import type { MessageId } from '../src/extension/protocol/brand'
import type { UserMessageNode } from '../src/webview/types'

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Dynamic import wrapper (see the flag note above). */
async function loadRail(): Promise<typeof import('../src/webview/components/conversation/SegmentRail')> {
  return import('../src/webview/components/conversation/SegmentRail')
}

function userNode(id: string, text: string): UserMessageNode {
  return {
    kind: 'user-message',
    id,
    seq: 1,
    time: 1,
    messageId: id as MessageId,
    blocks: [{ type: 'text', text }],
  }
}

// ---------------------------------------------------------------------------
// previewText
// ---------------------------------------------------------------------------

test('previewText keeps text of 10 code points or fewer unchanged', async () => {
  const { previewText } = await loadRail()
  assert.equal(previewText('短消息'), '短消息')
  assert.equal(previewText('1234567890'), '1234567890')
})

test('previewText truncates beyond 10 code points with an ellipsis', async () => {
  const { previewText } = await loadRail()
  assert.equal(previewText('12345678901'), '1234567890…')
  assert.equal(previewText('这是一条比较长的用户消息内容'), '这是一条比较长的用户…')
})

test('previewText counts emoji as single code points (no broken surrogates)', async () => {
  const { previewText } = await loadRail()
  const emojis = '👍🎉🚀😀🔥✨🎈🎯🎸🏀⚽🏓' // 12 code points, 24 UTF-16 units
  const preview = previewText(emojis)
  // 10 emoji + the ellipsis; a UTF-16-unit slice would have split a pair.
  assert.equal(preview, `${'👍🎉🚀😀🔥✨🎈🎯🎸🏀'}…`)
  assert.equal(Array.from(preview).length, 11)
})

// ---------------------------------------------------------------------------
// Tick rendering (react-test-renderer: SSR reads the store's initial snapshot)
// ---------------------------------------------------------------------------

/** Render the rail against the given store nodes; returns mark/dash count + cluster height. */
async function renderRail(nodes: UserMessageNode[]): Promise<{ marks: number; dashes: number; clusterHeight: number | undefined }> {
  const { act, create } = await import('react-test-renderer')
  const { useAppStore } = await import('../src/webview/store')
  const { SegmentRail } = await loadRail()
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    useAppStore.setState({ nodes })
    renderer = create(createElement(SegmentRail, { scrollRef: { current: null }, onJumpTo: () => undefined }))
  })
  const root = renderer?.root
  assert.ok(root !== undefined)
  const marks = root.findAllByProps({ className: 'segment-rail-mark' })
  const dashes = root.findAllByProps({ className: 'segment-rail-dash' })
  const clusters = root.findAllByProps({ className: 'segment-rail-cluster' })
  const style = clusters[0]?.props.style as { height?: number } | undefined
  renderer?.unmount()
  return { marks: marks.length, dashes: dashes.length, clusterHeight: style?.height }
}

test('N user messages render N ticks; other node kinds are ignored', async () => {
  const { marks, dashes, clusterHeight } = await renderRail([
    userNode('e1', '第一条消息'),
    { kind: 'assistant-text', id: 'e2', seq: 2, time: 2, text: '回复', streaming: false } as unknown as UserMessageNode,
    userNode('e3', '第二条消息'),
    userNode('e4', '第三条消息'),
  ])
  assert.equal(marks, 3)
  // 每个 tick 内渲染一条 dash（视觉尺寸 10px × 2px 由 conversation.css 控制）。
  assert.equal(dashes, 3)
  // Cluster height: 3 ticks * 10px (numeric style, React renders as px).
  assert.equal(clusterHeight, 30)
})

test('the cluster caps at 120px for large conversations', async () => {
  const { marks, clusterHeight } = await renderRail(
    Array.from({ length: 20 }, (_, i) => userNode(`e${i}`, `消息 ${i}`)),
  )
  assert.equal(marks, 20)
  assert.equal(clusterHeight, 120)
})

test('no user messages render an empty rail', async () => {
  const { marks, clusterHeight } = await renderRail([])
  assert.equal(marks, 0)
  assert.equal(clusterHeight, undefined)
})
