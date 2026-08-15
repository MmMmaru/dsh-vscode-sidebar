/**
 * ConfirmModal (W6): a small blocking confirmation dialog for destructive
 * actions (provider removal). Local to the settings components.
 */

import { useEffect, type JSX } from 'react'

export interface ConfirmModalProps {
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  /** Failure of the last confirm attempt, when any. */
  failure?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal(props: ConfirmModalProps): JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !props.busy) props.onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.busy, props.onCancel])

  return (
    <div className="settings-confirm-mask" role="presentation" onClick={() => { if (!props.busy) props.onCancel() }}>
      <div
        className="settings-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => { e.stopPropagation() }}
      >
        <div className="settings-confirm-title">{props.title}</div>
        <p className="settings-confirm-desc">{props.description}</p>
        {props.failure != null && props.failure !== '' && <p className="settings-error">{props.failure}</p>}
        <div className="settings-confirm-actions">
          <button type="button" className="settings-btn" disabled={props.busy} onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-danger"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? '删除中…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
