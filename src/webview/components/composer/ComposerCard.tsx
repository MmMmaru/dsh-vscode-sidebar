/**
 * ComposerCard placeholder (owned by W4; the overlay swap mechanism is W5).
 * Contract: no props — reads composer + overlay slices (ARCHITECTURE.md
 * section 5.3). Renders a minimal input row so sendPrompt/cancel/selectModel
 * are exercisable; while an approval/question/plan review is pending it shows
 * a bare takeover strip (the real panels replace this in W5).
 */

import { useState, type JSX } from 'react'
import { useAppStore } from '../../store'

export function ComposerCard(): JSX.Element {
  const [text, setText] = useState('')
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const turnStatus = useAppStore((s) => s.turnStatus)
  const queue = useAppStore((s) => s.queue)
  const selectedModel = useAppStore((s) => s.selectedModel)
  const sendPrompt = useAppStore((s) => s.sendPrompt)
  const cancel = useAppStore((s) => s.cancel)
  const pendingApproval = useAppStore((s) => s.pendingApproval)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const planReview = useAppStore((s) => s.planReview)
  const resolveApproval = useAppStore((s) => s.resolveApproval)
  const answerQuestion = useAppStore((s) => s.answerQuestion)

  const running = turnStatus === 'running'
  const canSend = activeSessionId !== null && text.trim() !== '' && !running

  const send = (): void => {
    if (!canSend) return
    void sendPrompt(text.trim(), [])
    setText('')
  }

  return (
    <section className="region region-composer" data-region="ComposerCard">
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
      <div className="composer-row">
        <textarea
          value={text}
          placeholder={activeSessionId === null ? '先选择一个会话' : '输入消息…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
        />
        {running ? (
          <button type="button" onClick={() => void cancel()}>Stop</button>
        ) : (
          <button type="button" disabled={!canSend} onClick={send}>Send</button>
        )}
      </div>
      <div className="composer-meta">
        model: {selectedModel === null ? '—' : `${selectedModel.provider}/${selectedModel.model}`}
        {queue.length > 0 && ` · queued: ${queue.length}`}
      </div>
    </section>
  )
}
