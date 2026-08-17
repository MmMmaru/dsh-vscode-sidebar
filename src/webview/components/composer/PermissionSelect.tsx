/**
 * PermissionSelect (owned by W4): the permission-mode chip at the composer
 * toolbar's left. Three modes (Read Only / Workspace Write / Full access);
 * picking Full access opens a risk-confirmation dialog whose confirm button
 * stays disabled until the 「我已了解风险」 checkbox is ticked (aligned with
 * the dsh web PermissionSelect + RiskConfirmation).
 * Contract: ARCHITECTURE.md section 5.3 ({ value, onChange }).
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { PermissionMode } from '../../types'

interface ModeOption {
  value: PermissionMode
  label: string
  description: string
}

const MODES: readonly ModeOption[] = [
  { value: 'read-only', label: 'Read Only', description: '只读，不修改文件或执行命令' },
  { value: 'workspace-write', label: 'Workspace Write', description: '可修改工作区文件，敏感操作需确认' },
  { value: 'full-access', label: 'Full access', description: '减少确认步骤，可直接执行敏感操作' },
]

export interface PermissionSelectProps {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
}

export function PermissionSelect({ value, onChange }: PermissionSelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Outside click / Escape close the menu (one document listener while open).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current: ModeOption = MODES.find((m) => m.value === value) ?? {
    value: 'workspace-write',
    label: 'Workspace Write',
    description: '可修改工作区文件，敏感操作需确认',
  }

  const choose = (mode: PermissionMode): void => {
    setOpen(false)
    if (mode === value) return
    if (mode === 'full-access') {
      setAcknowledged(false)
      setConfirming(true)
      return
    }
    onChange(mode)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirming(false)
  }

  const confirmFullAccess = (): void => {
    if (!acknowledged) return
    closeConfirmation()
    onChange('full-access')
  }

  return (
    <div ref={rootRef} className="permission-select" data-composer-tool="permission">
      <button
        type="button"
        className="composer-chip"
        aria-label={`权限模式，当前：${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current.description}
        onClick={() => setOpen(!open)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z"
            stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
          />
        </svg>
        <span className="composer-chip-label">{current.label}</span>
      </button>
      {open && (
        <div className="composer-menu" role="menu" aria-label="权限模式">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode.value === value}
              className={`composer-menu-item${mode.value === value ? ' selected' : ''}`}
              onClick={() => choose(mode.value)}
            >
              <span className="composer-menu-item-copy">
                <span className="composer-menu-item-label">{mode.label}</span>
                <span className="composer-menu-item-desc">{mode.description}</span>
              </span>
              <span className="composer-menu-check">{mode.value === value ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
      {confirming && (
        <div className="composer-dialog-backdrop" role="presentation" onClick={closeConfirmation}>
          <div
            className="composer-dialog"
            role="dialog"
            aria-label="确认启用 Full access？"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="composer-dialog-title">确认启用 Full access？</h2>
            <p className="composer-dialog-body">
              启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，
              包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。
            </p>
            <label className="composer-dialog-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              我已了解风险，并愿意继续
            </label>
            <div className="composer-dialog-actions">
              <button type="button" className="composer-btn" onClick={closeConfirmation}>取消</button>
              <button
                type="button"
                className="composer-btn composer-btn-danger"
                disabled={!acknowledged}
                onClick={confirmFullAccess}
              >
                启用 Full access
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
