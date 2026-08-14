/**
 * OverlayHost placeholder (owned by W5: approval / question / plan-review panels).
 * Contract: no props — reads the overlay slice (pendingApproval / pendingQuestion /
 * planReview / resolveApproval / answerQuestion, ARCHITECTURE.md section 5.3).
 * Mounted by ComposerCard above the input row; while any takeover is pending the
 * real panels (W5) replace the composer input area entirely.
 */

import { type JSX } from 'react'
import { useAppStore } from '../../store'

export function OverlayHost(): JSX.Element | null {
  const pendingApproval = useAppStore((s) => s.pendingApproval)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const planReview = useAppStore((s) => s.planReview)
  const resolveApproval = useAppStore((s) => s.resolveApproval)
  const answerQuestion = useAppStore((s) => s.answerQuestion)

  if (pendingApproval === null && pendingQuestion === null && planReview === null) {
    return null
  }

  return (
    <div className="overlay-host">
      {pendingApproval !== null && (
        <div className="overlay-strip">
          <span>审批：{pendingApproval.toolName} — {pendingApproval.reason ?? ''}</span>
          <button type="button" onClick={() => void resolveApproval('allow-once')}>Allow once</button>
          <button type="button" onClick={() => void resolveApproval('refuse')}>Refuse</button>
        </div>
      )}
      {pendingQuestion !== null && planReview === null && (
        <div className="overlay-strip">
          <span>提问：{pendingQuestion.questions[0]?.question}</span>
          {pendingQuestion.questions[0]?.options?.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => void answerQuestion([{ id: pendingQuestion.questions[0]?.id ?? '', selected: [o.label] }])}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {planReview !== null && (
        <div className="overlay-strip">
          <span>计划评审（{planReview.approveLabel}）</span>
          <button
            type="button"
            onClick={() => void answerQuestion([{ id: planReview.questionId, selected: [planReview.approveLabel] }])}
          >
            Approve
          </button>
        </div>
      )}
    </div>
  )
}
