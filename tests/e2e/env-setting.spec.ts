/**
 * Custom host environment E2E: the REAL bridge carries `set-env` from the
 * settings UI into the stubbed VS Code configuration (dsh.env), the extension
 * echoes the cleaned map back, and saving never restarts the running host (a
 * host keeps the environment it was spawned with). No model calls involved, so
 * everything here is deterministic.
 *
 * All cases share the one worker-scoped harness (playing the VS Code window),
 * exactly like the sibling specs: tests run in order and use only relative
 * assertions.
 */

import { test as base, expect, type Page } from 'playwright/test'
import { startHarness, type Harness } from '../../.temp/e2e-dist/harness.mjs'

const test = base.extend<{}, { harness: Harness }>({
  harness: [
    async ({}, use) => {
      // Seeded BEFORE the host spawns, so the startup path (not just the UI) is
      // exercised: this is exactly what a saved dsh.env setting looks like.
      const harness = await startHarness({ config: { 'dsh.env': { SEEDED_FLAG: 'on' } } })
      try {
        await use(harness)
      } finally {
        await harness.stop()
      }
    },
    { scope: 'worker', auto: true },
  ],
})

/** Open the settings surface and select 设置 → 通用. */
async function openEnvEditor(page: Page, harness: Harness): Promise<void> {
  // The extension injects __DSH_VIEW_MODE__ into the real webview document; the
  // harness page mirrors that from its `?view=` query parameter.
  await page.goto(harness.settingsPageUrl)
  await expect(page.locator('.settings-page-body')).toBeVisible()
  await page.getByRole('button', { name: '通用' }).first().click()
  await expect(page.locator('[data-pref="env"]')).toBeVisible()
  // The editor fills from the init payload, which lands after the first paint;
  // every case below starts from the seeded row.
  await expect(page.getByTestId('env-name').first()).toHaveValue('SEEDED_FLAG')
}

test('环境变量：启动时读取配置并渲染，保存后写入 VS Code 配置且不重启 host', async ({ page, harness }) => {
  await openEnvEditor(page, harness)

  // The startup seed reaches the editor (config → spawn-time read → init → row).
  const names = page.getByTestId('env-name')
  await page.getByTestId('env-add').click()
  await names.nth(1).fill('E2E_CUSTOM_FLAG')
  await page.getByTestId('env-value').nth(1).fill('from-ui')
  await page.getByTestId('env-save').click()

  // The real bridge wrote the whole map through to the configuration plane.
  await expect
    .poll(() => harness.configuration()['dsh.env'])
    .toEqual({ SEEDED_FLAG: 'on', E2E_CUSTOM_FLAG: 'from-ui' })

  // Saving does not restart the host: the same host keeps answering RPCs.
  const sessions = await harness.rpc<{ items: unknown[] }>('session.list', {})
  expect(Array.isArray(sessions.items)).toBe(true)
})

test('环境变量：非法变量名在前端拦截，不写入配置', async ({ page, harness }) => {
  await openEnvEditor(page, harness)

  const before = harness.configuration()['dsh.env']
  await page.getByTestId('env-add').click()
  // A fresh row is a placeholder until something is typed into it.
  await expect(page.locator('.settings-env-row[data-error="true"]')).toHaveCount(0)
  await page.getByTestId('env-name').last().fill('1BAD NAME')

  // Validation is inline and immediate: the row is flagged and marked as invalid.
  const bad = page.locator('.settings-env-row[data-error="true"]')
  await expect(bad).toHaveCount(1)
  await expect(bad.locator('.settings-env-error')).toContainText('变量名需以字母或下划线开头')
  // An unusable row is not a saveable change, so Save stays disabled.
  await expect(page.getByTestId('env-save')).toBeDisabled()

  // The persisted map is untouched: the rejected row never reached the extension.
  expect(harness.configuration()['dsh.env']).toEqual(before)
})

test('环境变量：清空全部后保存，配置写入空对象', async ({ page, harness }) => {
  await openEnvEditor(page, harness)

  const remove = page.getByTestId('env-remove')
  for (let count = await remove.count(); count > 0; count = await remove.count()) {
    await remove.first().click()
  }
  await expect(page.getByTestId('env-name')).toHaveCount(0)
  await page.getByTestId('env-save').click()

  await expect.poll(() => harness.configuration()['dsh.env']).toEqual({})
})
