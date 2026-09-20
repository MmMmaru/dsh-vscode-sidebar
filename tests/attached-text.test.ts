import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assemblePromptText,
  parseUserMessage,
  stripVscodeContext,
  wrapAttachedText,
  VSCODE_CONTEXT_PROMPT,
} from '../src/shared/attached-text'

test('stripVscodeContext removes the [DSH_VSCODE_CONTEXT] block from beginning or end', () => {
  const inputAtBeginning = `${VSCODE_CONTEXT_PROMPT}\n\nHello, can you help me?`
  assert.equal(stripVscodeContext(inputAtBeginning), 'Hello, can you help me?')

  const inputAtEnd = `Hello, can you help me?\n\n${VSCODE_CONTEXT_PROMPT}`
  assert.equal(stripVscodeContext(inputAtEnd), 'Hello, can you help me?')
})

test('wrapAttachedText formats container with name, lines and optional path', () => {
  const wrapped = wrapAttachedText('test.ts', 'line1\nline2\nline3', '/path/to/test.ts')
  assert.match(wrapped, /\[DSH_ATTACHED_TEXT name="test.ts" lines="3" path="\/path\/to\/test.ts"\]/)
  assert.match(wrapped, /line1\nline2\nline3/)
  assert.match(wrapped, /\[\/DSH_ATTACHED_TEXT\]/)
})

test('assemblePromptText never puts the VS Code guide into the first prompt (title source)', () => {
  // First prompt of a session: the host derives the title from this message,
  // so it must contain only the user's own text.
  const first = assemblePromptText('帮我看看这个 bug', false, false)
  assert.equal(first, '帮我看看这个 bug')
  assert.doesNotMatch(first, /DSH_VSCODE_CONTEXT/, 'first prompt must not carry the context guide')
})

test('assemblePromptText attaches the VS Code guide only to later prompts', () => {
  const later = assemblePromptText('再看看第二个问题', true, false)
  assert.ok(later.startsWith('再看看第二个问题'), 'user text stays first')
  assert.match(later, /DSH_VSCODE_CONTEXT/, 'later prompts still carry the absolute-path guidance')
  assert.ok(later.includes(VSCODE_CONTEXT_PROMPT))
})

test('assemblePromptText never decorates slash commands', () => {
  const slash = assemblePromptText('/goal 做一个目标', true, true)
  assert.equal(slash, '/goal 做一个目标')
  assert.doesNotMatch(slash, /DSH_VSCODE_CONTEXT/)
})

test('parseUserMessage extracts attached text blocks and returns clean prompt', () => {
  const attached = wrapAttachedText('foo.ts', 'const x = 1\nconst y = 2', '/src/foo.ts')
  const prompt = `${VSCODE_CONTEXT_PROMPT}\n\n${attached}\n\nPlease check this code.`
  const parsed = parseUserMessage(prompt)
  assert.equal(parsed.cleanText, 'Please check this code.')
  assert.equal(parsed.attachedTexts.length, 1)
  const first = parsed.attachedTexts[0]
  assert.ok(first)
  assert.equal(first.name, 'foo.ts')
  assert.equal(first.lines, 2)
  assert.equal(first.path, '/src/foo.ts')
  assert.equal(first.content, 'const x = 1\nconst y = 2')
})

test('parseUserMessage extracts attached text blocks when prompt has prompt text first', () => {
  const attached = wrapAttachedText('foo.ts', 'const x = 1\nconst y = 2', '/src/foo.ts')
  const prompt = `Please check this code.\n\n${attached}\n\n${VSCODE_CONTEXT_PROMPT}`
  const parsed = parseUserMessage(prompt)
  assert.equal(parsed.cleanText, 'Please check this code.')
  assert.equal(parsed.attachedTexts.length, 1)
  const first = parsed.attachedTexts[0]
  assert.ok(first)
  assert.equal(first.name, 'foo.ts')
})

test('isLongText detects multi-line or long character content', () => {
  const { isLongText } = require('../src/shared/attached-text')
  assert.equal(isLongText('short text'), false)
  assert.equal(isLongText('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10'), true)
  assert.equal(isLongText('a'.repeat(450)), true)
})

test('isTextFile matches common document and source code extensions', () => {
  const { isTextFile } = require('../src/shared/attached-text')
  assert.equal(isTextFile({ name: 'readme.txt' }), true)
  assert.equal(isTextFile({ name: 'app.tsx' }), true)
  assert.equal(isTextFile({ name: 'main.py' }), true)
  assert.equal(isTextFile({ name: 'server.log' }), true)
  assert.equal(isTextFile({ name: 'image.png', type: 'image/png' }), false)
  assert.equal(isTextFile({ name: 'unknown.bin' }), false)
})
