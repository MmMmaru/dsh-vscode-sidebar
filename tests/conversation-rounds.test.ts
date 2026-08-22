/**
 * Round-fold unit tests (TODO 0.0.12 R2 "一轮全部做折叠"):
 *   - groupRounds merges consecutive think/tool-call nodes into one round and
 *     breaks rounds at user messages / assistant text / markers;
 *   - a round is live while any member streams or awaits a tool result;
 *   - label/summary mirror the dsh web fold style (steps · tool calls · names).
 * Plus stylesheet contracts: the 2px separator dot is gone, disclosure rows
 * center their icon with the text, and fenced code blocks carry no filled
 * slab ("文字还是有暗条，删掉").
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { CallId } from '../src/extension/protocol/brand'
import type { ConversationNode, ReasoningNode, ToolCallNode } from '../src/webview/types'
import { groupRounds, roundLabel, roundSummary } from '../src/webview/components/conversation/rounds'

/** Minimal node factory: groupRounds only reads kind/id/streaming/status/name. */
function reasoning(id: string, streaming = false): ReasoningNode {
  return { kind: 'reasoning', id, seq: 1, time: 0, text: 't', streaming }
}

function tool(id: string, name = 'bash', status: ToolCallNode['status'] = 'done'): ToolCallNode {
  return { kind: 'tool-call', id, seq: 1, time: 0, callId: id as CallId, name, arguments: '{}', status }
}

function user(id: string): ConversationNode {
  return { kind: 'user-message', id, seq: 1, time: 0, messageId: id as never, blocks: [] }
}

function assistant(id: string): ConversationNode {
  return { kind: 'assistant-text', id, seq: 1, time: 0, text: 'a', streaming: false }
}

/** First flow item, checked. */
function first(items: ReturnType<typeof groupRounds>): ReturnType<typeof groupRounds>[number] {
  const item = items[0]
  assert.ok(item !== undefined, 'expected at least one flow item')
  return item
}

test('consecutive think/tool-call nodes merge into one round', () => {
  const items = groupRounds([user('u1'), reasoning('r1'), tool('t1'), tool('t2'), assistant('a1')])
  assert.equal(items.length, 3)
  const round = items[1]
  assert.ok(round?.kind === 'round')
  if (round?.kind !== 'round') return
  assert.equal(round.id, 'round-r1')
  assert.deepEqual(round.nodes.map((n) => n.id), ['r1', 't1', 't2'])
})

test('assistant text and markers break rounds apart', () => {
  const items = groupRounds([reasoning('r1'), assistant('a1'), reasoning('r2')])
  assert.equal(items.length, 3)
  assert.ok(items.every((i) => i.kind === 'node' || i.nodes.length === 1))
})

test('round is live while streaming or pending, settled otherwise', () => {
  const live = first(groupRounds([reasoning('r1', true), tool('t1')]))
  assert.equal(live.kind === 'round' && live.live, true)
  const pending = first(groupRounds([tool('t1', 'bash', 'pending')]))
  assert.equal(pending.kind === 'round' && pending.live, true)
  const settled = first(groupRounds([reasoning('r1'), tool('t1')]))
  assert.equal(settled.kind === 'round' && settled.live, false)
})

test('label follows composition; summary counts steps/tools and dedupes names', () => {
  assert.equal(roundLabel([reasoning('r1')]), '思考')
  assert.equal(roundLabel([tool('t1'), tool('t2')]), '工具调用')
  assert.equal(roundLabel([reasoning('r1'), tool('t1')]), '思考与工具')
  assert.equal(roundSummary([reasoning('r1'), tool('t1', 'bash'), tool('t2', 'read'), tool('t3', 'bash')]), '4 步 · 3 个工具调用 · bash, read')
  assert.equal(roundSummary([reasoning('r1')]), '1 步')
})

// --- stylesheet contracts ---

const css = readFileSync('src/webview/components/conversation/conversation.css', 'utf8')

test('separator dot rule is gone (the stray "." after row labels)', () => {
  assert.ok(!css.includes('.reasoning-sep'), '.reasoning-sep must be deleted')
  for (const file of ['ReasoningRow.tsx', 'ToolCallRow.tsx', 'ConversationView.tsx']) {
    const src = readFileSync(`src/webview/components/conversation/${file}`, 'utf8')
    assert.ok(!src.includes('reasoning-sep'), `${file} must not render the separator dot`)
  }
})

test('disclosure rows center icons with text instead of baseline', () => {
  for (const selector of ['.reasoning-header', '.tool-row-head', '.ctx-row-head', '.round-head']) {
    const start = css.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `${selector} must exist`)
    const body = css.slice(start, css.indexOf('}', start))
    assert.match(body, /align-items:\s*center/, `${selector} must align center`)
  }
})

test('fenced code block renders as one translucent gray slab', () => {
  const start = css.indexOf('.md-codeblock {')
  const body = css.slice(start, css.indexOf('}', start))
  // 用户定稿（终）：恢复整块淡灰底（背景对比而非描边）；条纹真凶是表格斑马纹。
  assert.match(body, /background:\s*color-mix\(in srgb, var\(--dsh-fg\) 6%, transparent\)/)
})

test('markdown tables carry no zebra striping (full-width alternating bands)', () => {
  // 用户确认的"整行交替色带"来源：隔行斑马纹是全样式表唯一的逐行上色。
  assert.ok(!css.includes('nth-child(even)') && !/tr:nth-child\(2n\)/.test(css), 'zebra row banding must stay deleted')
})
