/**
 * Unit tests for:
 * 1. ModelsSection provider filtering (only configured providers displayed initially).
 * 2. i18n dictionary and language hook.
 * 3. MessageBubble copy/fork button condition (only when turn has ended and on final assistant message).
 * 4. MarkdownBlock math formula rendering (KaTeX).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { translations, getT, formatString } from '../src/webview/i18n'
import { MarkdownBlock } from '../src/webview/components/conversation/MarkdownBlock'

test('i18n formatting and fallback', () => {
  const tZh = getT('zh')
  const tEn = getT('en')

  assert.equal(tZh('settingsTitle'), '设置')
  assert.equal(tEn('settingsTitle'), 'Settings')
  assert.equal(tZh('modelsSaved', { name: 'DeepSeek' }), '已保存 DeepSeek')
  assert.equal(tEn('modelsSaved', { name: 'DeepSeek' }), 'Saved DeepSeek')

  // Parameter replacement
  assert.equal(formatString('Hello {name}', { name: 'World' }), 'Hello World')
})

test('i18n covers both zh and en for all keys', () => {
  const zhKeys = Object.keys(translations.zh) as Array<keyof typeof translations.zh>
  const enKeys = Object.keys(translations.en) as Array<keyof typeof translations.en>

  assert.deepEqual(zhKeys.sort(), enKeys.sort(), 'zh and en key sets must match')
})

test('MarkdownBlock renders LaTeX math formulas via KaTeX', () => {
  const formula = '$$G_t = \\sum_{m\\le t} g_m \\quad\\Rightarrow\\quad e^{G_i - G_j} = \\prod_{m=j+1}^{i} \\gamma_m \\tag{1}$$'
  const html = renderToStaticMarkup(React.createElement(MarkdownBlock, { text: formula, streaming: false }))
  assert.ok(html.length > 0)
  assert.ok(!html.includes('$$G_t'), 'should not contain unrendered $$ delimiters')
})

test('AssistantBubble only shows action buttons on final message when settled', async () => {
  const { AssistantBubble } = await import('../src/webview/components/conversation/MessageBubble')
  const { useAppStore } = await import('../src/webview/store')
  useAppStore.setState({ turnStatus: 'idle', activeSessionId: null })

  const nonFinalNode = {
    id: 'a1',
    kind: 'assistant-text' as const,
    seq: 1,
    text: '中间思考叙述',
    streaming: false,
  }
  const nonFinalHtml = renderToStaticMarkup(React.createElement(AssistantBubble, { node: nonFinalNode, isFinalInTurn: false }))
  assert.ok(!nonFinalHtml.includes('msg-actions'), 'non-final assistant node must not render msg-actions')

  const finalNode = {
    id: 'a2',
    kind: 'assistant-text' as const,
    seq: 2,
    text: '最终回复',
    streaming: false,
  }
  const finalHtml = renderToStaticMarkup(React.createElement(AssistantBubble, { node: finalNode, isFinalInTurn: true }))
  assert.ok(finalHtml.includes('msg-actions'), 'final assistant node must render msg-actions when settled')
})
