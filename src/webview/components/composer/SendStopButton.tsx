/**
 * SendStopButton (owned by W4): the composer's primary round button. Idle it
 * is an up-arrow send (disabled while the draft is empty); while a turn runs
 * it flips to a stop square that cancels the turn. While running, sending
 * still works through ComposerInput/onSend — the message then lands in the
 * queue (session.prompt mode 'queue').
 * Contract: ARCHITECTURE.md section 5.3 ({ running, canSend, onSend, onStop }).
 */

import type { JSX } from 'react'

export interface SendStopButtonProps {
  running: boolean
  canSend: boolean
  onSend: () => void
  onStop: () => void
}

export function SendStopButton({ running, canSend, onSend, onStop }: SendStopButtonProps): JSX.Element {
  if (running) {
    return (
      <button
        type="button"
        className="composer-primary"
        aria-label="停止生成"
        title="停止生成"
        onClick={onStop}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
        </svg>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="composer-primary"
      aria-label="发送"
      title="发送"
      disabled={!canSend}
      onClick={onSend}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path
          d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
          fill="currentColor"
        />
      </svg>
    </button>
  )
}
