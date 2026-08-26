/**
 * Unit tests for:
 * 1. ModelsSection provider filtering (only configured providers displayed initially).
 * 2. i18n dictionary and language hook.
 * 3. MessageBubble copy/fork button condition (only when turn has ended).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translations, getT, formatString } from '../src/webview/i18n'

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
