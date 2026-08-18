/**
 * Playwright E2E: code jump (TODO 5) + segment rail (TODO 19).
 *
 * ① Code jump: a settled assistant message containing `path:line` refs
 *    renders clickable chips; clicking routes an `ide-open-file` bridge
 *    message to the REAL extension host, which resolves the path
 *    (session cwd → workspace root) and opens/reveals it through the vscode
 *    stub. Missing files surface as an error notification.
 *
 * ② Segment rail: every user message gets one tick on the right rail (a
 *    vertically centered overview cluster, not a scroll-position map);
 *    hovering shows a one-line preview (first 10 code points + …); clicking
 *    scrolls the stream to the message and unpins bottom-follow.
 *
 * Run: `npm run test:e2e` (or `npm run build:webview && node esbuild.config.mjs --e2e`
 * then `LD_LIBRARY_PATH=.temp/libs/root/usr/lib/x86_64-linux-gnu npx playwright test -g "RJ-"`).
 */

import { test as base, expect, type Page } from 'playwright/test'
import type { MessageId, SessionId } from '../../src/extension/protocol/brand'
import type { MuxFrame } from '../../src/extension/protocol/events'
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

/** Select a session row by its title text. */
async function selectSessionRow(page: Page, title: string): Promise<void> {
  await page.locator('.session-row', { hasText: title }).click()
}

/** One user message event with the given text. */
function userMessageEvent(sessionId: SessionId, seq: number, id: string, text: string): MuxFrame {
  return {
    type: 'session/event',
    sessionId,
    event: {
      type: 'user/message',
      seq,
      time: Date.now(),
      data: {
        id: id as MessageId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
    },
  }
}

/** One settled assistant text event with the given text. */
function assistantTextEvent(sessionId: SessionId, seq: number, id: string, text: string): MuxFrame {
  return {
    type: 'session/event',
    sessionId,
    event: {
      type: 'assistant/message',
      seq,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          id: id as MessageId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// ① Code jump: chips render from `path:line` refs and open real files
// ---------------------------------------------------------------------------

test('RJ-1: file refs in assistant text render as chips and open the file', async ({ page, harness }) => {
  const sessionId = await harness.createSession(harness.workspacePath, 'RJ-OPEN')
  await openApp(page, harness)
  await selectSessionRow(page, 'RJ-OPEN')
  await expect(page.locator('.composer-input')).toBeVisible()

  // A settled assistant message with two real workspace-relative refs and one
  // missing file.
  harness.emitMux(userMessageEvent(sessionId, 1, 'rj-u1', '帮我看下这两个文件'))
  harness.emitMux(
    assistantTextEvent(
      sessionId,
      2,
      'rj-a1',
      '改 src/shared/file-refs.ts:10 和 package.json:2；不存在 src/nope-xyz.ts:5。',
    ),
  )

  const chips = page.locator('.md-body .file-ref')
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(0)).toHaveText('src/shared/file-refs.ts:10')
  await expect(chips.nth(1)).toHaveText('package.json:2')

  // Click the first chip: the REAL extension host resolves session-cwd-first
  // and opens the file through the vscode stub.
  await chips.nth(0).click()
  const expected = `${harness.workspacePath}/src/shared/file-refs.ts`
  await expect.poll(() => harness.openedFiles()).toContain(expected)
  const reveal = harness.lastReveal()
  expect(reveal).not.toBeNull()
  expect(reveal?.range.start.line).toBe(9) // 1-based 10 -> 0-based 9
  expect(reveal?.range.end.line).toBe(9)
  expect(reveal?.type).toBe(1) // TextEditorRevealType.InCenter

  // A missing file surfaces the extension's error notification.
  await chips.nth(2).click()
  await expect.poll(() => harness.errorNotifications().join('\n')).toContain('找不到文件')
})

// ---------------------------------------------------------------------------
// ② Segment rail: markers, hover preview, click-to-scroll
// ---------------------------------------------------------------------------

test('RJ-2: segment rail marks user messages with hover preview and jump', async ({ page, harness }) => {
  const sessionId = await harness.createSession(harness.workspacePath, 'RJ-RAIL')
  await openApp(page, harness)
  await selectSessionRow(page, 'RJ-RAIL')
  await expect(page.locator('.composer-input')).toBeVisible()

  // Two user messages: a SHORT first reply and a LONG second reply (so
  // jumping to the second message leaves the stream far from the bottom and
  // bottom-follow unpins).
  const shortBlock = Array.from({ length: 3 }, (_, i) => `第 ${i + 1} 段说明文字。`).join('\n\n')
  const longBlock = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段说明文字，用来撑高对话区域。`).join('\n\n')
  harness.emitMux(userMessageEvent(sessionId, 1, 'rj-r1', 'RJ-RAIL 问题一：弹窗太慢'))
  harness.emitMux(assistantTextEvent(sessionId, 2, 'rj-r2', shortBlock))
  harness.emitMux(userMessageEvent(sessionId, 3, 'rj-r3', 'RJ-RAIL 问题二：删除按钮没反应'))
  harness.emitMux(assistantTextEvent(sessionId, 4, 'rj-r4', longBlock))

  // Every user message gets one tick in the centered overview cluster.
  const marks = page.locator('.segment-rail-mark')
  await expect(marks).toHaveCount(2)

  // Hover the second tick: a one-line preview, truncated to 10 code points + ….
  await marks.nth(1).hover()
  const tip = page.locator('.segment-rail-tip')
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText('RJ-RAIL 问题…')

  // Moving the mouse away hides the tip.
  await page.locator('.segment-rail').hover({ position: { x: 4, y: 0 } })
  await expect(tip).toHaveCount(0)

  // Clicking the tick scrolls the message near the top of the region and
  // unpins bottom-follow (the 回到底部 button appears).
  const viewport = page.locator('.conversation-view')
  await marks.nth(1).click()
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  await expect(page.locator('.conv-tobottom')).toBeVisible()
  const region = await viewport.boundingBox()
  const row = await page
    .locator('.conv-node-user-message', { hasText: 'RJ-RAIL 问题二' })
    .boundingBox()
  expect(region).not.toBeNull()
  expect(row).not.toBeNull()
  expect(Math.abs(row!.y - region!.y)).toBeLessThan(60)
})
