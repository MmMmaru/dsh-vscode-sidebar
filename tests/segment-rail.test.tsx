/**
 * SegmentRail unit tests: N user messages render N clickable ticks in a
 * vertically centered cluster; previewText truncates to 20 code points
 * (emoji-safe). The hover popup lists ALL entries as bare text rows — no
 * header bar, no leading index numbers.
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
// Tick rendering (react-test-renderer)
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
  assert.equal(dashes, 3)
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

test('popup renders bare items only (no header bar, no leading numbers)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/webview/components/conversation/SegmentRail.tsx', 'utf8')
  // 需求：导航浮层不需要标题栏，也不需要条目前缀序号。
  assert.doesNotMatch(src, /segment-rail-menu-header/)
  assert.doesNotMatch(src, /menu-idx|index \+ 1/)
})

test('menu anchor is stable (never re-anchored from the menu side)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/webview/components/conversation/SegmentRail.tsx', 'utf8')
  // 弹出 bug 回归契约：菜单自身 mouseenter 只允许取消关闭计时，不得重算锚点。
  assert.match(src, /onMouseEnter=\{cancelClose\}/)
  assert.doesNotMatch(src, /onMouseEnter=\{\(\) => openMenu\(\)\}/)
})

test('entrance animation must not override the placement transform', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync('src/webview/components/conversation/conversation.css', 'utf8')
  const block = /\.segment-rail-menu\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.ok(block !== '', '.segment-rail-menu rule missing')
  // 定位依赖静态 transform；动画若带 transform 会在播放期覆盖它，结束后面板跳位。
  assert.match(block, /transform:\s*translate\(-100%,\s*-50%\)/)
  assert.doesNotMatch(block, /ovl-enter/)
  const animName = /animation:\s*([A-Za-z-]+)/.exec(block)?.[1] ?? ''
  assert.ok(animName !== '' && animName !== 'ovl-enter', 'must use a dedicated animation name')
  const kfStart = css.indexOf(`@keyframes ${animName}`)
  assert.ok(kfStart >= 0, `@keyframes ${animName} missing`)
  // 花括号配对截取关键帧体（防止切片越界进相邻规则），必须是纯 fade（无 transform）。
  let depth = 0
  let kfEnd = kfStart
  for (let i = kfStart; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) {
        kfEnd = i
        break
      }
    }
  }
  assert.doesNotMatch(css.slice(kfStart, kfEnd + 1), /transform/)
})
