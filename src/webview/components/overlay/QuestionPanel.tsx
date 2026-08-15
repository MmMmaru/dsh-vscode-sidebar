/**
 * QuestionPanel (W5): the composer takeover for an ask-user question batch,
 * modeled on the dsh web client's QuestionComposer generic flow: eyebrow
 * header + question title + a top-right "关闭全部" button, an option list
 * (single-select radio / multi-select checkbox, "(recommended)" labels render
 * a 推荐 badge), a "Type your answer" custom row (a large textarea when the
 * question has no options), prev/next pagination with a 1/N indicator, and
 * Skip this question / Submit actions. Single-select choices auto-advance to
 * the next question.
 *
 * Answers assemble per question: a skipped question answers with an empty
 * selection; a custom text answers alone for single-select and alongside the
 * checked labels for multi-select. A failed submit re-arms the panel and
 * shows the error.
 * Contract: ARCHITECTURE.md section 5.3.
 */

import { useState, type ChangeEvent, type JSX, type KeyboardEvent } from 'react'
import type { AskUserQuestionAnswerItem } from '../../../extension/protocol/events'
import type { QuestionRequest } from '../../types'

/** QuestionPanel props: the pending batch plus the store's answer action. */
export interface QuestionPanelProps {
  request: QuestionRequest
  onAnswer: (answers: AskUserQuestionAnswerItem[]) => Promise<void>
}

/** Per-question working draft (selected labels + custom text + skip flag). */
interface DraftAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

