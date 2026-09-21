/**
 * Playwright E2E: session delete through the hover menu + ConfirmModal
 * (TODO 10). Regression: the old flow used window.confirm, which VS Code
 * webviews do not support (it returns false), so deletion never ran.
 *
 * Flow: create a session, open its ⋯ menu, click 删除, confirm in the modal —
 * the row disappears from the list in real time (store removal + the host's
 * archived-sessions-changed push). DEL-2 pins the menu's position: it must
 * open next to the clicked row (containing block = the row's <li>), not at
 * the top of the chat-list section.
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
  const { workspace } = await harness.rpc<{ workspace: { workspaceId: string } }>('workspace/create', {
    request: { path: harness.workspacePath },
  })
  const { sessionId } = await harness.rpc<{ sessionId: string }>('session/create', {
    request: { workspaceId: workspace.workspaceId },
  })
  await harness.rpc('session/rename', { request: { sessionId, title } })
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

test('DEL-2: the ⋯ menu opens next to the row it was clicked on', async ({ page, harness }) => {
  // 回归：.session-menu 绝对定位的包含块必须是所在 li（.session-list > li
  // position:relative）；丢了这个上下文时菜单向上落到 .chat-list section，
  // top:0 使它永远贴在面板顶部，不跟随被点击的行。
  const prefix = `POS-${Date.now().toString(36)}`
  const titles = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`]
  for (const t of titles) await harness.createSession(harness.workspacePath, t)
  await openApp(page, harness)

  // 最新建的排在列表最前：最先建的 -a 落在第三行，用它验证"非首行"跟随。
  const row = page.locator('.session-list > li', { hasText: titles[0] })
  await expect(row).toBeVisible()
  await row.hover()
  await row.locator('.session-menu-trigger').click()

  // 菜单挂在该 li 内部（作用域定位本身即断言了层级归属）。
  const menu = row.locator('.session-menu')
  await expect(menu).toBeVisible()
  // 等入场动画（ovl-enter 180ms，含 translateY）落定再量盒。
  await expect(menu).toHaveCSS('transform', 'none')

  const rowBox = await row.locator('.session-row').boundingBox()
  const menuBox = await menu.boundingBox()
  expect(rowBox).not.toBeNull()
  expect(menuBox).not.toBeNull()

  // 垂直方向：菜单顶缘贴近被点击行的顶缘。菜单现在是 JS 定位的 position:fixed
  // 浮层（不再是 li 内 top:0 的绝对定位），其自身 4px padding 使它比行顶低约 4px，
  // 因此容差取 6px。断言仍能抓住原回归——行是第三行，若菜单退回"永远贴在面板
  // 顶部"，顶缘差值会是几十像素。
  expect(Math.abs(menuBox!.y - rowBox!.y)).toBeLessThan(6)
  // 并且确实没有贴在面板顶部（原 bug 的症状）。
  const panelBox = await page.locator('.chat-list').boundingBox()
  expect(panelBox).not.toBeNull()
  expect(menuBox!.y).toBeGreaterThan(panelBox!.y)

  // 水平方向：菜单向左伸入行内，右缘对准 ⋯ trigger 左缘（right:8px + 宽 22px
  // = 距行右缘 30px）。JS 按该锚点定位的是菜单的内容盒，菜单自身 4px padding 使
  // 边框盒再向右多出 4px，故容差 6px。
  const rowRight = rowBox!.x + rowBox!.width
  const menuRight = menuBox!.x + menuBox!.width
  expect(Math.abs(menuRight - (rowRight - 30))).toBeLessThan(6)
})
