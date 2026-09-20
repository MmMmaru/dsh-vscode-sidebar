/**
 * Environment-variable editor contract (GeneralSection): saved entries render
 * with values masked by default, invalid names are refused client-side before
 * any bridge write, and the add / save cycle persists exactly the valid rows.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Renderer left mounted by the previous case (freed before the next mount). */
let mounted: ReactTestRenderer | null = null

/**
 * Mount GeneralSection against a seeded env. The previous case's tree is
 * unmounted first: a leaked tree keeps rendering the shared store, so a failed
 * assertion would otherwise cascade into every later case.
 * @param env - the saved environment the store should report.
 * @returns the mounted renderer plus the act() helper for driving it.
 */
async function renderGeneral(env: Record<string, string>) {
  const { act, create } = await import('react-test-renderer')
  const { useAppStore } = await import('../src/webview/store')
  const { GeneralSection } = await import('../src/webview/components/settings/GeneralSection')
  if (mounted !== null) {
    mounted.unmount()
    mounted = null
  }
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    useAppStore.setState({ env })
    renderer = create(createElement(GeneralSection))
  })
  assert.ok(renderer !== undefined)
  mounted = renderer
  return { renderer, act }
}

/** Fire a text-input change with a synthetic React event. */
async function type(act: (cb: () => void | Promise<void>) => Promise<void>, input: ReactTestInstance, value: string): Promise<void> {
  await act(async () => {
    input.props.onChange({ target: { value } })
  })
}

/**
 * The env editor rows, located by their test hook (GeneralSection also renders
 * the port row, so positional/class selectors would be ambiguous).
 */
function envRows(renderer: ReactTestRenderer, kind: 'env-name' | 'env-value'): ReactTestInstance[] {
  return renderer.root.findAllByProps({ 'data-testid': kind })
}

/** Click one hooked button (defaults to the first match). */
async function click(
  renderer: ReactTestRenderer,
  act: (cb: () => void | Promise<void>) => Promise<void>,
  testId: string,
  index = 0,
  awaitHandler = false,
): Promise<void> {
  const buttons = renderer.root.findAllByProps({ 'data-testid': testId })
  const button = buttons[index]
  assert.ok(button !== undefined, `no ${testId} button at index ${String(index)}`)
  await act(async () => {
    if (awaitHandler) await button.props.onClick()
    else button.props.onClick()
  })
}

test('env editor lists saved variables with values masked by default', async () => {
  const { renderer } = await renderGeneral({ DSH_HOME: '/tmp/from-init', API_KEY: 'sk-secret' })
  const nameInputs = envRows(renderer, 'env-name')
  const valueInputs = envRows(renderer, 'env-value')

  assert.deepEqual(nameInputs.map((input) => input.props.value), ['DSH_HOME', 'API_KEY'])
  assert.equal(valueInputs.length, 2, 'one value input per row')
  assert.equal(valueInputs[0]?.props.type, 'text', 'a non-secret name stays visible')
  assert.equal(valueInputs[1]?.props.type, 'password', 'a KEY/TOKEN-ish name is masked out of the box')
  assert.equal(valueInputs[1]?.props.value, 'sk-secret', 'masking is display-only; the value is carried, not dropped')
})

test('env editor reveals a masked value on demand', async () => {
  const { renderer, act } = await renderGeneral({ API_KEY: 'sk-secret' })
  const reveal = (): ReactTestInstance | undefined => renderer.root.findAllByProps({ 'data-testid': 'env-reveal' })[0]
  assert.equal(reveal()?.props.title, '显示值')
  await click(renderer, act, 'env-reveal')
  assert.equal(envRows(renderer, 'env-value')[0]?.props.type, 'text', 'revealing flips the input to plain text')
  assert.equal(renderer.root.findAllByProps({ 'data-testid': 'env-reveal' })[0]?.props.title, '隐藏值')
})

