/**
 * Playwright E2E: 0.0.9 条目4+5 —— session 行 hover 不重排 + 运行徽标旋转条加粗。
 *
 *   - HOV-1: hover 前后 session 行 boundingBox 与标题宽度完全不变（旧实现把
 *     ⋯ trigger 从 display:none 切到 inline-flex，加入 flex 布局导致标题重排），
 *     trigger 仅靠 opacity 0→1 淡入。
 *   - HOV-2: 历史按钮的运行徽标 .chat-list-running-spinner 描边为 2px
 *     （与单会话行的 .status-spin 对齐，旧值为 1.5px）。
 *
 * Run: `npm run test:e2e` (or `npm run build:webview && node esbuild.config.mjs --e2e`
 * then `LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu npx playwright test -g "HOV-"`).
 */

import { test as base, expect, type Page } from 'playwright/test'
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

/** Open the served webview page and wait for the session list to render. */
async function openApp(page: Page, harness: Harness): Promise<void> {
  await page.goto(harness.pageUrl)
  await expect(page.locator('.chat-list')).toBeVisible()
}

test('HOV-1: hovering a session row fades the trigger in without reflowing the row', async ({ page, harness }) => {
  // Sessions persist on the host across runs — a per-run unique title keeps
  // strict locators unambiguous.
  const title = `HOV-${Date.now().toString(36)}`
  await harness.createSession(harness.workspacePath, title)
  await openApp(page, harness)

  // No session is active, so the recent list renders the row directly.
  const row = page.locator('.session-list > li', { hasText: title })
  await expect(row).toBeVisible()
  const rowButton = row.locator('.session-row')
  const titleText = row.locator('.session-title')
  const trigger = row.locator('.session-menu-trigger')

  // 未 hover：trigger 常驻 DOM 但完全透明、不接收点击，且不参与 flex 布局。
  await expect(trigger).toHaveCSS('opacity', '0')
  await expect(trigger).toHaveCSS('position', 'absolute')
  await expect(trigger).toHaveCSS('pointer-events', 'none')
  const rowBoxBefore = await rowButton.boundingBox()
  const titleBoxBefore = await titleText.boundingBox()
  expect(rowBoxBefore).not.toBeNull()
  expect(titleBoxBefore).not.toBeNull()

  await row.hover()

  // hover：trigger 淡入（opacity 1、恢复 pointer-events），不再走 display 切换。
  await expect(trigger).toHaveCSS('opacity', '1')
  await expect(trigger).toHaveCSS('pointer-events', 'auto')
  await expect(trigger).toHaveCSS('transition-duration', '0.12s')

  // 关键断言：行盒与标题宽度在 hover 前后逐像素相等（无重排）。
  const rowBoxAfter = await rowButton.boundingBox()
  const titleBoxAfter = await titleText.boundingBox()
  expect(rowBoxAfter).toEqual(rowBoxBefore)
  expect(titleBoxAfter).toEqual(titleBoxBefore)

  // 时间文本（若该行渲染了）保留 display 占位，只靠 opacity 让位。
  const time = row.locator('.session-time')
  if ((await time.count()) > 0) {
    const display = await time.evaluate((el) => getComputedStyle(el).display)
    expect(display).not.toBe('none')
  }
})

test('HOV-2: the running-badge spinner ring uses a 2px stroke', async ({ page, harness }) => {
  const title = `HOV-${Date.now().toString(36)}`
  const sessionId = await harness.createSession(harness.workspacePath, title)
  await openApp(page, harness)
  await expect(page.locator('.session-list > li', { hasText: title })).toBeVisible()

  // 将该会话标记为运行中：host 通过 `$events` 的 api-session/status 广播通知
  // （args 为 [sessionId, running]），历史按钮切换为旋转环 + 计数徽标。
  harness.emitChannel({ channel: 'remote', event: 'api-session/status', args: [sessionId, true] })
  const spinner = page.locator('.chat-list-running-spinner')
  await expect(spinner).toBeVisible()

  // 与单会话行 .status-spin 的 2px 描边对齐。
  await expect(spinner).toHaveCSS('border-width', '2px')
})
