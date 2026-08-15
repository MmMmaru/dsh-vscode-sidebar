/**
 * SubagentDock: the strip above the composer card listing the active
 * session's subagents and background jobs. Continuable running subagents
 * offer a stop button (subagent.interrupt); the receipt only means admitted,
 * so the row is locally marked "停止中" until the refreshed catalog reports
 * activity 'inactive'. One-shot subagents and background jobs are read-only:
 * the protocol has no client-side stop for them (jobs are model-controlled
 * via job_kill). The whole strip renders nothing when both lists are empty.
 */

import { useEffect, useState, type JSX } from 'react'
import type { SessionId } from '../../../extension/protocol/brand'
import type { SubagentListEntry } from '../../../extension/protocol/subagents'
import { useAppStore } from '../../store'
import { formatDuration } from './StatsLine'

/** Narrow a catalog row to a healthy child entry. */
type ChildEntry = Extract<SubagentListEntry, { kind: 'child' }>
function isChild(entry: SubagentListEntry): entry is ChildEntry {
  return entry.kind === 'child'
}

export function SubagentDock(): JSX.Element | null {
  const subagents = useAppStore((s) => s.activeSubagents)
  const jobs = useAppStore((s) => s.activeJobs)
  const stopSubagent = useAppStore((s) => s.stopSubagent)
  const [stopping, setStopping] = useState<ReadonlySet<SessionId>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  const rows = subagents.filter(isChild)
  const liveJobs = jobs.filter((j) => j.status === 'running' || j.status === 'stopping')

  // Tick once a second while live jobs exist so their durations stay fresh.
  useEffect(() => {
    if (liveJobs.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [liveJobs.length])

  if (rows.length === 0 && liveJobs.length === 0) return null

  const stop = (id: SessionId): void => {
    setStopping((cur) => new Set(cur).add(id))
    void stopSubagent(id).catch(() => {
      // Failed interrupt: unmark so the stop button becomes usable again.
      setStopping((cur) => {
        const next = new Set(cur)
        next.delete(id)
        return next
      })
    })
  }

  return (
    <div className="subagent-dock" data-subagent-dock="">
      <ul className="subagent-list">
        {rows.map((row) => {
          const isStopping = stopping.has(row.id)
          const running = row.activity === 'running'
          const label = row.mode === 'continuable' ? row.label : (row.label ?? row.id)
          return (
            <li key={row.id} className="subagent-row">
              <span
                className={`subagent-dot ${isStopping ? 'stopping' : running ? 'running' : 'inactive'}`}
                aria-hidden
              />
              <span className="subagent-label" title={label}>{label}</span>
              <span className="subagent-status">
                {isStopping ? '停止中' : running ? '运行中' : '已结束'}
              </span>
              {row.mode === 'continuable' && running && (
                <button
                  type="button"
                  className="subagent-action"
                  disabled={isStopping}
                  onClick={() => stop(row.id)}
                >
                  停止
                </button>
              )}
            </li>
          )
        })}
        {liveJobs.map((job) => (
          <li
            key={job.id}
            className="subagent-row"
            title="后台任务由模型侧 job_kill 控制，协议暂不支持手动停止"
          >
            <span className={`subagent-dot ${job.status === 'stopping' ? 'stopping' : 'running'}`} aria-hidden />
            <span className="subagent-label">{job.label}</span>
            <span className="subagent-status">
              {job.status === 'stopping' ? '停止中' : formatDuration(Math.max(0, now - job.startedAt))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
