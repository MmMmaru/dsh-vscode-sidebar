/**
 * Playwright E2E: session delete through the hover menu + ConfirmModal
 * (TODO 10). Regression: the old flow used window.confirm, which VS Code
 * webviews do not support (it returns false), so deletion never ran.
 *
 * Flow: create a session, open its ⋯ menu, click 删除, confirm in the modal —
 * the row disappears from the list in real time (store removal + the host's
 * archived-sessions-changed push).
 *
 * Run: `npm run test:e2e` (or `npm run build:webview && node esbuild.config.mjs --e2e`
 * then `LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu npx playwright test -g "DEL-"`).
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

test('DEL-1: deleting a session from the hover menu removes the row in real time', async ({ page, harness }) => {
  // Sessions persist on the host across runs — a per-run unique title keeps
  // strict locators unambiguous. Create through workspace.create + workspaceId
  // (the plugin's real flow); a bare-cwd session is not registry-grouped and
  // workspace.archiveSession rejects it with HTTP 500.
  const title = `DEL-${Date.now().toString(36)}`
  const { workspace } = await harness.rpc<{ workspace: { workspaceId: string } }>('workspace.create', { path: harness.workspacePath })
  const { sessionId } = await harness.rpc<{ sessionId: string }>('session.create', { workspaceId: workspace.workspaceId })
  await harness.rpc('session.rename', { sessionId, title })
  await openApp(page, harness)

  // No session is active, so the recent list renders the row directly.
  const row = page.locator('.session-list > li', { hasText: title })
  await expect(row).toBeVisible()

  // The ⋯ trigger shows on row hover; the menu floats on the same line.
  await row.hover()
  await row.locator('.session-menu-trigger').click()
  const menu = page.locator('.session-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: '删除' }).click()

  // The ConfirmModal takes over (not window.confirm, which webviews lack).
  const dialog = page.getByRole('alertdialog', { name: '删除会话' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(title)
  await dialog.getByRole('button', { name: '删除', exact: true }).click()

  // The row disappears from the list once the archive RPC succeeds.
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.session-row', { hasText: title })).toHaveCount(0)
})