test('env editor refuses an invalid variable name without writing to the bridge', async () => {
  const { renderer, act } = await renderGeneral({})
  const { useAppStore } = await import('../src/webview/store')
  await click(renderer, act, 'env-add')
  const nameInput = envRows(renderer, 'env-name')[0]
  assert.ok(nameInput !== undefined)
  await type(act, nameInput, '1BAD')
  await click(renderer, act, 'env-save', 0, true)
  assert.deepEqual(useAppStore.getState().env, {}, 'invalid rows never reach persistence')
  assert.ok(JSON.stringify(renderer.toJSON()).includes('变量名需以字母或下划线开头'))
})

test('env editor refuses a duplicate variable name', async () => {
  const { renderer, act } = await renderGeneral({ DSH_HOME: '/tmp/from-init' })
  const { useAppStore } = await import('../src/webview/store')
  await click(renderer, act, 'env-add')
  const draftName = envRows(renderer, 'env-name')[1]
  assert.ok(draftName !== undefined)
  await type(act, draftName, 'DSH_HOME')
  await click(renderer, act, 'env-save', 0, true)
  assert.deepEqual(useAppStore.getState().env, { DSH_HOME: '/tmp/from-init' })
  assert.ok(JSON.stringify(renderer.toJSON()).includes('变量名重复'))
})

test('env editor adds and saves a variable, leaving a half-typed row out', async () => {
  const { renderer, act } = await renderGeneral({ DSH_HOME: '/tmp/from-init' })
  const { useAppStore } = await import('../src/webview/store')
  await click(renderer, act, 'env-add')
  assert.equal(envRows(renderer, 'env-name').length, 2, 'the draft row appends a name input')
  assert.equal(envRows(renderer, 'env-value').length, 2, 'the draft row appends a value input')

  const draftName = envRows(renderer, 'env-name')[1]
  assert.ok(draftName !== undefined)
  await type(act, draftName, 'HTTPS_PROXY')
  await click(renderer, act, 'env-save', 0, true)
  assert.deepEqual(useAppStore.getState().env, { DSH_HOME: '/tmp/from-init' }, 'a row without a value is not persisted')

  // The draft survived the save, so only its value is left to fill in.
  const draftValue = envRows(renderer, 'env-value')[1]
  assert.ok(draftValue !== undefined)
  await type(act, draftValue, 'http://127.0.0.1:7890')
  await click(renderer, act, 'env-save', 0, true)
  assert.deepEqual(useAppStore.getState().env, {
    DSH_HOME: '/tmp/from-init',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
  })
})

test('env editor removes a saved variable', async () => {
  const { renderer, act } = await renderGeneral({ DSH_HOME: '/tmp/from-init', API_KEY: 'sk-secret' })
  const { useAppStore } = await import('../src/webview/store')
  await click(renderer, act, 'env-remove', 1)
  assert.equal(envRows(renderer, 'env-name').length, 1, 'only the remaining row renders')
  await click(renderer, act, 'env-save', 0, true)
  assert.deepEqual(useAppStore.getState().env, { DSH_HOME: '/tmp/from-init' })
})

test('env editor keeps a still-empty draft row out of the saved environment', async () => {
  const { renderer, act } = await renderGeneral({ DSH_HOME: '/tmp/from-init' })
  const { useAppStore } = await import('../src/webview/store')
  await click(renderer, act, 'env-add')
  await click(renderer, act, 'env-save', 0, true)
  assert.deepEqual(useAppStore.getState().env, { DSH_HOME: '/tmp/from-init' })
})

test('env editor treats a fresh row as an error-free placeholder', async () => {
  const { renderer, act } = await renderGeneral({ DSH_HOME: '/tmp/from-init' })
  await click(renderer, act, 'env-add')

  // A row the user has not typed into yet must not accuse them of anything, and
  // an unsaveable draft must not arm Save.
  assert.equal(envRows(renderer, 'env-value')[1]?.props.value, '', 'the draft row starts blank')
  assert.equal(renderer.root.findAllByProps({ 'data-error': true }).length, 0, 'no row is flagged yet')
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('变量值不能为空'), 'a blank draft row is not an error')
  assert.equal(renderer.root.findAllByProps({ 'data-testid': 'env-save' })[0]?.props.disabled, true, 'Save waits for a real change')
})
