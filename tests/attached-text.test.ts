import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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

test('parseUserMessage handles legacy IDE blocks without [DSH_ATTACHED_TEXT]', () => {
  const legacyPrompt = `### 选中代码（/src/bar.ts）\n\n\`\`\`ts\nfunction bar() {\n  return 42\n}\n\`\`\`\n\nHow does this work?`
  const parsed = parseUserMessage(legacyPrompt)
  assert.equal(parsed.cleanText, 'How does this work?')
  assert.equal(parsed.attachedTexts.length, 1)
  const first = parsed.attachedTexts[0]
  assert.ok(first)
  assert.equal(first.name, 'bar.ts')
  assert.equal(first.path, '/src/bar.ts')
})
