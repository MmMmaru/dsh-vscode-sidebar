/**
 * Conversation rendering performance + rail chrome assertions:
 *   - .conv-node must carry `content-visibility: auto` so off-screen nodes
 *     skip layout/paint (the long-session jank fix; the browser still keeps
 *     them in the DOM, so jump/find and the SegmentRail keep working);
 *   - `contain-intrinsic-size` with the `auto` keyword must accompany it, so
 *     skipped nodes keep their last-rendered height and the Load-older scroll
 *     restore (scrollHeight delta in ConversationView) stays stable;
 *   - .segment-rail must NOT paint a left border (vertical rule removed on
 *     user request; ticks overlay the scrollbar column directly);
 *   - NodeView must be memoized on the node reference: the store reuses node
 *     objects for unchanged rows, so streaming deltas re-render only the
 *     mutated node instead of re-parsing every settled markdown/diff row.
 *
 * These are stylesheet contracts, asserted by reading conversation.css the
 * same way status-indicator.test.tsx asserts the base.css import order.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Extract the body of one CSS rule block (selector -> declarations). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} rule must exist in conversation.css`)
  const end = css.indexOf('}', start)
  assert.notEqual(end, -1, `${selector} rule must be closed`)
  // 声明里可能带注释，先剥掉注释再断言属性。
  return css
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

const css = readFileSync('src/webview/components/conversation/conversation.css', 'utf8')

test('conv-node skips off-screen rendering via content-visibility: auto', () => {
  const body = ruleBody(css, '.conv-node')
  assert.match(body, /content-visibility:\s*auto/)
})

test('conv-node reserves intrinsic size for skipped nodes (stable scrollHeight)', () => {
  const body = ruleBody(css, '.conv-node')
  // auto 关键字：浏览器记住上次真实渲染尺寸，比固定占位更准。
  assert.match(body, /contain-intrinsic-size:\s*auto\s+\d+px/)
})

test('segment-rail has no left border (vertical rule removed)', () => {
  const body = ruleBody(css, '.segment-rail')
  assert.doesNotMatch(body, /border-left/)
})

test('NodeView is memoized so settled rows are not re-parsed per stream delta', () => {
  const src = readFileSync('src/webview/components/conversation/ConversationView.tsx', 'utf8')
  // store 对未变节点复用对象引用，memo 依引用相等跳过整行重渲染。
  assert.match(src, /export const NodeView = memo\(/)
})