/**
 * Split the conventional recommendation suffix without changing the answer
 * value: the original label is still what gets submitted.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/** Return whether a text-field key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}

/** Render one pending question batch as a takeover card. */
export function QuestionPanel({ request, onAnswer }: QuestionPanelProps): JSX.Element {
  const questions = request.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => questions.map(() => ({
    selected: [], custom: '', skipped: false,
  })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // index stays in bounds (every setIndex site clamps) and drafts mirrors questions 1:1.
  const question = questions[Math.min(index, questions.length - 1)]
  const draft = drafts[Math.min(index, questions.length - 1)]
  if (question === undefined || draft === undefined) {
    return <div className="ovl-card ovl-feedback">空的问题批次</div>
  }
  const hasOptions = (question.options?.length ?? 0) > 0
  const isLast = index >= questions.length - 1

  const fail = (cause: unknown): void => {
    setBusy(false)
    setError(cause instanceof Error ? cause.message : String(cause))
  }

  /** 关闭全部: answer the whole batch with empty selections (decline semantics). */
  const closeAll = (): void => {
    setBusy(true)
    setError(null)
    void onAnswer(questions.map((item) => ({ id: item.id, selected: [] }))).catch(fail)
  }

  const updateDraft = (update: (current: DraftAnswer) => DraftAnswer): void => {
    setDrafts((current) => current.map((item, i) => (i === index ? update(item) : item)))
    setError(null)
  }

  /** Pick an option: toggles for multi-select; replaces and auto-advances for single-select. */
  const choose = (label: string): void => {
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter((item) => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    })
    if (question.multiSelect !== true && !isLast) setIndex((current) => current + 1)
  }

  const answered = (item: DraftAnswer): boolean => item.selected.length > 0 || item.custom.trim() !== ''
  const completed = (item: DraftAnswer): boolean => answered(item) || item.skipped

  /** Assemble the batch answer and send it; jumps to the first unfinished question instead. */
  const submitDrafts = (values: DraftAnswer[]): void => {
    const missing = values.findIndex((item) => !completed(item))
    if (missing >= 0) {
      setIndex(missing)
      setError('请先完成这道问题。')
      return
    }
    const answers: AskUserQuestionAnswerItem[] = questions.map((item, i) => {
      const value = values[i] ?? { selected: [], custom: '', skipped: false }
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    })
    setBusy(true)
    setError(null)
    void onAnswer(answers).catch(fail)
  }

  /** Continue: advance to the next question, or submit on the last one. */
  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError('请选择一个选项或填写自定义答案。')
      return
    }
    if (!isLast) {
      setIndex((current) => current + 1)
      setError(null)
      return
    }
    submitDrafts(drafts)
  }

  // Shared by the inline custom input and the optionless textarea: a
  // multi-select draft retains checked labels, while a single-select custom
  // answer replaces its selection.
  const draftCustom = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const value = event.target.value
    updateDraft((current) => ({
      ...current,
      selected: question.multiSelect === true ? current.selected : [],
      custom: value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  }

  /** Skip: mark this question skipped, then advance or submit the batch. */
  const skipQuestion = (): void => {
    const nextDrafts = drafts.map((item, i) => (i === index ? { selected: [], custom: '', skipped: true } : item))
    setDrafts(nextDrafts)
    setError(null)
    if (!isLast) {
      setIndex((current) => current + 1)
      return
    }
    submitDrafts(nextDrafts)
  }

  return (
    <div className="ovl-card" data-question-session={request.sessionId}>
      <header className="ovl-header">
        <div className="ovl-heading-block">
          {question.header !== undefined && <div className="ovl-eyebrow">{question.header}</div>}
          <h2 className="ovl-title">{question.question}</h2>
        </div>
        <button
          type="button" className="ovl-btn ovl-btn-ghost ovl-close-all"
          disabled={busy} onClick={closeAll}
        >
          关闭全部
        </button>
      </header>

      <div className="ovl-body" data-question-scroll>
        {question.detail !== undefined && <div className="ovl-detail">{question.detail}</div>}
        <div className="ovl-options" role={question.multiSelect === true ? 'group' : 'radiogroup'}>
          {(question.options ?? []).map((option, optionIndex) => {
            const selected = draft.selected.includes(option.label)
            const display = parseRecommendedLabel(option.label)
            return (
              <button
                type="button" key={`${option.label}-${String(optionIndex)}`}
                className={`ovl-option${selected ? ' ovl-option-selected' : ''}`}
                role={question.multiSelect === true ? 'checkbox' : 'radio'}
                aria-checked={selected}
                aria-label={display.label}
                disabled={busy}
                onClick={() => { choose(option.label) }}
              >
                <span
                  className={question.multiSelect === true
                    ? `ovl-checkbox${selected ? ' ovl-checkbox-checked' : ''}`
                    : `ovl-radio${selected ? ' ovl-radio-checked' : ''}`}
                  aria-hidden="true"
                />
                <span className="ovl-option-copy">
                  <span className="ovl-option-line">
                    <span className="ovl-option-label">{display.label}</span>
                    {display.recommended && <span className="ovl-badge">推荐</span>}
                  </span>
                  {option.description !== undefined && (
                    <span className="ovl-option-desc">{option.description}</span>
                  )}
                </span>
              </button>
            )
          })}

          {hasOptions
            ? (
              <div className={`ovl-custom-row${draft.custom !== '' ? ' ovl-custom-row-active' : ''}`}>
                <input
                  type="text"
                  className="ovl-custom-input"
                  value={draft.custom}
                  disabled={busy}
                  placeholder="Type your answer"
                  onChange={draftCustom}
                  onKeyDown={continueFromCustom}
                />
              </div>
              )
            : (
              <textarea
                className="ovl-custom-textarea"
                value={draft.custom}
                disabled={busy}
                rows={4}
                placeholder="Type your answer"
                onChange={draftCustom}
                onKeyDown={continueFromCustom}
              />
              )}
        </div>
      </div>

      <footer className="ovl-footer">
        <div className="ovl-pager">
          <button
            type="button" className="ovl-btn ovl-btn-ghost" aria-label="上一题" title="上一题"
            disabled={index === 0 || busy}
            onClick={() => { setIndex(index - 1); setError(null) }}
          >
            ‹
          </button>
          <span className="ovl-progress">{index + 1} / {questions.length}</span>
          <button
            type="button" className="ovl-btn ovl-btn-ghost" aria-label="下一题" title="下一题"
            disabled={isLast || busy}
            onClick={() => { setIndex(index + 1); setError(null) }}
          >
            ›
          </button>
        </div>
        <div className="ovl-feedback" role="status">{error}</div>
        <div className="ovl-actions">
          <button type="button" className="ovl-btn ovl-btn-outline" disabled={busy} onClick={skipQuestion}>
            Skip this question
          </button>
          <button
            type="button" className="ovl-btn ovl-btn-primary"
            disabled={busy || !answered(draft)} onClick={continueFlow}
          >
            {isLast ? 'Submit' : '下一题'}
          </button>
        </div>
      </footer>
    </div>
  )
}
