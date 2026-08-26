/**
 * ConfirmModal: a small blocking confirmation dialog for destructive actions
 * (provider removal, session delete). Shared by settings and the chat list;
 * the settings-confirm* classes stay as-is (their styles in settings.css are
 * global once bundled, and the mask is fixed-positioned, so the dialog covers
 * the whole webview from any mount point).
 */

import { useEffect, type JSX } from 'react'
import { useI18n } from '../../i18n'

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
  const { t } = useI18n()

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
            {t('cancel')}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-danger"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? t('deleting') : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
