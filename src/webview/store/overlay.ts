/**
 * Overlay slice. Takeover state: a pending approval, a pending ask-user batch,
 * or a plan review (derived from a plan-review question).
 * Pending overlays are tracked per session (`overlayBySession`) — a request for
 * a non-active session still records the amber "waiting" dot in the chat list
 * — while `pendingApproval` / `pendingQuestion` / `planReview` derive the
 * takeover panel state of the ACTIVE session. ComposerCard swaps itself for
 * the panel when the active session has one.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): this slice used to consume
 * `approval/requested` / `approval/resolved` / `question/requested` /
 * `question/resolved` mux frames. Those frame types are gone. A request now
 * arrives pre-shaped as a `PendingOverlayReplay` (the extension host builds it
 * from the `$events` waterfall frame) and is retracted by `eventId`, so this
 * slice no longer has to demultiplex frames or match resolution ids.
 *
 * Answers go through the bridge `respond` message; the request is cleared
 * optimistically here and authoritatively by the host's retraction.
 *
 * Replay: a hidden sidebar webview is disposed by VSCode and re-resolved on
 * show, losing all UI state; the extension host retains pending requests and
 * hands them back in the init payload (`applyOverlays`), so a question that
 * arrived while the sidebar was in the background re-appears on return.
 */

import type { StateCreator } from 'zustand'
import type { AskUserQuestionAnswerItem } from '../../extension/protocol/events'
import type { SessionId } from '../../extension/protocol/brand'
import type { PendingOverlayReplay } from '../../shared/bridge'
import { respondApproval, respondQuestion } from '../bridge'
import type { ApprovalRequest, PlanReviewState, QuestionRequest } from '../types'
import type { AppStore } from './index'

/** The pending takeover state of one session (approval or question, or both). */
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

  /** Record one incoming answerable request from the host. */
  applyPendingOverlay: (overlay: PendingOverlayReplay) => void
  /** Drop one request the host retracted (or that we already answered). */
  clearPendingOverlay: (eventId: string) => void
  /** Install replayed overlays from the init payload (webview recreated). */
  applyOverlays: (overlays: PendingOverlayReplay[]) => void
  /** Re-derive the active session's panel state from overlayBySession. */
  refreshActiveOverlay: () => void
  /** Answer the pending approval; cleared optimistically, confirmed by retraction. */
  resolveApproval: (decision: 'allow-once' | 'refuse') => Promise<void>
  /** Answer the pending question batch; cleared optimistically. */
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

/** Build the UI-facing request pair from one wire overlay. */
function toRequest(overlay: PendingOverlayReplay): { sessionId: SessionId; entry: SessionOverlayState } {
  const sessionId = overlay.agentId as SessionId
  if (overlay.kind === 'approval') {
    return {
      sessionId,
      entry: {
        approval: {
          sessionId,
          eventId: overlay.eventId,
          toolName: overlay.toolName,
          ...(overlay.callId !== undefined ? { callId: overlay.callId as ApprovalRequest['callId'] } : {}),
          ...(overlay.reason !== undefined ? { reason: overlay.reason } : {}),
        },
      },
    }
  }
  return { sessionId, entry: { question: { sessionId, eventId: overlay.eventId, questions: overlay.questions } } }
}

export const createOverlaySlice: StateCreator<AppStore, [], [], OverlaySlice> = (set, get) => ({
  pendingApproval: null,
  pendingQuestion: null,
  planReview: null,
  overlayBySession: {},

  applyPendingOverlay: (overlay) => {
    const { sessionId, entry: incoming } = toRequest(overlay)
    const bySession = { ...get().overlayBySession }
    const entry: SessionOverlayState = { ...(bySession[sessionId] ?? {}), ...incoming }
    bySession[sessionId] = entry
    set({ overlayBySession: bySession })
    // Derive the takeover panel only when the active session is the speaker.
    if (sessionId === get().activeSessionId) get().refreshActiveOverlay()
  },

  clearPendingOverlay: (eventId) => {
    const bySession = { ...get().overlayBySession }
    let changed = false
    for (const [sessionId, entry] of Object.entries(bySession)) {
      const next: SessionOverlayState = { ...entry }
      if (next.approval?.eventId === eventId) delete next.approval
      if (next.question?.eventId === eventId) delete next.question
      if (next.approval === undefined && next.question === undefined) {
        delete bySession[sessionId]
        changed = true
      } else if (next.approval !== entry.approval || next.question !== entry.question) {
        bySession[sessionId] = next
        changed = true
      }
    }
    if (!changed) return
    set({ overlayBySession: bySession })
    get().refreshActiveOverlay()
  },

  applyOverlays: (overlays) => {
    if (overlays.length === 0) return
    const bySession = { ...get().overlayBySession }
    for (const overlay of overlays) {
      const { sessionId, entry: incoming } = toRequest(overlay)
      bySession[sessionId] = { ...(bySession[sessionId] ?? {}), ...incoming }
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
    await respondApproval(pending.eventId, decision)
    set({ pendingApproval: null })
    get().clearPendingOverlay(pending.eventId)
  },

  answerQuestion: async (answers) => {
    const pending = get().pendingQuestion
    if (pending === null) return
    await respondQuestion(pending.eventId, answers)
    set({ pendingQuestion: null, planReview: null })
    get().clearPendingOverlay(pending.eventId)
  },

  clearOverlay: () => set({ pendingApproval: null, pendingQuestion: null, planReview: null }),
})
