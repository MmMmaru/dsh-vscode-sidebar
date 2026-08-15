/**
 * OverlayHost (W5): routes the overlay slice's takeover state to the real
 * panels — ApprovalPanel for a pending approval, PlanReviewPanel for a
 * plan-review question, QuestionPanel for any other ask-user batch. At most
 * one panel renders at a time (approval wins, then plan review, then the
 * generic question flow); each panel is keyed by its request identity so the
 * one-shot busy latch never leaks into the next pending request.
 * Mounted by ComposerCard above the input row; renders null when idle.
 * Contract: ARCHITECTURE.md section 5.3.
 *
 * Answer mapping (bridge `respond` message, section 3 revision 2): approvals
 * answer by approvalId; question batches answer by sessionId. A plan review
 * approves with the intent's approve label and declines with the first
 * non-approve option label (empty selection when the asker offered none).
 */

import { useMemo, type JSX } from 'react'
import type { CallId } from '../../../extension/protocol/brand'
import type { AskUserQuestionAnswerItem } from '../../../extension/protocol/events'
import { useAppStore } from '../../store'
import type { ConversationNode, PlanReviewState } from '../../types'
import { ApprovalPanel } from './ApprovalPanel'
import { PlanReviewPanel } from './PlanReviewPanel'
import { QuestionPanel } from './QuestionPanel'
import './overlay.css'

/**
 * Recover the shell command paired with an approval from its tool-call node
 * (bash-family arguments carry `command`); undefined hides the command line.
 */
function approvalCommand(nodes: ConversationNode[], callId: CallId | undefined): string | undefined {
  if (callId === undefined) return undefined
  const node = nodes.find((n) => n.kind === 'tool-call' && n.callId === callId)
  if (node?.kind !== 'tool-call') return undefined
  try {
    const args = JSON.parse(node.arguments) as Record<string, unknown>
    return typeof args['command'] === 'string' ? args['command'] : undefined
  } catch {
    // Unparseable model args: the panel still renders without the command line.
    return undefined
  }
}

/** Build the plan-review decision callbacks (approve / decline answer mapping). */
function usePlanReviewActions(review: PlanReviewState): {
  onApprove: () => Promise<void>
  onRefuse: () => Promise<void>
  onChat: () => Promise<void>
} {
  const answerQuestion = useAppStore((s) => s.answerQuestion)
  return useMemo(() => {
    const question = review.request.questions.find((q) => q.id === review.questionId)
    const declineLabel = question?.options?.find((o) => o.label !== review.approveLabel)?.label
    const decline = (): Promise<void> => {
      const answers: AskUserQuestionAnswerItem[] = [{
        id: review.questionId,
        selected: declineLabel === undefined ? [] : [declineLabel],
      }]
      return answerQuestion(answers)
    }
    return {
      onApprove: () => answerQuestion([{ id: review.questionId, selected: [review.approveLabel] }]),
      onRefuse: decline,
      onChat: decline,
    }
  }, [review, answerQuestion])
}

/** A plan-review wrapper (hooks must not run conditionally inside OverlayHost). */
function PlanReviewOverlay({ review }: { review: PlanReviewState }): JSX.Element {
  const actions = usePlanReviewActions(review)
  return <PlanReviewPanel plan={review.plan} {...actions} />
}

export function OverlayHost(): JSX.Element | null {
  const pendingApproval = useAppStore((s) => s.pendingApproval)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const planReview = useAppStore((s) => s.planReview)
  const nodes = useAppStore((s) => s.nodes)
  const resolveApproval = useAppStore((s) => s.resolveApproval)
  const answerQuestion = useAppStore((s) => s.answerQuestion)

  if (pendingApproval !== null) {
    return (
      <ApprovalPanel
        key={pendingApproval.approvalId}
        request={pendingApproval}
        command={approvalCommand(nodes, pendingApproval.callId)}
        onResolve={resolveApproval}
      />
    )
  }
  if (planReview !== null) {
    return <PlanReviewOverlay key={planReview.questionId} review={planReview} />
  }
  if (pendingQuestion !== null) {
    const key = pendingQuestion.questions.map((q) => q.id).join('|')
    return <QuestionPanel key={key} request={pendingQuestion} onAnswer={answerQuestion} />
  }
  return null
}
