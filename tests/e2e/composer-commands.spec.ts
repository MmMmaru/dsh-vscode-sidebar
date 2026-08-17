/**
 * Composer command-surface E2E against the REAL host:
 *   1. Slash commands: typing `/` pops the built-in host command suggestions
 *      (/goal, /compact, /plan) above the skill catalog; Escape dismisses the
 *      popup; picking inserts the token; sending a `/`-line delivers it as
 *      the user message — a host with the command registry executes it
 *      natively (never reaching the model), older hosts hand it to the model;
 *      either way the line must never vanish. Deterministic.
 *   2. Esc interrupt (live): with a real turn streaming, Escape cancels the
 *      turn (same action as the stop button). Skipped when the model does not
 *      start generating within the window (natural-trigger resilience, per
 *      the agreed E2E policy).
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

async function openApp(page: Page, harness: Harness): Promise<void> {
  await page.goto(harness.pageUrl)
  await expect(page.locator('.chat-list')).toBeVisible()
}

test('slash popup lists host commands, Escape dismisses, picking inserts, sending delivers the line', async ({ page, harness }) => {
  await harness.createSession(harness.workspacePath, 'SLASH-CMD')
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: 'SLASH-CMD' }).click()
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  // Typing "/" pops the suggestion list with the built-in commands first.
  await input.fill('/')
  const popup = page.locator('.composer-suggest')
  await expect(popup).toBeVisible()
  await expect(page.locator('.composer-suggest-label').first()).toHaveText('/goal', { timeout: 5_000 })
  const labels = await page.locator('.composer-suggest-label').allTextContents()
  expect(labels.slice(0, 3)).toEqual(['/goal', '/compact', '/plan'])

  // Escape dismisses the popup without touching the draft.
  await input.press('Escape')
  await expect(popup).not.toBeVisible()
  await expect(input).toHaveValue('/')

  // Filtering narrows to the matching command (skills whose description also
  // matches may follow); Enter picks the highlight into the draft.
  await input.fill('/go')
  await expect(popup).toBeVisible()
  await expect(page.locator('.composer-suggest-label').first()).toHaveText('/goal')
  await input.press('Enter')
  await expect(input).toHaveValue('/goal ')

  // Sending the slash line delivers it as the user message (never swallowed;
  // a host with the command registry executes it instead of the model).
  await input.fill('/goal 完成斜杠命令的 E2E 验证')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.locator('.msg-user').first()).toContainText('/goal 完成斜杠命令的 E2E 验证', { timeout: 10_000 })
})

test('Escape interrupts the running turn (live)', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000)
  await harness.createSession(harness.workspacePath, 'ESC-INT')
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: 'ESC-INT' }).click()
  const input = page.locator('.composer-input')
  await expect(input).toBeVisible()

  await input.fill('请分 5 段详细描述你作为编码助手的能力，每段不少于 50 字')
  await input.press('Enter')

  const stop = page.locator('.composer-primary[aria-label="停止生成"]')
  try {
    await expect(stop).toBeVisible({ timeout: 120_000 })
  } catch {
    testInfo.skip(true, '模型未在窗口内开始生成（自然触发不可控），跳过 Esc 打断验证')
    return
  }

  // Escape while running cancels the turn: the stop button reverts to send.
  await input.press('Escape')
  await expect(page.locator('.composer-primary[aria-label="发送"]')).toBeVisible({ timeout: 60_000 })
  await expect(stop).not.toBeVisible()
})
