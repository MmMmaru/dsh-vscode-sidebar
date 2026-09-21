/**
 * Overlay retention: extension-side replay buffer for pending answerable
 * requests (approvals, ask-user questions).
 *
 * A hidden sidebar webview is disposed by VSCode and re-resolved on show, so a
 * buffer that survives webview lifecycles (it lives on the Bridge, fed by
 * client-level subscriptions) is what lets the pending takeover re-appear in the
 * next init payload.
 *
 * MIGRATION NOTE: this used to key pending state by `sessionId` and clear it on
 * `approval/resolved` / `question/resolved` mux frames. Those frames are gone.
 * In 0.1.5-rc.2 an answerable request arrives as a `$events` waterfall frame
 * carrying a unique `eventId`, and it is retracted by a `$events` `cancel` frame
 * naming that same `eventId`. Keying by `eventId` is both simpler and more
 * correct: one session can now have an approval and a question pending at once
 * without either overwriting the other.
 *
 * Pure module (no vscode import) so it unit-tests under plain node.
 */

import type { PendingApprovalOverlay, PendingOverlayReplay, PendingQuestionOverlay } from '../shared/bridge'

/** Retains pending answerable requests by `eventId` until the host retracts them. */
export class OverlayRetention {
  private readonly pendingRequests = new Map<string, PendingOverlayReplay>()

  /**
   * Record one incoming answerable request.
   * @param overlay - the approval or question batch, tagged with its `eventId`.
   */
  recordPending(overlay: PendingOverlayReplay): void {
    this.pendingRequests.set(overlay.eventId, overlay)
  }

  /**
   * Drop a request the host retracted, or that this client already answered.
   * @param eventId - the correlation id to clear.
   */
  recordCleared(eventId: string): void {
    this.pendingRequests.delete(eventId)
  }

  /** Snapshot the retained requests as init-payload replays. */
  replay(): PendingOverlayReplay[] {
    return [...this.pendingRequests.values()]
  }

  /** True when any request is still awaiting an answer. */
  hasPending(): boolean {
    return this.pendingRequests.size > 0
  }
}

export type { PendingApprovalOverlay, PendingQuestionOverlay }
