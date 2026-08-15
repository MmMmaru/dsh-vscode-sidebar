/**
 * ApprovalPanel (W5): the composer takeover for a pending tool approval
 * (design follows the dsh web client's ApprovalPanel): an amber "Waiting for
 * approval" strip, the model's justification as the headline, the paired shell
 * command in monospace, and a right-aligned Refuse / Allow once action row.
 * Justification and command are unbounded model text, so they scroll inside
 * the card while the action row stays outside the scroll area — the buttons
 * must be reachable no matter how long the command is.
 *
 * One-shot latch: the buttons disable after a click and the panel leaves when
 * the store clears the request (respond accepted, then the resolved frame).
 * A failed send re-arms the buttons and shows why.
 * Contract: ARCHITECTURE.md section 5.3.
 */

import { useState, type JSX } from 'react'
import type { ApprovalRequest } from '../../types'

/** ApprovalPanel props: the pending request plus the store's resolve action. */
export interface ApprovalPanelProps {
  request: ApprovalRequest
  /** Shell command paired with the approval (recovered from the tool-call node), when known. */
  command?: string
  onResolve: (decision: 'allow-once' | 'refuse') => Promise<void>
}

/** Render one pending approval as a takeover card. */
export function ApprovalPanel({ request, command, onResolve }: ApprovalPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const decide = (decision: 'allow-once' | 'refuse'): void => {
    setBusy(true)
    setError(null)
    void onResolve(decision).catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <div className="ovl-card" data-approval-id={request.approvalId}>
      <div className="ovl-strip"><span className="ovl-strip-dot" />Waiting for approval</div>
      {/* Tab stop: the region scrolls once the command passes the cap and holds
          nothing focusable of its own. */}
      <div className="ovl-body" data-approval-scroll tabIndex={0} role="group" aria-label="审批详情">
        <div className="ovl-headline">{request.reason ?? `工具 ${request.toolName} 请求越权执行`}</div>
        {command !== undefined && <div className="ovl-command">{command}</div>}
      </div>
      <div className="ovl-footer">
        <div className="ovl-feedback" role="status">{error}</div>
        <div className="ovl-actions">
          <button
            type="button" className="ovl-btn ovl-btn-outline"
            disabled={busy} onClick={() => { decide('refuse') }}
          >
            Refuse
          </button>
          <button
            type="button" className="ovl-btn ovl-btn-primary"
            disabled={busy} onClick={() => { decide('allow-once') }}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  )
}
