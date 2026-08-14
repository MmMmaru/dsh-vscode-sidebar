/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/host/apiproxy/src/api/approvals.ts  (ApprovalResponsePayload)
 *   packages/host/apiproxy/src/api/questions.ts  (QuestionResponsePayload)
 * Answerable-frame answer payloads. The requested frame is a server-request
 * (stable rpcId); the answer is a client-response echoing that rpcId, carried
 * on POST /api/respond with an RpcReceipt as the HTTP response body; the final
 * outcome arrives in the resolved frame.
 */

import type { ApprovalRequestId, SessionId } from './brand'
import type { AskUserQuestionAnswer } from './events'

/**
 * Approval answer payload (the result.value slot of a client-response).
 * outcome accepts only the two values a client can give (cancelled/unavailable
 * are host-side outcomes). approvalId is the core audit correlation; wire
 * correlation is governed by the echoed rpcId.
 */
export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: ApprovalRequestId
  outcome: 'allowed-once' | 'rejected'
}

/**
 * Question answer payload (the result.value slot of a client-response):
 * answers one ask() as a whole batch (one ask, many questions, one answer —
 * never split per question). No resource id: the echoed rpcId suffices.
 */
export interface QuestionResponsePayload {
  sessionId: SessionId
  answer: AskUserQuestionAnswer
}
