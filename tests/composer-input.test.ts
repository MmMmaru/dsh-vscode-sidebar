/**
 * Regression tests for the composer-input TODO items:
 *   1. Slash commands: `/` suggestions surface the built-in host commands
 *      (/goal, /compact, /plan) alongside the session's skill catalog.
 *   2. Esc interrupt: Escape dismisses the suggestion popup first, then
 *      cancels the running turn (same action as the stop button).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SkillEntry } from '../src/extension/protocol/views'
import {
  BUILTIN_COMMANDS,
  applySuggestion,
  detectSuggestion,
  filterCommands,
  filterSkills,
  resolveEscape,
} from '../src/webview/components/composer/ComposerInput'

;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true

const SKILLS: readonly SkillEntry[] = [
  { name: 'review', description: '代码审查', modelInvocable: true },
  { name: 'test', description: '运行测试', modelInvocable: true },
]

// ---------------------------------------------------------------------------
// ① Slash command suggestions
// ---------------------------------------------------------------------------

test('BUILTIN_COMMANDS lists the host slash commands in prompt order', () => {
  assert.deepEqual(BUILTIN_COMMANDS.map((c) => c.name), ['goal', 'compact', 'plan'])
  const goal = BUILTIN_COMMANDS[0]
  assert.ok(goal !== undefined && goal.description.includes('目标'))
  const compact = BUILTIN_COMMANDS[1]
  assert.ok(compact !== undefined && compact.description.includes('压缩'))
  const plan = BUILTIN_COMMANDS[2]
  assert.ok(plan !== undefined && plan.description.includes('计划'))
})

test('filterCommands matches by name or description, case-insensitively', () => {
  assert.equal(filterCommands(BUILTIN_COMMANDS, '').length, 3)
  assert.deepEqual(filterCommands(BUILTIN_COMMANDS, 'go').map((c) => c.name), ['goal'])
  assert.deepEqual(filterCommands(BUILTIN_COMMANDS, 'COMPACT').map((c) => c.name), ['compact'])
  assert.deepEqual(filterCommands(BUILTIN_COMMANDS, '模式').map((c) => c.name), ['plan'])
  assert.deepEqual(filterCommands(BUILTIN_COMMANDS, 'zzz'), [])
})

test('skill filtering keeps working next to the command catalog', () => {
  assert.deepEqual(filterSkills(SKILLS, 'rev').map((s) => s.name), ['review'])
  assert.deepEqual(filterSkills(SKILLS, '测试').map((s) => s.name), ['test'])
})

test('detectSuggestion treats a leading slash as a command token', () => {
  assert.deepEqual(detectSuggestion('/', 1), { kind: 'command', start: 0, query: '' })
  assert.deepEqual(detectSuggestion('/goal', 5), { kind: 'command', start: 0, query: 'goal' })
  assert.equal(detectSuggestion('/goal 帮我看看', 7), null, 'caret past the token closes the popup')
  assert.equal(detectSuggestion('a/b', 3), null, 'slash mid-word is not a trigger')
  assert.deepEqual(detectSuggestion('看下 @src', 7), { kind: 'mention', start: 3, query: 'src' })
})

test('applySuggestion inserts a picked command as a slash token', () => {
  const next = applySuggestion('/go', 3, { kind: 'command', start: 0, query: 'go' }, 'goal')
  assert.equal(next.value, '/goal ')
  assert.equal(next.caret, 6)
  const mention = applySuggestion('看下 @', 4, { kind: 'mention', start: 3, query: '' }, 'package.json')
  assert.equal(mention.value, '看下 @package.json ')
})

// ---------------------------------------------------------------------------
// ② Esc interrupt
// ---------------------------------------------------------------------------

test('resolveEscape: popup owns Escape first, then a running turn, else ignore', () => {
  assert.equal(resolveEscape(true, false), 'close-popup')
  assert.equal(resolveEscape(true, true), 'close-popup')
  assert.equal(resolveEscape(false, true), 'cancel')
  assert.equal(resolveEscape(false, false), 'ignore')
})
