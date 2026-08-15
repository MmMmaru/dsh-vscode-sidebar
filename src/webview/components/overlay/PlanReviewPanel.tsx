/**
 * PlanReviewPanel (W5): the composer takeover for a question carrying the
 * plan-review intent (design follows the dsh web client's PlanReviewPanel):
 * a "Plan review" strip, the full plan rendered as settled Markdown, and the
 * three-button decision row — Chat about it / Refuse / Approve. Approve and
 * Refuse answer the underlying question (the store maps them to the asker's
 * option labels); Chat about it shares the decline semantics so the user can
 * keep discussing in chat.
 *
 * One-shot latch: buttons disable after a click; a failed send re-arms them
 * and shows why.
 * Contract: ARCHITECTURE.md section 5.3.
 */

import { useState, type JSX } from 'react'
import { MarkdownBlock } from '../conversation/MarkdownBlock'

/** PlanReviewPanel props: the plan markdown plus the three decision callbacks. */
export interface PlanReviewPanelProps {
  /** The plan markdown under review. */
  plan: string
  onApprove: () => Promise<void>
  onRefuse: () => Promise<void>
  onChat: () => Promise<void>
}

/** Render one plan review as a takeover card. */
export function PlanReviewPanel({ plan, onApprove, onRefuse, onChat }: PlanReviewPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settle = (send: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <div className="ovl-card" data-plan-review>
      <div className="ovl-strip"><span className="ovl-strip-dot" />Plan review</div>
      <div className="ovl-body" data-plan-review-scroll tabIndex={0} role="group" aria-label="计划详情">
        <MarkdownBlock text={plan} streaming={false} />
      </div>
      <div className="ovl-footer">
        <div className="ovl-feedback" role="status">{error}</div>
        <div className="ovl-actions">
          <button type="button" className="ovl-btn ovl-btn-ghost" disabled={busy} onClick={() => { settle(onChat) }}>
            Chat about it
          </button>
          <button type="button" className="ovl-btn ovl-btn-outline" disabled={busy} onClick={() => { settle(onRefuse) }}>
            Refuse
          </button>
          <button type="button" className="ovl-btn ovl-btn-primary" disabled={busy} onClick={() => { settle(onApprove) }}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
