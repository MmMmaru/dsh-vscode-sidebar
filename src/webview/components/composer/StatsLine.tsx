/**
 * StatsLine (owned by W4): the one-line muted summary under the composer
 * card — turns, input/output tokens, cache-hit rate — fed by store.stats
 * (turn count derived from the user-message nodes by the owning card).
 * Contract: ARCHITECTURE.md section 5.3 ({ stats }).
 */

import type { JSX } from 'react'
import type { TurnStats } from '../../types'

/** Compact token count: 950 -> "950", 12800 -> "12.8k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export interface StatsLineProps {
  stats: TurnStats | null
  turns: number
}

export function StatsLine({ stats, turns }: StatsLineProps): JSX.Element | null {
  if (stats === null && turns === 0) return null
  const parts: string[] = [`${turns} turns`]
  if (stats !== null) {
    parts.push(`输入 ${formatTokens(stats.inputTokens)} tok`)
    parts.push(`输出 ${formatTokens(stats.outputTokens)} tok`)
    const cacheRead = stats.cacheReadTokens ?? 0
    const totalInput = stats.inputTokens + cacheRead
    if (totalInput > 0 && cacheRead > 0) {
      parts.push(`缓存命中 ${Math.round((cacheRead / totalInput) * 100)}%`)
    }
  }
  return <div className="stats-line">{parts.join(' · ')}</div>
}
