/**
 * Playwright E2E: overlay / menu visual unification (TODO 29).
 *
 * Asserts the shared "raised card" treatment lands on the real build:
 *   - takeover card (.ovl-card): 10px radius, layered shadow, ovl-enter animation
 *   - session hover menu (.session-menu): same 10px radius
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

  // Raise the question takeover card.
  harness.emitMux({ type: 'question/requested', sessionId, questions: [QUESTION] }, 'e2e-q-rpc-ovl')
  const card = page.locator(`.ovl-card[data-question-session="${sessionId}"]`)
  await expect(card).toBeVisible()

  // Computed style: 10px radius, two-layer shadow, ovl-enter entrance.
  await expect(card).toHaveCSS('border-radius', '10px')
  const shadow = await card.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow.split(',').length).toBeGreaterThanOrEqual(6) // two rgba() layers
  expect(shadow).toContain('8px 24px')
  expect(shadow).toContain('2px 6px')
  await expect(card).toHaveCSS('animation-name', 'ovl-enter')

  // Answer through the UI, then mirror the host confirmation to clear retention.
  await page.getByRole('radio', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(card).not.toBeVisible()
  harness.emitMux({ type: 'question/resolved', sessionId, questionRpcId: 'e2e-q-rpc-ovl' as never, outcome: 'answered' })

  // Session menu (⋯): same 10px radius. The list lives in the history
  // dropdown once a session is active; the trigger shows on row hover.
  await page.locator('.chat-list-header .icon-btn').first().click()
  const row = page.locator('.chat-list-dropdown .session-row', { hasText: title })
  await row.hover()
  await row.locator('.session-menu-trigger').click()
  const menu = page.locator('.session-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('border-radius', '10px')
  await expect(menu).toHaveCSS('animation-name', 'ovl-enter')
})
