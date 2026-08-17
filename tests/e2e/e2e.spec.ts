/**
 * Playwright E2E suite (dsh-vscode-sidebar). Runs the real webview build in
 * Chromium against the real extension host code (Node) and a real, isolated
 * dsh host. Covers the five TODO regressions plus the core chat loop:
 *   ① IDE content insertion           (composer chip -> stub editor content)
 *   ② askuserquestion replay          (frame while page closed -> init replay)
 *   ③ cross-workspace isolation       (init filter + host/session-added guard)
 *   ④ session moves to top on send
 *   ⑤ excluded: turn-timer resume is covered by unit tests (todo-fixes)
 *   + live chat loop (real model call, structural assertions only)
 *
 * Run: `npm run test:e2e`.
 */

import { test as base, expect, type Page } from 'playwright/test'
import type { AskUserQuestionItem } from '../../src/extension/protocol/events'
import type { SessionId } from '../../src/extension/protocol/brand'
import { startHarness, type Harness } from '../../.temp/e2e-dist/harness.mjs'

const test = base.extend<{}, { harness: Harness }>({
  harness: [
    async ({}, use) => {
      const harness = await startHarness()
      try {
        await use(harness)
      } finally {
        await harness.stop()
      }
    },
    { scope: 'worker', auto: true },
  ],
})

/** One question used by the injected overlay tests. */
const QUESTION: AskUserQuestionItem = {
  id: 'q-e2e',
  question: '继续吗？',
  options: [{ label: '继续' }, { label: '停止' }],
}

/** Open the served webview page and wait for the session list to render. */
async function openApp(page: Page, harness: Harness): Promise<void> {
  await page.goto(harness.pageUrl)
  await expect(page.locator('.chat-list')).toBeVisible()
}

/** Select a session row by its title text. */
async function selectSessionRow(page: Page, title: string): Promise<void> {
  await page.locator('.session-row', { hasText: title }).click()
}

// ---------------------------------------------------------------------------
// ③ init filtering: only sessions of the current workspace are rendered
// ---------------------------------------------------------------------------

test('init renders only sessions of the current workspace', async ({ page, harness }) => {
  const wsSession = await harness.createSession(harness.workspacePath, 'T1-WS')
  void wsSession
  await harness.createSession(harness.foreignPath, 'T1-FOREIGN')

  await openApp(page, harness)

  await expect(page.locator('.session-row', { hasText: 'T1-WS' })).toBeVisible()
  await expect(page.locator('.session-row', { hasText: 'T1-FOREIGN' })).toHaveCount(0)
  await expect(page.locator('.session-row')).toHaveCount(1)
})

// ---------------------------------------------------------------------------
// ③ live frames: foreign session additions never enter the list
// ---------------------------------------------------------------------------

test('host/session-added frames from other workspaces are ignored', async ({ page, harness }) => {
  await harness.createSession(harness.workspacePath, 'T2-WS')
  await openApp(page, harness)
  // Relative count: earlier tests share the host, so compare before/after.
  const before = await page.locator('.session-row').count()

  // A session created in a foreign directory broadcasts a real
  // host/session-added frame with a foreign cwd — it must not enter the list.
  await harness.createSession(harness.foreignPath, 'T2-FOREIGN')
  await expect(page.locator('.session-row')).toHaveCount(before)

  // A session created for the current workspace enters the list.
  await harness.createSession(harness.workspacePath, 'T2-WS2')
  await expect(page.locator('.session-row', { hasText: 'T2-WS2' })).toBeVisible()
  await expect(page.locator('.session-row')).toHaveCount(before + 1)
})

// ---------------------------------------------------------------------------
// ① IDE content insertion: chip -> stub editor -> formatted draft block
// ---------------------------------------------------------------------------

