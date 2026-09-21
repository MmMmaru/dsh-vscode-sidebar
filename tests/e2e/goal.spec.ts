/**
 * Goal-bar E2E: the REAL host goal domain (goals/create|pause|resume|edit|
 * clear mutate the agent and broadcast the 'goal' session projection), the
 * page renders the GoalBar from the follow snapshot's projections and updates
 * it from the live projection frames. No model calls involved — deterministic
 * apart from the live host.
 */

import { test as base, expect, type Page } from 'playwright/test'
import type { GoalId, SessionId } from '../../src/extension/protocol/brand'
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

/** Create a session with a real goal, then open the app on it. */
async function sessionWithGoal(harness: Harness, title: string, objective: string): Promise<SessionId> {
  const sessionId = await harness.createSession(harness.workspacePath, title)
  // The goal domain takes the owning agent as a required lookup parameter and
  // the objective under `request` (the retired `goal.create` took them flat).
  const { ref } = await harness.rpc<{ ref: { id: GoalId; revision: number } }>('goals/create', {
    agentId: sessionId,
    request: { objective, maxGoalRounds: 3 },
  })
  void ref
  return sessionId
}

test('goal bar renders from the baseline and pause/resume flip state via real RPC', async ({ page, harness }) => {
  await sessionWithGoal(harness, 'GOAL-STATE', '完成 Goal 条状态流转')
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: 'GOAL-STATE' }).click()

  // The `session/follow` opening snapshot's projections carry the goal value.
  const bar = page.locator('[data-goal-bar]')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('进行中')
  await expect(bar).toContainText('完成 Goal 条状态流转')

  // Pause: real goals/pause RPC -> host broadcasts the 'goal' projection.
  await page.getByRole('button', { name: '暂停目标' }).click()
  await expect(bar).toContainText('已暂停')

  // Resume flips it back.
  await page.getByRole('button', { name: '恢复目标' }).click()
  await expect(bar).toContainText('进行中')
})

test('goal edit updates the objective and clear hides the bar', async ({ page, harness }) => {
  await sessionWithGoal(harness, 'GOAL-EDIT', '旧的描述')
  await openApp(page, harness)
  await page.locator('.session-row', { hasText: 'GOAL-EDIT' }).click()

  const bar = page.locator('[data-goal-bar]')
  await expect(bar).toContainText('旧的描述')

  // Inline edit -> real goals/edit RPC -> projection frame carries the new text.
  await page.getByRole('button', { name: '编辑目标' }).click()
  const input = page.getByRole('textbox', { name: '目标内容' })
  await expect(input).toHaveValue('旧的描述')
  await input.fill('新的目标描述')
  await page.getByRole('button', { name: '保存目标' }).click()
  await expect(bar).toContainText('新的目标描述')

  // Clear: real goals/clear RPC -> projection tombstone -> bar disappears.
  await page.getByRole('button', { name: '清除目标' }).click()
  await expect(page.locator('[data-goal-bar]')).toHaveCount(0)
})
