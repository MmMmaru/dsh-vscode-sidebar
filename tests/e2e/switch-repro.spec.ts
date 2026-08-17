/**
 * Reproduction spec: does a pending question panel survive a session switch?
 * User report: "askuserquestion 依然失败，切换 session 回来之后依然消失".
 * Flow: question arrives in session A -> switch to B -> switch back to A.
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

const QUESTION: AskUserQuestionItem = {
  id: 'q-switch',
  question: '切换后还在吗？',
  options: [{ label: '在' }, { label: '不在' }],
}

async function openApp(page: Page, harness: Harness): Promise<void> {
  await page.goto(harness.pageUrl)
  await expect(page.locator('.chat-list')).toBeVisible()
}

async function openHistoryDropdown(page: Page): Promise<void> {
  await page.locator('.chat-list-header .icon-btn').first().click()
  await expect(page.locator('.chat-list-dropdown')).toBeVisible()
}

test('question panel survives switching away and back', async ({ page, harness }) => {
  const a = await harness.createSession(harness.workspacePath, 'SW-A')
  await harness.createSession(harness.workspacePath, 'SW-B')

  await openApp(page, harness)
  // Select session A.
  await page.locator('.session-row', { hasText: 'SW-A' }).click()
  await expect(page.locator('.composer-input')).toBeVisible()

  // Question arrives for A.
  harness.emitMux({ type: 'question/requested', sessionId: a, questions: [QUESTION] }, 'q-switch-rpc')
  const panel = page.locator(`.ovl-card[data-question-session="${a}"]`)
  await expect(panel).toBeVisible()

  // Switch to B: panel must go away (B has no overlay).
  await openHistoryDropdown(page)
  await page.locator('.chat-list-dropdown .session-row', { hasText: 'SW-B' }).click()
  await expect(page.locator('.composer-input')).toBeVisible()
  await expect(panel).not.toBeVisible()

  // Switch back to A: the panel must REAPPEAR.
  await openHistoryDropdown(page)
  await page.locator('.chat-list-dropdown .session-row', { hasText: 'SW-A' }).click()
  await expect(page.locator(`.ovl-card[data-question-session="${a}"]`)).toBeVisible({ timeout: 5_000 })
  await expect(page.locator(`.ovl-card[data-question-session="${a}"]`)).toContainText('切换后还在吗？')

  // Cleanup: mirror the host confirmation so the retention does not leak
  // into the next test (the real host rejects the injected frame's rpcId).
  harness.emitMux({ type: 'question/resolved', sessionId: a, questionRpcId: 'q-switch-rpc' as never, outcome: 'answered' })
})

// ---------------------------------------------------------------------------
// Live variant: a REAL question (real host frame, real rpcId) must also
// survive a session switch. Skipped when the model does not ask within the
// window (natural-trigger resilience, per the agreed E2E policy).
// ---------------------------------------------------------------------------

test('real question panel survives switching away and back (live)', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000)
  const a = await harness.createSession(harness.workspacePath, 'RL-A')
  await harness.createSession(harness.workspacePath, 'RL-B')

  await openApp(page, harness)
  await page.locator('.session-row', { hasText: 'RL-A' }).click()
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  await input.fill('在你继续执行任何操作之前，请先通过 ask 工具向我提一个问题（例如问我要不要继续），然后等待我的回答。')
  await input.press('Enter')

  const panel = page.locator(`.ovl-card[data-question-session="${a}"]`)
  try {
    await expect(panel).toBeVisible({ timeout: 120_000 })
  } catch {
    testInfo.skip(true, '模型未在窗口内触发 ask（自然触发不可控），跳过真实提问切换验证')
    return
  }
  await expect(panel).toContainText(/？|吗|是否/)

  // Switch away and back; the real question must survive.
  await openHistoryDropdown(page)
  await page.locator('.chat-list-dropdown .session-row', { hasText: 'RL-B' }).click()
  await expect(page.locator('.composer-input')).toBeVisible()
  await expect(panel).not.toBeVisible()

  await openHistoryDropdown(page)
  await page.locator('.chat-list-dropdown .session-row', { hasText: 'RL-A' }).click()
  await expect(page.locator(`.ovl-card[data-question-session="${a}"]`)).toBeVisible({ timeout: 5_000 })

  // Cleanup: answer the real question so the extension-side retention is
  // cleared for later tests (an unanswered real question would be replayed
  // into the next test's init and auto-select this session).
  const hasOptions = (await page.locator('.ovl-option').count()) > 0
  if (hasOptions) {
    await page.locator('.ovl-option').first().click()
  } else {
    await page.locator('.ovl-custom-input').fill('继续')
  }
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(panel).not.toBeVisible({ timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Live variant: answer a REAL question through the real respond chain; the
// host must accept (real rpcId), send question/resolved, and the agent must
// continue. Skipped when the model does not ask.
// ---------------------------------------------------------------------------

test('answering a real question resolves it and the agent continues (live)', async ({ page, harness }, testInfo) => {
  test.setTimeout(300_000)
  const a = await harness.createSession(harness.workspacePath, 'RL-ANSWER')
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: 'RL-ANSWER' }).click()
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  await input.fill('在你继续之前，请先通过 ask 工具向我提一个问题（例如问我要不要继续），然后等待我的回答。')
  await input.press('Enter')

  const panel = page.locator(`.ovl-card[data-question-session="${a}"]`)
  try {
    await expect(panel).toBeVisible({ timeout: 120_000 })
  } catch {
    testInfo.skip(true, '模型未在窗口内触发 ask（自然触发不可控），跳过真实应答验证')
    return
  }

  // Answer through the real UI: pick the first option and submit.
  const option = page.locator('.ovl-option').first()
  const label = (await option.getAttribute('aria-label')) ?? '继续'
  await option.click()
  await page.getByRole('button', { name: 'Submit' }).click()

  // The real host accepts the answer (real rpcId) and broadcasts
  // question/resolved; the panel clears and the agent continues producing.
  // The continuation may be slow under load (full-suite runs share one host),
  // so the window is generous; if the model still stalls, skip rather than
  // fail (live-model resilience, per the agreed E2E policy).
  await expect(panel).not.toBeVisible({ timeout: 30_000 })
  try {
    await expect(page.locator('.md-body').first()).not.toBeEmpty({ timeout: 180_000 })
  } catch {
    const settled = await page.locator('.turn-stats-row').count()
    if (settled === 0) testInfo.skip(true, '模型应答后未在窗口内继续产出（慢/环境波动），跳过')
  }
})