test('manual IDE insert (command path) appends to the draft and toasts failures', async ({ page, harness }) => {
  await harness.createSession(harness.workspacePath, 'CMD-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'CMD-SESS')
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  // The dsh.insertSelection / dsh.insertActiveFile command path: the
  // extension reads the editor and posts ide-content; the composer appends
  // the formatted block to the draft.
  harness.emitIdeContent({ kind: 'selection', text: 'SELECTED CODE', path: '/work/src/demo.ts' })
  await expect(input).toHaveValue(/### 选中代码（\/work\/src\/demo\.ts）/)
  await expect(input).toHaveValue(/```ts/)
  await expect(input).toHaveValue(/SELECTED CODE/)

  // Failures ride the payload's error slot and toast in place.
  harness.emitIdeContent({ kind: 'selection', text: '', error: '没有活动的编辑器' })
  await expect(page.locator('.composer-toast')).toContainText('没有活动的编辑器')
})

// ---------------------------------------------------------------------------
// ②/overlay: a live question frame raises the takeover panel; answering clears it
// ---------------------------------------------------------------------------

test('question panel appears on a question/requested frame and answers clear it', async ({ page, harness }) => {
  const sessionId = await harness.createSession(harness.workspacePath, 'T4-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'T4-SESS')
  await expect(page.locator('.composer-input')).toBeVisible()

  harness.emitMux({ type: 'question/requested', sessionId, questions: [QUESTION] }, 'e2e-q-rpc-4')

  const panel = page.locator(`.ovl-card[data-question-session="${sessionId}"]`)
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('继续吗？')
  // The composer is taken over by the panel.
  await expect(page.locator('.composer-input')).not.toBeVisible()

  await page.getByRole('radio', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: 'Submit' }).click()

  await expect(panel).not.toBeVisible()
  await expect(page.locator('.composer-input')).toBeVisible()
  // The answer traversed the REAL respond chain (bridge -> dsh-client ->
  // POST /api/respond); the real host rejects the synthetic rpcId of an
  // injected frame, which surfaces as a notification on the extension host.
  expect(harness.errorNotifications().some((m) => m.includes('DSH 应答失败'))).toBe(true)
  // Mirror the host's confirmation frame — this clears the extension-side
  // retention for later tests.
  harness.emitMux({ type: 'question/resolved', sessionId, questionRpcId: 'e2e-q-rpc-4' as never, outcome: 'answered' })
})

// ---------------------------------------------------------------------------
// ② askuserquestion replay: a question while the page is closed re-appears on
// the next init (the extension host retains the frame via OverlayRetention)
// ---------------------------------------------------------------------------

test('a question that arrived while the page was closed replays on return', async ({ page, harness }) => {
  const sessionId = await harness.createSession(harness.workspacePath, 'T5-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'T5-SESS')
  await expect(page.locator('.composer-input')).toBeVisible()

  // Simulate "switched away": the sidebar webview is destroyed on hide, so
  // close the page; the bridge + retention stay alive in the extension host.
  await page.close()

  // The question arrives while no webview is attached.
  harness.emitMux({ type: 'question/requested', sessionId, questions: [QUESTION] }, 'e2e-q-rpc-5')

  // Returning: a fresh webview boots, the init payload replays the pending
  // overlay, the page auto-selects the session and raises the panel.
  const page2 = await page.context().newPage()
  await openApp(page2, harness)

  const panel = page2.locator(`.ovl-card[data-question-session="${sessionId}"]`)
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('继续吗？')

  await page2.getByRole('radio', { name: '继续', exact: true }).click()
  await page2.getByRole('button', { name: 'Submit' }).click()
  await expect(panel).not.toBeVisible()
  // Clear the extension-side retention (host confirmation mirror).
  harness.emitMux({ type: 'question/resolved', sessionId, questionRpcId: 'e2e-q-rpc-5' as never, outcome: 'answered' })
})

// ---------------------------------------------------------------------------
// ④ + live chat loop: sending from an older session moves it to the top;
// the real turn streams text and settles with the tail stats row
// ---------------------------------------------------------------------------

test('sending a prompt moves the session to the top and streams a real reply', async ({ page, harness }) => {
  test.setTimeout(300_000)
  await harness.createSession(harness.workspacePath, 'T6-OLDER')
  await harness.createSession(harness.workspacePath, 'T6-NEWER')
  await openApp(page, harness)

  // Order is newest first: T6-NEWER above T6-OLDER.
  await expect(page.locator('.session-row').first()).toContainText('T6-NEWER')

  // Select the OLDER session and send a real prompt.
  await selectSessionRow(page, 'T6-OLDER')
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()
  await input.fill('用一句话介绍你自己，然后结束。')
  await input.press('Enter')

  // ④: the session the user just sent from jumps to the top of the list
  // (check the full list through the history dropdown).
  await page.locator('.chat-list-header .icon-btn').first().click()
  await expect(page.locator('.chat-list-dropdown .session-row').first()).toContainText('T6-OLDER')
  await page.keyboard.press('Escape')

  // Live turn: user bubble, then streaming assistant markdown, then the tail
  // stats row once the turn settles. Structural assertions only.
  await expect(page.locator('.msg-user')).toHaveCount(1)
  await expect(page.locator('.md-body').first()).not.toBeEmpty({ timeout: 180_000 })
  await expect(page.locator('.turn-stats-row')).toBeVisible({ timeout: 240_000 })
})

// ---------------------------------------------------------------------------
// ① send-time IDE context injection (toggle chip): asking with a live editor
// selection attaches the selected code to the prompt (model-visible only) —
// the user bubble stays clean and a compact context-injection hint row shows
// what was attached
// ---------------------------------------------------------------------------

test('asking with an editor selection auto-injects the selected code', async ({ page, harness }) => {
  test.setTimeout(180_000)
  harness.setActiveEditor({
    document: { getText: (selection) => (selection === undefined ? 'FULL FILE' : 'function selectedFn() { return 42 }'), uri: { fsPath: '/work/src/auto.ts' } },
    selection: { isEmpty: false },
  })
  await harness.createSession(harness.workspacePath, 'AUTO-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'AUTO-SESS')
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  await input.fill('这个函数是做什么的？')
  await input.press('Enter')

  // The model receives the injected block, but the user bubble shows ONLY the
  // question; a compact hint row names what was attached.
  const bubble = page.locator('.msg-user-bubble').first()
  await expect(bubble).toContainText('这个函数是做什么的？', { timeout: 30_000 })
  await expect(bubble).not.toContainText('### 选中代码')
  await expect(bubble).not.toContainText('function selectedFn() { return 42 }')
  await expect(page.locator('.ctx-row', { hasText: 'ide：选中代码（/work/src/auto.ts）' })).toBeVisible()
})

test('asking without a selection attaches the active file path', async ({ page, harness }) => {
  test.setTimeout(180_000)
  // Active editor with an EMPTY selection: the payload carries the file path
  // (selection falls back to the whole document), and only the path is
  // attached — the full content is not duplicated into the prompt.
  harness.setActiveEditor({
    document: { getText: () => 'FULL FILE CONTENT THAT MUST NOT BE INJECTED', uri: { fsPath: '/work/src/context.ts' } },
    selection: { isEmpty: true },
  })
  await harness.createSession(harness.workspacePath, 'PATH-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'PATH-SESS')
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  await input.fill('这个文件是做什么的？')
  await input.press('Enter')

  const bubble = page.locator('.msg-user-bubble').first()
  await expect(bubble).toContainText('这个文件是做什么的？', { timeout: 30_000 })
  await expect(bubble).not.toContainText('### 当前文件')
  await expect(bubble).not.toContainText('FULL FILE CONTENT THAT MUST NOT BE INJECTED')
  await expect(page.locator('.ctx-row', { hasText: 'ide：当前文件：/work/src/context.ts' })).toBeVisible()
})

test('toggling IDE context injection off stops the injection', async ({ page, harness }) => {
  test.setTimeout(180_000)
  harness.setActiveEditor({
    document: { getText: (selection) => (selection === undefined ? 'FULL FILE' : 'function secretFn() { return 7 }'), uri: { fsPath: '/work/src/off.ts' } },
    selection: { isEmpty: false },
  })
  await harness.createSession(harness.workspacePath, 'OFF-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'OFF-SESS')
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  // The context button is a toggle: default ON, click turns it OFF.
  const toggle = page.getByRole('button', { name: '关闭 IDE 上下文注入' })
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(page.getByRole('button', { name: '开启 IDE 上下文注入' })).toBeVisible()

  await input.fill('这个函数是做什么的？')
  await input.press('Enter')

  const bubble = page.locator('.msg-user-bubble').first()
  await expect(bubble).toContainText('这个函数是做什么的？', { timeout: 30_000 })
  await expect(bubble).not.toContainText('function secretFn() { return 7 }')
  // No IDE hint row: nothing was injected (the host's own system-prompt
  // context row may still be present).
  await expect(page.locator('.ctx-row', { hasText: 'ide：' })).toHaveCount(0)
})
