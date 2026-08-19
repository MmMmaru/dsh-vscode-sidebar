/**
 * Unit tests for the code-jump bridge contract (src/webview/api.ts):
 * openFileInIde must post an `ide-open-file` message carrying a correlation
 * id plus the ref target, resolve once the extension host answers with an
 * `ide-open-file-result` receipt, and reject with the host's reason on
 * failure — the receipt is what makes a failed jump visible in the webview.
 *
 * The real module acquires the webview API at load time, so the test installs
 * a fake `acquireVsCodeApi` + `window` before the dynamic import.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/** One captured webview->extension message. */
interface SentMessage {
  type: string
  id?: string
  path?: string
  line?: number
  cwd?: string
}

const sent: SentMessage[] = []
let messageListener: ((event: { data: unknown }) => void) | null = null

let api: typeof import('../src/webview/api')

before(async () => {
  const globals = globalThis as Record<string, unknown>
  globals.acquireVsCodeApi = () => ({
    postMessage: (message: SentMessage) => {
      sent.push(message)
    },
  })
  globals.window = {
    addEventListener: (type: string, cb: (event: { data: unknown }) => void) => {
      if (type === 'message') messageListener = cb
    },
  }
  api = await import('../src/webview/api')
})

/** Deliver one extension->webview message through the captured listener. */
function deliver(message: Record<string, unknown>): void {
  assert.ok(messageListener !== null, 'api.ts must register a window message listener')
  messageListener({ data: message })
}

test('openFileInIde posts ide-open-file with a correlation id and the ref target', async () => {
  sent.length = 0
  const done = api.openFileInIde({ path: 'src/a.ts', line: 3, cwd: '/sess' })
  assert.equal(sent.length, 1)
  const message = sent[0]
  assert.ok(message !== undefined)
  assert.equal(message.type, 'ide-open-file')
  assert.equal(message.path, 'src/a.ts')
  assert.equal(message.line, 3)
  assert.equal(message.cwd, '/sess')
  assert.equal(typeof message.id, 'string')
  deliver({ type: 'ide-open-file-result', id: message.id, path: '/sess/src/a.ts' })
  await done
})

test('openFileInIde rejects with the extension reason on a failure receipt', async () => {
  sent.length = 0
  const done = api.openFileInIde({ path: 'src/nope.ts', line: 5 })
  const message = sent[0]
  assert.ok(message !== undefined)
  deliver({ type: 'ide-open-file-result', id: message.id, error: '找不到文件：src/nope.ts' })
  await assert.rejects(done, /找不到文件：src\/nope\.ts/)
})

test('openFileInIde ignores receipts with unknown ids', async () => {
  sent.length = 0
  const done = api.openFileInIde({ path: 'src/a.ts', line: 1 })
  const message = sent[0]
  assert.ok(message !== undefined)
  // A stray receipt must not resolve the pending jump.
  deliver({ type: 'ide-open-file-result', id: 'not-a-real-id', path: '/x' })
  deliver({ type: 'ide-open-file-result', id: message.id, path: '/sess/src/a.ts' })
  await done
})
