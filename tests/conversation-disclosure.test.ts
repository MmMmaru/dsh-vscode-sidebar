/**
 * Disclosure-row optimization contracts (dsh ToolRow/ReasoningRow alignment):
 *   - every disclosure head (Think / tool / context / round) carries the
 *     shared leading slot whose icon cross-fades into a chevron on hover,
 *     focus, and in the open state;
 *   - the in-flight signal is the shared glare sweep on the row head — no
 *     spinner in tool rows, no breathing pulse — and it is disabled under
 *     prefers-reduced-motion;
 *   - tool rows title by variant (Bash/Read/Edit/...), unknown tools ride
 *     their wire name in the summary, and a single-file path summary is an
 *     IDE-open link that never appears on error rows;
 *   - the Think summary tracks the latest line while streaming and follows
 *     the write edge;
 *   - the generic IN/OUT card separates its sections with a full-width
 *     divider element.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { CallId } from '../src/extension/protocol/brand'
import type { ToolCallNode } from '../src/webview/types'
import { guessKind, toolSummary } from '../src/webview/components/conversation/ToolCallRow'

const convDir = 'src/webview/components/conversation'
const css = readFileSync(`${convDir}/conversation.css`, 'utf8')
const source = (name: string): string => readFileSync(`${convDir}/${name}`, 'utf8')

// --- pure row-model behavior ---

function node(partial: Partial<ToolCallNode> & { name: string }): ToolCallNode {
  return {
    kind: 'tool-call',
    id: 't1',
    seq: 1,
    time: 0,
    callId: 'c1' as CallId,
    arguments: '{}',
    status: 'done',
    ...partial,
  }
}

test('guessKind classifies tool names into card kinds', () => {
  assert.equal(guessKind('bash'), 'terminal')
  assert.equal(guessKind('run_terminal_cmd'), 'terminal')
  assert.equal(guessKind('read_file'), 'read')
  assert.equal(guessKind('edit_note'), 'diff')
  assert.equal(guessKind('grep'), 'search')
  // dsh 的 TOOL_VARIANTS 同款归位：web_search 是搜索行。
  assert.equal(guessKind('web_search'), 'search')
  assert.equal(guessKind('web_fetch'), 'web')
  assert.equal(guessKind('ask_user_question'), 'ask')
  assert.equal(guessKind('skill'), 'generic')
})

test('error rows summarize the failure first line', () => {
  const failed = node({ name: 'bash', status: 'error', resultText: 'command not found\nmore' })
  assert.equal(toolSummary(failed), 'command not found')
})

test('read result views summarize as their path', () => {
  const read = node({
    name: 'read',
    status: 'done',
    resultView: { card: 'read', path: 'src/a.ts', offset: 1, lines: [], totalLines: 0 },
  })
  assert.equal(toolSummary(read), 'src/a.ts')
})

// --- stylesheet + source contracts ---

test('every disclosure head carries the shared leading slot swap', () => {
  for (const file of ['ReasoningRow.tsx', 'ToolCallRow.tsx', 'ConversationView.tsx']) {
    const src = source(file)
    assert.ok(src.includes('disclosure-head'), `${file} marks its heads disclosure-head`)
    assert.ok(src.includes('row-leading'), `${file} renders the shared leading slot`)
  }
  for (const rule of ['.disclosure-head:hover .row-leading-idle', '.disclosure-open .row-leading-chevron']) {
    assert.ok(css.includes(rule), `css must carry ${rule}`)
  }
})

test('running state is the shared sweep, disabled under reduced motion', () => {
  assert.ok(css.includes('@keyframes dsh-row-sweep'), 'sweep keyframes exist')
  for (const sel of [
    '.reasoning-running .reasoning-header::after',
    '.tool-row-pending .tool-row-head::after',
    '.round-group-live .round-head::after',
  ]) {
    assert.ok(css.includes(sel), `css must anchor the sweep on ${sel}`)
  }
  const guard = css.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.notEqual(guard, -1, 'reduced-motion guard exists')
  assert.ok(css.slice(guard).includes('animation: none'), 'guard disables the sweep animation')
  assert.ok(!source('ToolCallRow.tsx').includes('tool-spinner'), 'tool rows keep their icon while pending (no spinner)')
})

test('sweep-anchored heads position themselves as the ::after containing block', () => {
  for (const selector of ['.reasoning-header', '.tool-row-head', '.round-head']) {
    const start = css.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `${selector} must exist`)
    const body = css.slice(start, css.indexOf('}', start))
    assert.match(body, /position:\s*relative/, `${selector} anchors its own sweep`)
    assert.match(body, /overflow:\s*hidden/, `${selector} clips the sweep band`)
  }
})

test('tool heads expose aria-expanded and variant titles', () => {
  const src = source('ToolCallRow.tsx')
  assert.ok(src.includes('aria-expanded={open}'), 'head exposes expanded state to AT')
  for (const title of ['Bash', 'Read', 'Edit', 'Search', 'Web', 'Check', '提问', 'Tool call']) {
    assert.ok(src.includes(`'${title}'`), `KIND_TITLES covers '${title}'`)
  }
  // Unknown tools keep their wire name visible in the summary slot.
  assert.ok(src.includes('${node.name} · ${summaryBody}'), 'generic tools prefix the summary with the tool name')
})

test('tool and context row icon mappings strictly align with dsh figma design', () => {
  const toolSrc = source('ToolCallRow.tsx')
  assert.ok(toolSrc.includes('<IconApi size={14} />'), 'terminal/bash uses IconApi')
  assert.ok(toolSrc.includes('<IconBrowse size={14} />'), 'read uses IconBrowse')
  assert.ok(toolSrc.includes('<IconSparkle size={14} />'), 'generic/others uses IconSparkle')
  const ctxSrc = source('ConversationView.tsx')
  assert.ok(ctxSrc.includes('<IconBrowse size={14} />'), 'context injection uses IconBrowse')
})

test('single-file summaries link to the editor, never on error rows', () => {
  const src = source('ToolCallRow.tsx')
  assert.ok(src.includes('openFileInIde'), 'path link opens through the IDE bridge')
  assert.ok(src.includes('e.stopPropagation()'), 'link click must not toggle the head')
  assert.match(src, /node\.status === 'error'\) return null/, 'error rows drop the link')
})

test('Think summary follows the streaming write edge', () => {
  const src = source('ReasoningRow.tsx')
  assert.ok(src.includes('data-follow-end'), 'streaming summary marks follow-end')
  assert.ok(src.includes('scrollLeft = el.scrollWidth - el.clientWidth'), 'summary pins its scroll to the end')
})

test('generic IN/OUT card separates sections with a full-width divider', () => {
  assert.ok(source('ToolCard.tsx').includes('tool-io-divider'), 'divider rendered between IN and OUT')
  assert.ok(css.includes('.tool-io-divider'), 'divider styled')
})
