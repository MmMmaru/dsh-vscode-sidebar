/**
 * Bridge init-payload tests.
 *
 * REGRESSION (found on a live host, then reproduced here): the extension built
 * every list row's title from its control-stream cache and ignored the row's OWN
 * `projections.values.title` that `session/list` already carries. The control
 * stream's projection cuts are sparse (a cut exists only for sessions whose
 * projection unit is mounted — measured 10 cuts for 245 sessions), so the cache
 * was nearly empty at init time and ~119 of 121 rows rendered as 新会话.
 *
 * These tests drive the REAL Bridge against the in-process fake Typert Remote
 * host, with the control baseline deliberately empty, so a cache-only build
 * cannot pass.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../src/extension/bridge'
import { DshClient } from '../src/extension/dsh-client'
import { HostManager } from '../src/extension/host-manager'
import type { ExtensionMessage, WebviewMessage } from '../src/shared/bridge'
import type { SessionId } from '../src/extension/protocol/brand'
import { startFakeRemoteHost, type FakeRemoteHost } from './fake-remote-host'
// The extension modules run against this stub (aliased in esbuild.config.mjs).
// Its `workspace.workspaceFolders` is the session-ownership anchor the Bridge
// filters on, so the test plants it exactly like the e2e harness does.
import { workspace as stubWorkspace } from './e2e/vscode-stub'

/** A stand-in webview: records outbound messages, replays inbound ones. */
function makeWebview(): {
  webview: never
  sent: ExtensionMessage[]
  send: (message: WebviewMessage) => void
} {
  const sent: ExtensionMessage[] = []
  const listeners: ((message: WebviewMessage) => void)[] = []
  const webview = {
    postMessage: async (message: ExtensionMessage): Promise<boolean> => {
      sent.push(message)
      return true
    },
    onDidReceiveMessage: (listener: (message: WebviewMessage) => void) => {
      listeners.push(listener)
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }
    },
  }
  return {
    webview: webview as never,
    sent,
    send: (message) => {
      for (const listener of listeners) listener(message)
    },
  }
}

/** One `session/list` row carrying its own title projection. */
function listRow(sessionId: string, title: string | null, cwd: string): Record<string, unknown> {
  return {
    sessionId,
    updatedAt: 1,
    running: false,
    blank: false,
    cwd,
    projections: { asOfSeq: 1, values: { title } },
  }
}

/**
 * Start the fake host, point a HostManager at it (so `ensureHost` discovers it
 * instead of probing real ports), and attach one webview that answers `ready`.
 */
async function withBridge(
  rows: readonly Record<string, unknown>[],
  cwd: string,
  run: (sent: ExtensionMessage[], host: FakeRemoteHost) => Promise<void>,
): Promise<void> {
  const host = await startFakeRemoteHost()
  // `probe()` tries `settings/describe` FIRST; answering it keeps discovery on
  // the fake host so `ensureHost()` can never fall through to spawning a real
  // dsh process.
  host.handleValue('settings/describe', { writable: true })
  host.handleValue('session/list', { items: rows })
  // The control stream is mounted but opens with an EMPTY projection cut — the
  // measured real-world case that used to blank every title.
  host.pushDriven('session/control', [{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }])
  host.pushDriven('workspace/follow', [
    { type: 'baseline', value: { items: [{ workspaceId: 'ws-1', path: cwd, title: cwd, sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [] } },
  ])
  // Plant the workspace root BEFORE the Bridge reads it: rows whose cwd is not
  // this path are filtered out of the init payload.
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: cwd } }]

  const manager = new HostManager({ appendLine: (): void => undefined })
  manager.basePort = host.port
  const client = new DshClient()
  client.onLog = (): void => undefined
  const bridge = new Bridge(client, manager)
  const page = makeWebview()
  try {
    bridge.attach(page.webview)
    page.send({ type: 'ready' } as WebviewMessage)
    // The init reply is posted only after `session/list` comes back.
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && !page.sent.some((m) => m.type === 'init')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await run(page.sent, host)
  } finally {
    client.dispose()
    await manager.dispose()
    await host.close()
  }
}

test('init carries each row title from session/list, not only from the control cache', async () => {
  const cwd = '/mock/bridge-ws'
  const rows = [
    listRow('sess-a', '问候与交流', cwd),
    listRow('sess-b', 'Work in /x', cwd),
    listRow('sess-c', null, cwd),
  ]
  await withBridge(rows, cwd, async (sent) => {
    const init = sent.find((m) => m.type === 'init') as (ExtensionMessage & { sessions: { sessionId: string; title: string | null }[] }) | undefined
    assert.ok(init !== undefined, 'a `ready` produced an init reply')
    assert.equal(init.sessions.length, 3)
    const byId = new Map(init.sessions.map((s) => [s.sessionId, s.title]))
    assert.equal(byId.get('sess-a'), '问候与交流')
    assert.equal(byId.get('sess-b'), 'Work in /x')
    // An explicit `null` in the row stays null: it is the host saying "no title".
    assert.equal(byId.get('sess-c'), null)
  })
})

test('init keeps titles when the control generation opens with an empty cut', async () => {
  const cwd = '/mock/bridge-ws'
  const rows = [listRow('sess-a', 'kept-1', cwd), listRow('sess-b', 'kept-2', cwd)]
  await withBridge(rows, cwd, async (sent, host) => {
    const init = sent.find((m) => m.type === 'init') as (ExtensionMessage & { sessions: { title: string | null }[] }) | undefined
    assert.ok(init !== undefined)
    assert.deepEqual(init.sessions.map((s) => s.title), ['kept-1', 'kept-2'])

    // The host really did deliver an empty baseline, so these titles can only
    // have come from the list rows themselves.
    const controlOpened = host.streamOpens.some((open) => open.endpoint === 'session/control')
    assert.ok(controlOpened, 'the control stream was opened')
    const baseline = sent.find((m) => m.type === 'event' && (m as { channel?: string }).channel === 'control')
    assert.ok(baseline !== undefined, 'the empty control baseline was forwarded')
    const projections = (baseline as unknown as { frame: { value: { projections: Record<string, unknown> } } }).frame.value.projections
    assert.deepEqual(Object.keys(projections), [], 'the cut is empty')
  })
})

test('session/list rows are filtered to the workspace and keep cwd-less rows', async () => {
  const cwd = '/mock/bridge-ws'
  const rows = [
    listRow('sess-a', 'mine', cwd),
    listRow('sess-b', 'foreign', '/somewhere/else'),
    { sessionId: 'sess-c', updatedAt: 1, running: false, blank: false, projections: { asOfSeq: 1, values: { title: 'cwd-less' } } },
  ]
  await withBridge(rows, cwd, async (sent) => {
    const init = sent.find((m) => m.type === 'init') as (ExtensionMessage & { sessions: { sessionId: string; title: string | null }[] }) | undefined
    assert.ok(init !== undefined)
    const ids = init.sessions.map((s) => s.sessionId) as SessionId[]
    assert.deepEqual(ids, ['sess-a', 'sess-c'])
    assert.deepEqual(init.sessions.map((s) => s.title), ['mine', 'cwd-less'])
  })
})
