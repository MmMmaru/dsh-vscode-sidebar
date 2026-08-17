/**
 * Overlay slice (owned by W5). Takeover state: a pending approval, a pending
 * ask-user batch, or a plan review (derived from a plan-review question).
 * Pending overlays are tracked per session (`overlayBySession`) — a frame for
 * a non-active session still records the amber "waiting" dot in the chat list
 * — while `pendingApproval` / `pendingQuestion` / `planReview` derive the
 * takeover panel state of the ACTIVE session. ComposerCard swaps itself for
 * the panel when the active session has one.
 * Answers go through the bridge `respond` message (ARCHITECTURE.md section 3
 * revision 2); the matching resolved frame clears the state.
 * Replay: a hidden sidebar webview is disposed by VSCode and re-resolved on
 * show, losing all UI state; the extension host retains answerable frames and
 * hands them back in the init payload (`applyOverlays`), so a question that
 * arrived while the sidebar was in the background re-appears on return.
 * Contract: ARCHITECTURE.md section 5.2.
 */

import type { StateCreator } from 'zustand'
import type { AskUserQuestionAnswerItem, MuxFrame } from '../../extension/protocol/events'
import type { SessionId } from '../../extension/protocol/brand'
import type { PendingOverlayReplay } from '../../shared/bridge'
import { respondApproval, respondQuestion } from '../bridge'
import type { ApprovalRequest, PlanReviewState, QuestionRequest } from '../types'
import type { AppStore } from './index'

/** The pending takeover state of one session (approval or question, never both). */
export interface SessionOverlayState {
  approval?: ApprovalRequest
  question?: QuestionRequest
}

/** State + actions owned by the takeover-panel workflow. */
export interface OverlaySlice {
  /** Takeover panel state of the ACTIVE session (derived from overlayBySession). */
  pendingApproval: ApprovalRequest | null
  pendingQuestion: QuestionRequest | null
  /** Derived from pendingQuestion when a question carries the plan-review intent. */
  planReview: PlanReviewState | null
  /** Per-session pending overlays; drives the amber waiting dot in the chat list. */
  overlayBySession: Record<string, SessionOverlayState>

  /** Overlay-frame handler: approval/question requested/resolved frames. */
  applyOverlayFrame: (frame: MuxFrame) => void
  /** Install replayed overlays from the init payload (webview recreated). */
  applyOverlays: (overlays: PendingOverlayReplay[]) => void
  /** Re-derive the active session's panel state from overlayBySession. */
  refreshActiveOverlay: () => void
  /** Answer the pending approval; cleared on the resolved frame. */
  resolveApproval: (decision: 'allow-once' | 'refuse') => Promise<void>
  /** Answer the pending question batch; cleared on the resolved frame. */
  answerQuestion: (answers: AskUserQuestionAnswerItem[]) => Promise<void>
  /** Drop takeover panel state (on session switch); the per-session map stays. */
  clearOverlay: () => void
}

/** Derive plan-review state from a question batch, or null when absent. */
export function derivePlanReview(request: QuestionRequest | null): PlanReviewState | null {
  if (request === null) return null
  for (const q of request.questions) {
    if (q.intent?.kind === 'plan-review') {
      return { plan: q.detail ?? '', approveLabel: q.intent.approve, request, questionId: q.id }
    }
  }
  return null
}

/** True when any session holds a pending overlay (drives amber dots). */
export function waitingSessionId(overlayBySession: Record<string, SessionOverlayState>): SessionId | null {
  const first = Object.keys(overlayBySession)[0]
  return first === undefined ? null : (first as SessionId)
}

export const createOverlaySlice: StateCreator<AppStore, [], [], OverlaySlice> = (set, get) => ({
  pendingApproval: null,
  pendingQuestion: null,
  planReview: null,
  overlayBySession: {},

  applyOverlayFrame: (frame) => {
    if (frame.type === 'stream/error') return
    const bySession = { ...get().overlayBySession }
    const entry: SessionOverlayState = { ...(bySession[frame.sessionId] ?? {}) }
    switch (frame.type) {
      case 'approval/requested':
        entry.approval = {
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          callId: frame.callId,
          reason: frame.reason,
        }
        bySession[frame.sessionId] = entry
        break
      case 'approval/resolved':
        if (entry.approval?.approvalId !== frame.approvalId) return
        delete entry.approval
        if (entry.question === undefined) delete bySession[frame.sessionId]
        else bySession[frame.sessionId] = entry
        break
      case 'question/requested':
        entry.question = { sessionId: frame.sessionId, questions: frame.questions }
        bySession[frame.sessionId] = entry
        break
      case 'question/resolved':
        if (entry.question === undefined) return
        delete entry.question
        if (entry.approval === undefined) delete bySession[frame.sessionId]
        else bySession[frame.sessionId] = entry
        break
      default:
        return
    }
    set({ overlayBySession: bySession })
    // Derive the active session's takeover panel only when it is the speaker.
    if (frame.sessionId === get().activeSessionId) {
      get().refreshActiveOverlay()
    }
  },

  applyOverlays: (overlays) => {
    if (overlays.length === 0) return
    const bySession = { ...get().overlayBySession }
    for (const replay of overlays) {
      const entry: SessionOverlayState = { ...(bySession[replay.frame.sessionId] ?? {}) }
      if (replay.kind === 'approval') {
        entry.approval = {
          sessionId: replay.frame.sessionId,
          approvalId: replay.frame.approvalId,
          toolName: replay.frame.toolName,
          callId: replay.frame.callId,
          reason: replay.frame.reason,
        }
      } else {
        entry.question = { sessionId: replay.frame.sessionId, questions: replay.frame.questions }
      }
      bySession[replay.frame.sessionId] = entry
    }
    set({ overlayBySession: bySession })
    get().refreshActiveOverlay()
  },

  refreshActiveOverlay: () => {
    const active = get().activeSessionId
    if (active === null) {
      set({ pendingApproval: null, pendingQuestion: null, planReview: null })
      return
    }
    const entry = get().overlayBySession[active]
    set({
      pendingApproval: entry?.approval ?? null,
      pendingQuestion: entry?.question ?? null,
      planReview: derivePlanReview(entry?.question ?? null),
    })
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
