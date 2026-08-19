/**
 * MarkdownBlock unit tests: `path:line` references render as clickable chips
 * in BOTH the settled markdown path and the streaming plain-text fast path
 * (long turns stream for a while; the jump must be clickable before settle).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Render one MarkdownBlock and count the file-ref chips in the tree. */
async function countChips(text: string, streaming: boolean): Promise<number> {
  const { act, create } = await import('react-test-renderer')
  const { MarkdownBlock } = await import('../src/webview/components/conversation/MarkdownBlock')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(createElement(MarkdownBlock, { text, streaming }))
  })
  const root = renderer?.root
  assert.ok(root !== undefined)
  const chips = root.findAll(
    (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('file-ref'),
  )
  renderer?.unmount()
  return chips.length
}

test('settled markdown renders one chip per path:line reference', async () => {
  assert.equal(await countChips('改 src/a.ts:3 和 lib/b.js:10-20 就好', false), 2)
  assert.equal(await countChips('没有引用的普通文本', false), 0)
})

test('streaming plain-text fast path renders the same chips', async () => {
  assert.equal(await countChips('改 src/a.ts:3 和 lib/b.js:10-20 就好', true), 2)
  assert.equal(await countChips('没有引用的普通文本', true), 0)
})
