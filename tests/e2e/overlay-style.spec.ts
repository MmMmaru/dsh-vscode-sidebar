/**
 * Playwright E2E: overlay / menu visual unification (TODO 29).
 *
 * Asserts the shared "raised card" treatment lands on the real build:
 *   - takeover card (.ovl-card): 16px radius (tokens --dsh-radius-lg), layered
 *     shadow, ovl-enter animation
 *   - session hover menu (.session-menu): the same radius token
 *
 * Run: `npm run test:e2e` (or `npm run build:webview && node esbuild.config.mjs --e2e`
 * then `LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu npx playwright test -g "OVL-"`).
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

/** One question used to raise the takeover card. */
const QUESTION: AskUserQuestionItem = {
  id: 'q-ovl',
  question: '继续吗？',
  options: [{ label: '继续' }, { label: '停止' }],
}

/** Open the served webview page and wait for the session list to render. */
async function openApp(page: Page, harness: Harness): Promise<void> {
  await page.goto(harness.pageUrl)
  await expect(page.locator('.chat-list')).toBeVisible()
}

test('OVL-1: takeover card and session menu use the shared card tokens', async ({ page, harness }) => {
  // Sessions persist on the host across runs — a per-run unique title keeps
  // strict locators unambiguous.
  const title = `OVL-${Date.now().toString(36)}`
  const sessionId = await harness.createSession(harness.workspacePath, title)
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: title }).click()
  await expect(page.locator('.composer-input')).toBeVisible()

  // Raise the question takeover card: an answerable request arrives on the
  // `remote` channel as a pre-shaped overlay keyed by its reply `eventId`.
  const eventId = `ovl-q-${Date.now().toString(36)}`
  harness.emitChannel({
    channel: 'remote',
    event: 'user-questions/request',
    args: [{ kind: 'question', eventId, agentId: sessionId, questions: [QUESTION] }],
  })
  const card = page.locator(`.ovl-card[data-question-session="${sessionId}"]`)
  await expect(card).toBeVisible()

  // Computed style: 16px radius (aligned across every card by 5c02a1c), a
  // two-layer shadow, and the ovl-enter entrance.
  await expect(card).toHaveCSS('border-radius', '16px')
  const shadow = await card.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow.split(',').length).toBeGreaterThanOrEqual(6) // two rgba() layers
  expect(shadow).toContain('8px 24px')
  expect(shadow).toContain('2px 6px')
  await expect(card).toHaveCSS('animation-name', 'ovl-enter')

  // Answer through the UI, then mirror the host retraction to clear retention.
  await page.getByRole('radio', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(card).not.toBeVisible()
  harness.emitChannel({ channel: 'remote', event: 'request/cancelled', args: [eventId] })

  // Session menu (⋯): the same radius token. The list lives in the history
  // dropdown once a session is active; the trigger shows on row hover.
  await page.locator('.chat-list-header .icon-btn').first().click()
  const row = page.locator('.chat-list-dropdown .session-row', { hasText: title })
  await row.hover()
  await row.locator('.session-menu-trigger').click()
  const menu = page.locator('.session-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('border-radius', '16px')
  await expect(menu).toHaveCSS('animation-name', 'ovl-enter')
})

test('OVL-2: conversation chrome — no horizontal scroll, rail overlays scrollbar column', async ({ page, harness }) => {
  const title = `OVL2-${Date.now().toString(36)}`
  await harness.createSession(harness.workspacePath, title)
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: title }).click()
  await expect(page.locator('.composer-input')).toBeVisible()

  // 滚动区自身禁横向滚动（代码块/表格内部仍 overflow-x:auto）。
  const viewport = page.locator('.conversation-view')
  await expect(viewport).toHaveCSS('overflow-x', 'hidden')

  // SegmentRail 绝对定位覆盖在右缘滚动条列上，不占独立布局列。
  const rail = page.locator('.segment-rail')
  await expect(rail).toHaveCSS('position', 'absolute')
  await expect(rail).toHaveCSS('width', '22px')
  await expect(rail).toHaveCSS('opacity', '0.4')
})
