/**
 * Goal slice: whole-value projection reads and CAS-guarded mutations. State
 * arrives ONLY from the `goal` projection — a mutation's RPC acknowledgement
 * never feeds client state; the host's committed projection frame is the single
 * source of truth. Actions read the active session and the latest projection ref
 * at call time, send the mutation, and let errors propagate to the GoalBar.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the `goal` projection now
 * arrives on the Host-wide `session/control` stream rather than a per-session
 * mux frame, so the frame handler takes a `SessionControlProjectionFrame`. The
 * mutation methods also moved namespace and now address the agent explicitly:
 * `goal.edit` → `goals/edit` with `agentId` plus a nested `request`, and the
 * unnamed `goal.clear` → `goals/clear`. `agentId` is the wire name for the
 * lookup the host calls `agent` internally.
 */

import type { StateCreator } from 'zustand'
import type { SessionId } from '../../extension/protocol/brand'
import type { SessionControlProjectionFrame } from '../../extension/protocol/follow'
import type { GoalProjection, GoalRef } from '../../extension/protocol/goals'
import type { SessionProjectionValues } from '../../extension/protocol/sessions'
import { rpc } from '../bridge'
import type { AppStore } from './index'

/** State + actions owned by the goal workflow. */
export interface GoalSlice {
  /** undefined = capability absent/loading, null = cleared tombstone, else the whole value. */
  goal: GoalProjection | null | undefined
  /** Install the history-tail goal projection for the active session only. */
  applyGoalHistory: (sessionId: SessionId, values?: SessionProjectionValues) => void
  /** Install a live whole-value goal projection for the active session only. */
  applyGoalProjection: (frame: SessionControlProjectionFrame) => void
  /** Clear local goal state while a new session is loading. */
  resetGoal: () => void
  editGoal: (objective: string) => Promise<void>
  pauseGoal: () => Promise<void>
  resumeGoal: () => Promise<void>
  clearGoal: () => Promise<void>
}

/** Read the active session's goal CAS ref, failing loud when there is no goal. */
function goalRef(state: { activeSessionId: SessionId | null; goal: GoalProjection | null | undefined }): {
  agentId: SessionId
  ref: GoalRef
} {
  if (state.activeSessionId === null || state.goal === null || state.goal === undefined) {
    throw new Error('当前会话没有可操作的目标')
  }
  return {
    agentId: state.activeSessionId,
    ref: { id: state.goal.goal.id, revision: state.goal.goal.revision },
  }
}

export const createGoalSlice: StateCreator<AppStore, [], [], GoalSlice> = (set, get) => ({
  goal: undefined,

  applyGoalHistory: (sessionId, values) => {
    if (get().activeSessionId !== sessionId) return
    set({ goal: values?.goal })
  },

  applyGoalProjection: (frame) => {
    if (frame.sessionId !== get().activeSessionId || frame.key !== 'goal') return
    // `null` is the durable clear tombstone; anything else is the whole value.
    set({ goal: frame.value === null ? null : (frame.value as GoalProjection) })
  },

  resetGoal: () => set({ goal: undefined }),

  editGoal: async (objective) => {
    const trimmed = objective.trim()
    if (trimmed === '') throw new Error('目标内容不能为空')
    const { agentId, ref } = goalRef(get())
    await rpc('goals/edit', { agentId, ref, request: { objective: trimmed } })
  },

  pauseGoal: async () => {
    const { agentId, ref } = goalRef(get())
    await rpc('goals/pause', { agentId, ref })
  },

  resumeGoal: async () => {
    const { agentId, ref } = goalRef(get())
    await rpc('goals/resume', { agentId, ref })
  },

  clearGoal: async () => {
    const { agentId, ref } = goalRef(get())
    await rpc<GoalRef>('goals/clear', { agentId, ref })
  },
})
