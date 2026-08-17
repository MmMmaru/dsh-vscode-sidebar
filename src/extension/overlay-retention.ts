/**
 * Overlay retention: extension-side replay buffer for answerable frames
 * (approval/question). A hidden sidebar webview is disposed by VSCode and
 * re-resolved on show; this buffer survives webview lifecycles (it lives on
 * the Bridge, fed by a client-level subscription) so the pending takeover can
 * be replayed in the next init payload.
 * Pure module (no vscode import) so it unit-tests under plain node.
 */

import type { MuxFrame } from './protocol/events'
import type { SessionId } from './protocol/brand'
import type { PendingOverlayReplay } from '../shared/bridge'

/** Pending answerable state of one session (approval or question, never both). */
export interface PendingOverlay {
  approval?: Extract<MuxFrame, { type: 'approval/requested' }>
  question?: Extract<MuxFrame, { type: 'question/requested' }>
}

/** Retains requested frames per session and clears them on the resolved frames. */
export class OverlayRetention {
  private readonly pendingOverlays = new Map<SessionId, PendingOverlay>()

  /** Feed every mux frame (requested + resolved) through here. */
  record(frame: MuxFrame): void {
    switch (frame.type) {
      case 'approval/requested': {
        const current = this.pendingOverlays.get(frame.sessionId)
        this.pendingOverlays.set(frame.sessionId, { ...current, approval: frame })
        break
      }
      case 'approval/resolved': {
        const current = this.pendingOverlays.get(frame.sessionId)
        if (current?.approval?.approvalId !== frame.approvalId) return
        const rest: PendingOverlay = { ...current }
        delete rest.approval
        if (rest.question === undefined) this.pendingOverlays.delete(frame.sessionId)
        else this.pendingOverlays.set(frame.sessionId, rest)
        break
      }
      case 'question/requested': {
        const current = this.pendingOverlays.get(frame.sessionId)
        this.pendingOverlays.set(frame.sessionId, { ...current, question: frame })
        break
      }
      case 'question/resolved': {
        const current = this.pendingOverlays.get(frame.sessionId)
        if (current === undefined) return
        const rest: PendingOverlay = { ...current }
        delete rest.question
        if (rest.approval === undefined) this.pendingOverlays.delete(frame.sessionId)
        else this.pendingOverlays.set(frame.sessionId, rest)
        break
      }
      default:
        break
    }
  }

  /** Snapshot the retained answerable frames as init-payload replays. */
  replay(): PendingOverlayReplay[] {
    const replays: PendingOverlayReplay[] = []
    for (const pending of this.pendingOverlays.values()) {
      if (pending.approval !== undefined) replays.push({ kind: 'approval', frame: pending.approval })
      if (pending.question !== undefined) replays.push({ kind: 'question', frame: pending.question })
    }
    return replays
  }

  /** True when any session holds a pending overlay. */
  hasPending(): boolean {
    return this.pendingOverlays.size > 0
  }
}
