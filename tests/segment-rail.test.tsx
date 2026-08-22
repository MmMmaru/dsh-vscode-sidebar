/**
 * SegmentRail unit tests: user messages render a solid block in the rail;
 * previewText truncates to 20 code points (emoji-safe).
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
// previewText (20 chars limit)
// ---------------------------------------------------------------------------

test('previewText keeps text of 20 code points or fewer unchanged', async () => {
  const { previewText } = await loadRail()
  assert.equal(previewText('短消息'), '短消息')
  assert.equal(previewText('12345678901234567890'), '12345678901234567890')
})

test('previewText truncates beyond 20 code points with an ellipsis', async () => {
  const { previewText } = await loadRail()
  assert.equal(previewText('123456789012345678901'), '12345678901234567890…')
  assert.equal(previewText('这是一条比较长的用户消息内容超过二十个字测试样例'), '这是一条比较长的用户消息内容超过二十个字…')
})

test('previewText counts emoji as single code points (no broken surrogates)', async () => {
  const { previewText } = await loadRail()
  const emojis = '👍🎉🚀😀🔥✨🎈🎯🎸🏀⚽🏓🌟💡💎🍎🍒🍓🍇🍉' // 20 emoji
  const longEmojis = emojis + '🍍' // 21 emoji
  const preview = previewText(longEmojis)
  assert.equal(preview, `${emojis}…`)
  assert.equal(Array.from(preview).length, 21)
})

// ---------------------------------------------------------------------------
// Block rendering (react-test-renderer)
// ---------------------------------------------------------------------------

/** Render the rail against the given store nodes; returns block count + bar count. */
async function renderRail(nodes: UserMessageNode[]): Promise<{ blocks: number; bars: number }> {
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
  const blocks = root.findAllByProps({ className: 'segment-rail-block' })
  const bars = root.findAllByProps({ className: 'segment-rail-bar' })
  renderer?.unmount()
  return { blocks: blocks.length, bars: bars.length }
}

test('N user messages render one solid overview block and bar', async () => {
  const { blocks, bars } = await renderRail([
    userNode('e1', '第一条消息'),
    { kind: 'assistant-text', id: 'e2', seq: 2, time: 2, text: '回复', streaming: false } as unknown as UserMessageNode,
    userNode('e3', '第二条消息'),
    userNode('e4', '第三条消息'),
  ])
  assert.equal(blocks, 1)
  assert.equal(bars, 1)
})

test('no user messages render an empty rail', async () => {
  const { blocks, bars } = await renderRail([])
  assert.equal(blocks, 0)
  assert.equal(bars, 0)
})
