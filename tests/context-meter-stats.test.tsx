/**
 * ContextMeter stats popup unit tests (0.0.9: StatsLine folded into the
 * meter): the permanent stats row under the composer is gone; clicking the
 * occupancy ring raises a popup card with the full statsLineGroups rows and
 * the contextBreakdown composition (one row per bucket), closing on outside
 * pointer-down and Escape; with no stats and no breakdown it shows
 * 「暂无统计数据」.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  SessionStatsProjection,
  TokenUsageProjection,
} from '../src/extension/protocol/projections'

// Must precede any dynamic import that reaches the store: bridge.ts picks the
// real/mock client at module scope.
;(globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ = true
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The popup's close listeners hang off `window`, and the outside-click guard
// brand-checks `e.target instanceof Node`; node has neither, so shim both.
type WindowHandler = (event: { target?: unknown; key?: string }) => void
const windowListeners = new Map<string, Set<WindowHandler>>()
;(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, fn: WindowHandler): void => {
    const set = windowListeners.get(type) ?? new Set<WindowHandler>()
    set.add(fn)
    windowListeners.set(type, set)
  },
  removeEventListener: (type: string, fn: WindowHandler): void => {
    windowListeners.get(type)?.delete(fn)
  },
}
;(globalThis as { Node?: unknown }).Node = class FakeNode {}

/** Fire the listeners the component registered on the window shim. */
function dispatchWindow(type: string, event: { target?: unknown; key?: string }): void {
  for (const fn of windowListeners.get(type) ?? []) fn(event)
}

interface MeterSeed {
  pressure: ContextPressureProjection
  breakdown: ContextBreakdownProjection | null
  stats: SessionStatsProjection | null
  usage: TokenUsageProjection | null
}

/** Render the meter against the given store slices; returns renderer + act. */
async function renderMeter(seed: MeterSeed) {
  const { act, create } = await import('react-test-renderer')
  const { useAppStore } = await import('../src/webview/store')
  const { ContextMeter } = await import('../src/webview/components/composer/ContextMeter')
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    useAppStore.setState({
      contextPressure: seed.pressure,
      contextBreakdown: seed.breakdown,
      sessionStats: seed.stats,
      tokenUsage: seed.usage,
    })
    renderer = create(createElement(ContextMeter))
  })
  assert.ok(renderer !== undefined)
  return { renderer, act }
}

/** Flatten a test-instance subtree into its text content. */
function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) {
    return textContent((node as { props: { children?: unknown } }).props.children)
  }
  return ''
}

// 5000 / 10000 → 50% ring; buckets and figures chosen so every popup row has
// a distinct, greppable text.
const PRESSURE: ContextPressureProjection = { projectedTokens: 5000, contextWindow: 10_000 }
const BREAKDOWN: ContextBreakdownProjection = { systemTokens: 1000, toolsTokens: 2000, messageTokens: 3000 }
const STATS: SessionStatsProjection = {
  turns: 2,
  steps: 3,
  llmMs: 45_000,
  toolMs: 5_000,
  ttftMs: 2_000,
  ttftSteps: 2,
  decodeMs: 10_000,
  decodeTokens: 320,
}
const USAGE: TokenUsageProjection = {
  uncachedInputTokens: 600,
  outputTokens: 320,
  cacheReadTokens: 400,
  cacheWriteTokens: 0,
}

// ---------------------------------------------------------------------------
// Popup open: ring click raises the card with stats + breakdown rows
// ---------------------------------------------------------------------------

test('the popup stays closed until the ring is clicked', async () => {
  const { renderer } = await renderMeter({ pressure: PRESSURE, breakdown: BREAKDOWN, stats: STATS, usage: USAGE })
  assert.equal(renderer.root.findAllByProps({ className: 'context-meter-pop' }).length, 0)
  renderer.unmount()
})

test('clicking the ring opens the popup with stats groups and breakdown rows', async () => {
  const { renderer, act } = await renderMeter({ pressure: PRESSURE, breakdown: BREAKDOWN, stats: STATS, usage: USAGE })
  const ring = renderer.root.findByProps({ className: 'context-meter-btn' })
  await act(async () => {
    ring.props.onClick()
  })
  const pops = renderer.root.findAllByProps({ className: 'context-meter-pop' })
  assert.equal(pops.length, 1)
  const pop = pops[0]
  assert.ok(pop !== undefined)
  const text = textContent(pop.props.children)
  // Title + one row per breakdown bucket (moved out of the title tooltip).
  assert.ok(text.includes('上下文已用 50%'), text)
  assert.ok(text.includes('系统提示') && text.includes('~1K'), text)
  assert.ok(text.includes('工具') && text.includes('~2K'), text)
  assert.ok(text.includes('对话') && text.includes('~3K'), text)
  // Full statsLineGroups rows: counts, durations/speeds, billing.
  assert.ok(text.includes('2 turns · 3 steps'), text)
  assert.ok(text.includes('LLM 45s · Tool call 5s'), text)
  assert.ok(text.includes('TTFT avg 1s · 32 tok/s'), text)
  assert.ok(text.includes('Cache hit 40%'), text)
  assert.ok(text.includes('Input 1K tok · Output 320 tok'), text)
  renderer.unmount()
})

// ---------------------------------------------------------------------------
// Popup close: outside pointer-down and Escape
// ---------------------------------------------------------------------------

test('an outside pointer-down closes the popup', async () => {
  const { renderer, act } = await renderMeter({ pressure: PRESSURE, breakdown: BREAKDOWN, stats: STATS, usage: USAGE })
  const ring = renderer.root.findByProps({ className: 'context-meter-btn' })
  await act(async () => {
    ring.props.onClick()
  })
  assert.equal(renderer.root.findAllByProps({ className: 'context-meter-pop' }).length, 1)
  await act(async () => {
    dispatchWindow('pointerdown', { target: {} })
  })
  assert.equal(renderer.root.findAllByProps({ className: 'context-meter-pop' }).length, 0)
  renderer.unmount()
})

test('Escape closes the popup', async () => {
  const { renderer, act } = await renderMeter({ pressure: PRESSURE, breakdown: BREAKDOWN, stats: STATS, usage: USAGE })
  const ring = renderer.root.findByProps({ className: 'context-meter-btn' })
  await act(async () => {
    ring.props.onClick()
  })
  assert.equal(renderer.root.findAllByProps({ className: 'context-meter-pop' }).length, 1)
  await act(async () => {
    dispatchWindow('keydown', { key: 'Escape' })
  })
  assert.equal(renderer.root.findAllByProps({ className: 'context-meter-pop' }).length, 0)
  renderer.unmount()
})

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test('no stats and no breakdown shows 暂无统计数据', async () => {
  const { renderer, act } = await renderMeter({ pressure: PRESSURE, breakdown: null, stats: null, usage: null })
  const ring = renderer.root.findByProps({ className: 'context-meter-btn' })
  await act(async () => {
    ring.props.onClick()
  })
  const pops = renderer.root.findAllByProps({ className: 'context-meter-pop' })
  assert.equal(pops.length, 1)
  const pop = pops[0]
  assert.ok(pop !== undefined)
  const text = textContent(pop.props.children)
  assert.ok(text.includes('暂无统计数据'), text)
  renderer.unmount()
})
