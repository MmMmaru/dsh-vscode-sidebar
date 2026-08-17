/**
 * Goal slice: whole-value projection reads (history baseline + mux frames) and
 * CAS-guarded mutations. State arrives ONLY from the `goal` projection — a
 * mutation's RPC acknowledgement never feeds client state; the host's
 * committed goal/change event → session/projection frame is the single source
 * of truth. Actions read the active session and the latest projection ref at
 * call time, send the mutation, and let errors propagate to the GoalBar.
 */

import type { StateCreator } from 'zustand'
import type { SessionId } from '../../extension/protocol/brand'
import type { MuxFrame } from '../../extension/protocol/events'
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
  applyGoalMuxFrame: (frame: Extract<MuxFrame, { type: 'session/projection' }>) => void
  /** Clear local goal state while a new session is loading. */
  resetGoal: () => void
  editGoal: (objective: string) => Promise<void>
  pauseGoal: () => Promise<void>
  resumeGoal: () => Promise<void>
  clearGoal: () => Promise<void>
}

/** Read the active session's goal CAS ref, failing loud when there is no goal. */
function goalRef(state: { activeSessionId: SessionId | null; goal: GoalProjection | null | undefined }): {
  sessionId: SessionId
  ref: GoalRef
} {
  if (state.activeSessionId === null || state.goal === null || state.goal === undefined) {
    throw new Error('当前会话没有可操作的目标')
  }
  return {
    sessionId: state.activeSessionId,
    ref: { id: state.goal.goal.id, revision: state.goal.goal.revision },
  }
}

export const createGoalSlice: StateCreator<AppStore, [], [], GoalSlice> = (set, get) => ({
  goal: undefined,

  applyGoalHistory: (sessionId, values) => {
    if (get().activeSessionId !== sessionId) return
    set({ goal: values?.goal })
  },

  applyGoalMuxFrame: (frame) => {
    if (frame.sessionId !== get().activeSessionId || frame.key !== 'goal') return
    // `null` is the durable clear tombstone; anything else is the whole value.
    set({ goal: frame.value === null ? null : (frame.value as GoalProjection) })
  },

  resetGoal: () => set({ goal: undefined }),

  editGoal: async (objective) => {
    const trimmed = objective.trim()
    if (trimmed === '') throw new Error('目标内容不能为空')
    const { sessionId, ref } = goalRef(get())
    await rpc('goal.edit', { sessionId, ref, objective: trimmed })
  },

  pauseGoal: async () => {
    const { sessionId, ref } = goalRef(get())
    await rpc('goal.pause', { sessionId, ref })
  },

  resumeGoal: async () => {
    const { sessionId, ref } = goalRef(get())
    await rpc('goal.resume', { sessionId, ref })
  },

  clearGoal: async () => {
    const { sessionId, ref } = goalRef(get())
    await rpc<{ cleared: true }>('goal.clear', { sessionId, ref })
  },
})
