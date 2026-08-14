/**
 * Overlay slice (owned by W5). Takeover state: a pending approval, a pending
 * ask-user batch, or a plan review (derived from a plan-review question) —
 * at most one is pending per session; ComposerCard swaps itself for the panel.
 * Answers go through the bridge `respond` message (ARCHITECTURE.md section 3
 * revision 2); the matching resolved frame clears the state.
 * Contract: ARCHITECTURE.md section 5.2.
 */

import type { StateCreator } from 'zustand'
import type { AskUserQuestionAnswerItem, MuxFrame } from '../../extension/protocol/events'
import { respondApproval, respondQuestion } from '../bridge'
import type { ApprovalRequest, PlanReviewState, QuestionRequest } from '../types'
import type { AppStore } from './index'

/** State + actions owned by the takeover-panel workflow. */
export interface OverlaySlice {
  pendingApproval: ApprovalRequest | null
  pendingQuestion: QuestionRequest | null
  /** Derived from pendingQuestion when a question carries the plan-review intent. */
  planReview: PlanReviewState | null

  /** Overlay-frame handler: approval/question requested/resolved frames. */
  applyOverlayFrame: (frame: MuxFrame) => void
  /** Answer the pending approval; cleared on the resolved frame. */
  resolveApproval: (decision: 'allow-once' | 'refuse') => Promise<void>
  /** Answer the pending question batch; cleared on the resolved frame. */
  answerQuestion: (answers: AskUserQuestionAnswerItem[]) => Promise<void>
  /** Drop takeover state (on session switch). */
  clearOverlay: () => void
}

/** Derive plan-review state from a question batch, or null when absent. */
function derivePlanReview(request: QuestionRequest | null): PlanReviewState | null {
  if (request === null) return null
  for (const q of request.questions) {
    if (q.intent?.kind === 'plan-review') {
      return { plan: q.detail ?? '', approveLabel: q.intent.approve, request, questionId: q.id }
    }
  }
  return null
}

export const createOverlaySlice: StateCreator<AppStore, [], [], OverlaySlice> = (set, get) => ({
  pendingApproval: null,
  pendingQuestion: null,
  planReview: null,

  applyOverlayFrame: (frame) => {
    if (frame.type === 'stream/error') return
    if (frame.sessionId !== get().activeSessionId) return
    switch (frame.type) {
      case 'approval/requested':
        set({
          pendingApproval: {
            sessionId: frame.sessionId,
            approvalId: frame.approvalId,
            toolName: frame.toolName,
            callId: frame.callId,
            reason: frame.reason,
          },
        })
        break
      case 'approval/resolved':
        if (get().pendingApproval?.approvalId === frame.approvalId) set({ pendingApproval: null })
        break
      case 'question/requested': {
        const request: QuestionRequest = { sessionId: frame.sessionId, questions: frame.questions }
        set({ pendingQuestion: request, planReview: derivePlanReview(request) })
        break
      }
      case 'question/resolved':
        set({ pendingQuestion: null, planReview: null })
        break
      default:
        break
    }
  },

  resolveApproval: async (decision) => {
    const pending = get().pendingApproval
    if (pending === null) return
    await respondApproval(pending.approvalId, decision)
    set({ pendingApproval: null })
  },

  answerQuestion: async (answers) => {
    const pending = get().pendingQuestion
    if (pending === null) return
    await respondQuestion(pending.sessionId, answers)
    set({ pendingQuestion: null, planReview: null })
  },

  clearOverlay: () => set({ pendingApproval: null, pendingQuestion: null, planReview: null }),
})
