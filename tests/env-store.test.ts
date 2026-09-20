/**
 * Store-side contract of the custom host environment (`dsh.env`): the init
 * payload populates `env`, `setEnv` writes through the bridge and adopts the
 * optimistic value, and a transport failure rolls the state back so the editor
 * never shows an environment that was not persisted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true

test('initialize adopts the host environment reported by the init payload', async () => {
  const { mockInitEnv } = await import('../src/webview/mock/bridge')
  mockInitEnv.env = { DSH_HOME: '/tmp/from-init' }
  try {
    const { useAppStore } = await import('../src/webview/store')
    useAppStore.setState({ initialized: false, env: {} })
    await useAppStore.getState().initialize()
    assert.deepEqual(useAppStore.getState().env, { DSH_HOME: '/tmp/from-init' })
  } finally {
    mockInitEnv.env = {}
  }
})

test('setEnv writes through the bridge and keeps the new value', async () => {
  const { useAppStore } = await import('../src/webview/store')
  useAppStore.setState({ env: {} })
  await useAppStore.getState().setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' })
  assert.deepEqual(useAppStore.getState().env, { HTTPS_PROXY: 'http://127.0.0.1:7890' })
})

test('setEnv reverts the optimistic write when the extension rejects it', async () => {
  const { mockEnvFailures } = await import('../src/webview/mock/bridge')
  const { useAppStore } = await import('../src/webview/store')
  useAppStore.setState({ env: { KEEP: 'me' } })
  mockEnvFailures.enabled = true
  try {
    await assert.rejects(useAppStore.getState().setEnv({ KEEP: 'me', BROKEN: 'x' }), /forced setEnv failure/)
    assert.deepEqual(useAppStore.getState().env, { KEEP: 'me' }, 'a failed save must not leave a fake persisted state')
  } finally {
    mockEnvFailures.enabled = false
  }
})
