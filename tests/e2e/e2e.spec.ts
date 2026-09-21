/**
 * Playwright E2E suite (dsh-vscode-sidebar). Runs the real webview build in
 * Chromium against the real extension host code (Node) and a real, isolated
 * dsh host. Covers the five TODO regressions plus the core chat loop:
 *   ① IDE content insertion           (composer chip -> stub editor content)
 *   ② askuserquestion replay          (a LIVE question while the page is closed
 *                                      -> init replay; live/skippable, because
 *                                      only the host's own waterfall reaches the
 *                                      extension's OverlayRetention)
 *   ③ cross-workspace isolation       (init filter + api-session/added guard)
 *   ④ session moves to top on send
 *   ⑤ excluded: turn-timer resume is covered by unit tests (todo-fixes)
 *   + live chat loop (real model call, structural assertions only)
 *
 * Run: `npm run test:e2e`.
 */

import { test as base, expect, type Page } from 'playwright/test'
import type { AskUserQuestionItem } from '../../src/extension/protocol/events'
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

test('api-session/added frames from other workspaces are ignored', async ({ page, harness }) => {
  await harness.createSession(harness.workspacePath, 'T2-WS')
  await openApp(page, harness)
  // Relative count: earlier tests share the host, so compare before/after.
  const before = await page.locator('.session-row').count()

  // A session created in a foreign directory broadcasts a real
  // `api-session/added` event carrying a foreign cwd — it must not enter the
  // list (the row's cwd is checked against the workspace root).
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

  // The dsh.insertSelection / dsh.insertActiveFile command path: the extension
  // reads the editor and posts ide-content; the composer files it as an attached
  // text chip rather than inlining a `### 选中代码（…）` block into the draft.
  // (The inline block is now a LEGACY format that is only parsed back for
  // history compatibility — see shared/attached-text.ts LEGACY_IDE_BLOCK_RE.)
  harness.emitIdeContent({ kind: 'selection', text: 'SELECTED CODE', path: '/work/src/demo.ts' })
  const chip = page.locator('.composer-attached-text-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('demo.ts')
  await expect(chip).toHaveAttribute('title', '/work/src/demo.ts')
  // The draft stays clean: the content rides the attachment, not the prompt text.
  await expect(input).toHaveValue('')

  // Failures ride the payload's error slot and toast in place.
  harness.emitIdeContent({ kind: 'selection', text: '', error: '没有活动的编辑器' })
  await expect(page.locator('.composer-toast')).toContainText('没有活动的编辑器')
})

// ---------------------------------------------------------------------------
// ②/overlay: an injected question overlay raises the takeover panel; answering
// clears it and the real `$events/result` path rejects the synthetic eventId
// ---------------------------------------------------------------------------

test('question panel appears on a user-questions/request overlay and answers clear it', async ({ page, harness }) => {
  const sessionId = await harness.createSession(harness.workspacePath, 'T4-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'T4-SESS')
  await expect(page.locator('.composer-input')).toBeVisible()

  // An answerable request rides the `remote` channel as a pre-shaped overlay
  // keyed by its reply `eventId` (the retired mux `question/requested` frame
  // and its rpcId correlation are gone).
  const eventId = `e2e-q-4-${Date.now().toString(36)}`
  harness.emitChannel({
    channel: 'remote',
    event: 'user-questions/request',
    args: [{ kind: 'question', eventId, agentId: sessionId, questions: [QUESTION] }],
  })

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
  // `$events/result`); the real host rejects the synthetic eventId of an
  // injected overlay, which surfaces as a notification on the extension host.
  expect(harness.errorNotifications().some((m) => m.includes('DSH 应答失败'))).toBe(true)
  // Mirror the host's retraction — this clears the extension-side retention
  // for later tests.
  harness.emitChannel({ channel: 'remote', event: 'request/cancelled', args: [eventId] })
})

// ---------------------------------------------------------------------------
// ② askuserquestion replay: a question while the page is closed re-appears on
// the next init (the extension host retains the REQUEST via OverlayRetention).
// Driven by a real ask: an injected overlay never reaches the retention buffer.
// ---------------------------------------------------------------------------

test('a question that arrived while the page was closed replays on return (live)', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000)
  const sessionId = await harness.createSession(harness.workspacePath, 'T5-SESS')
  await openApp(page, harness)
  await selectSessionRow(page, 'T5-SESS')
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  // A REAL ask drives this check: only the host's own `$events` waterfall
  // reaches the extension's OverlayRetention, so only a real question can be
  // replayed into a freshly created webview. An overlay injected through
  // `emitChannel` is forwarded to the attached page but is never retained.
  await input.fill('在你继续执行任何操作之前，请先通过 ask 工具向我提一个问题（例如问我要不要继续），然后等待我的回答。')
  await input.press('Enter')

  const panel = page.locator(`.ovl-card[data-question-session="${sessionId}"]`)
  try {
    await expect(panel).toBeVisible({ timeout: 120_000 })
  } catch {
    testInfo.skip(true, '模型未在窗口内触发 ask（自然触发不可控），跳过回放验证')
    return
  }

  // Simulate "switched away": the sidebar webview is destroyed on hide, so
  // close the page; the bridge + retention stay alive in the extension host.
  await page.close()

  // Returning: a fresh webview boots, the init payload replays the pending
  // overlay, the page auto-selects the session and raises the panel.
  const page2 = await page.context().newPage()
  await openApp(page2, harness)
  const replayed = page2.locator(`.ovl-card[data-question-session="${sessionId}"]`)
  await expect(replayed).toBeVisible()
  await expect(replayed).toContainText(/？|吗|是否/)

  // Answer so the retention does not leak into later tests.
  if ((await page2.locator('.ovl-option').count()) > 0) {
    await page2.locator('.ovl-option').first().click()
  } else {
    await page2.locator('.ovl-custom-input').fill('继续')
  }
  await page2.getByRole('button', { name: 'Submit' }).click()
  await expect(replayed).not.toBeVisible({ timeout: 30_000 })
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
  // The injected selection surfaces as an attached-text card beside the bubble.
  // It is NOT an `ide：` ctx-row: that row came from the legacy inline block,
  // which the send path no longer emits (it now wraps `[DSH_ATTACHED_TEXT]`).
  await expect(page.locator('.msg-attached-text-card')).toHaveCount(1)
  // The card names the source and carries the full path as its tooltip.
  const name = page.locator('.msg-attached-text-name')
  await expect(name).toContainText('auto.ts')
  await expect(name).toHaveAttribute('title', '/work/src/auto.ts')
  await expect(page.locator('.ctx-row', { hasText: 'ide：' })).toHaveCount(0)
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
  await expect(page.locator('.msg-attached-text-card')).toHaveCount(1)
  const name = page.locator('.msg-attached-text-name')
  await expect(name).toContainText('context.ts')
  await expect(name).toHaveAttribute('title', '/work/src/context.ts')
  await expect(page.locator('.ctx-row', { hasText: 'ide：' })).toHaveCount(0)
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
