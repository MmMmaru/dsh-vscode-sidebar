/**
 * MarkdownBlock unit tests: `path:line` references render as clickable chips
 * in BOTH the settled markdown path and the streaming plain-text fast path
 * (long turns stream for a while; the jump must be clickable before settle).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'

/**
 * The node shape these tests walk.
 *
 * `react-test-renderer` is deprecated in React 19 and ships no `findAll` typing,
 * so the tree is described structurally here. Without this the file silently fell
 * outside every tsconfig: the test include covered only .ts files, and the
 * esbuild bundle step does not typecheck, so `findAll` drift went unnoticed.
 */
interface TestNode {
  props: { className?: unknown; children?: unknown }
  findAll(predicate: (node: TestNode) => boolean): TestNode[]
}

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Render one MarkdownBlock and return the file-ref chips' text contents. */
async function chipTexts(text: string, streaming: boolean): Promise<string[]> {
  const { act, create } = await import('react-test-renderer')
  const { MarkdownBlock } = await import('../src/webview/components/conversation/MarkdownBlock')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(createElement(MarkdownBlock, { text, streaming }))
  })
  const root = renderer?.root as unknown as TestNode | undefined
  assert.ok(root !== undefined)
  const chips = root.findAll(
    (node: TestNode) =>
      typeof node.props.className === 'string' && node.props.className.split(' ').includes('file-ref'),
  )
  /** Chip children are strings (label or path:line coordinates); flatten them. */
  const texts = chips.map((chip: TestNode) =>
    (Array.isArray(chip.props.children) ? chip.props.children : [chip.props.children])
      .filter((c: unknown) => typeof c === 'string')
      .join(''),
  )
  renderer?.unmount()
  return texts
}

/** Render one MarkdownBlock and count the file-ref chips in the tree. */
async function countChips(text: string, streaming: boolean): Promise<number> {
  return (await chipTexts(text, streaming)).length
}

test('settled markdown renders one chip per path:line reference', async () => {
  assert.equal(await countChips('改 src/a.ts:3 和 lib/b.js:10-20 就好', false), 2)
  assert.equal(await countChips('没有引用的普通文本', false), 0)
})

test('streaming plain-text fast path renders the same chips', async () => {
  assert.equal(await countChips('改 src/a.ts:3 和 lib/b.js:10-20 就好', true), 2)
  assert.equal(await countChips('没有引用的普通文本', true), 0)
})

test('settled markdown links to local files render as chips with the link label', async () => {
  assert.deepEqual(
    await chipTexts('见 [platform.py](/abs/path/platform.py#L18-L40) 与 [单列](/abs/a.ts:7)', false),
    ['platform.py', '单列'],
  )
  // Bare-path link (no line suffix) still renders a chip labelled by link text.
  assert.deepEqual(await chipTexts('入口在 [platform.py](/abs/platform.py)。', false), ['platform.py'])
})

test('external links stay external anchors, not chips', async () => {
  const { act, create } = await import('react-test-renderer')
  const { MarkdownBlock } = await import('../src/webview/components/conversation/MarkdownBlock')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(
      createElement(MarkdownBlock, { text: '见 [文档](https://example.com/x.py) 和 [锚](#L3)', streaming: false }),
    )
  })
  const root = renderer?.root
  assert.ok(root !== undefined)
  assert.equal(await countChips('见 [文档](https://example.com/x.py) 和 [锚](#L3)', false), 0)
  const anchors = root.findAllByType('a')
  assert.equal(anchors.length, 2)
  renderer?.unmount()
})

test('streaming fast path recognizes markdown link syntax as chips', async () => {
  // File link becomes a labelled chip; the plain ref and the external link
  // behave as before (chip / raw text).
  assert.deepEqual(await chipTexts('看 [platform.py](/abs/platform.py) 与 src/a.ts:3', true), [
    'platform.py',
    'src/a.ts:3',
  ])
  assert.equal(await countChips('外链 [docs](https://example.com) 不算', true), 0)
})
