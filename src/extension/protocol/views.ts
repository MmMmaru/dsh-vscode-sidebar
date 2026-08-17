/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/host/apiproxy/src/api/jobs.ts       (JobView)
 *   packages/host/apiproxy/src/api/workspace.ts  (WorkspaceView)
 *   packages/host/apiproxy/src/api/skills.ts     (SkillEntry)
 * Browser-safe view types for the jobs/workspace/skills domains. GoalRef moved
 * to ./goals (the goal domain's home) and re-exported here for existing importers.
 */

import type { JobId, SessionId, WorkspaceId } from './brand'

export type { GoalRef } from './goals'

/**
 * One background job as the client sees it. The registry's live records never
 * cross the wire; a view is the subset a human list needs.
 */
export interface JobView {
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId
  /** Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …) — open vocabulary. */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail ('exit code: 3'), present once supplied. */
  detail?: string
  /** Epoch ms when the task was registered. */
  startedAt: number
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number
}

/** One workspace row: the record projection every workspace.* value carries. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  /** Display title (defaults to the path basename at create). */
  title: string
  /** Sessions accounted under this workspace, in manually owned order. */
  sessionIds: SessionId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** Skill catalog row (wire projection of the host SkillSummary). */
export interface SkillEntry {
  /** Kebab-case identifier the user references as `/name` in the composer. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** False marks a user-only skill: invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean
}
