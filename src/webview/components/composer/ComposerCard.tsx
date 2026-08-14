/**
 * ComposerCard placeholder (owned by W4; the takeover panels live in
 * components/overlay/OverlayHost, owned by W5).
 * Contract: no props — reads the composer slice (ARCHITECTURE.md section 5.3).
 * Renders a minimal input row so sendPrompt/cancel/selectModel are exercisable;
 * OverlayHost is mounted above the input row and renders null when idle.
 */

import { useState, type JSX } from 'react'
import { useAppStore } from '../../store'
import { OverlayHost } from '../overlay/OverlayHost'

export function ComposerCard(): JSX.Element {
  const [text, setText] = useState('')
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const turnStatus = useAppStore((s) => s.turnStatus)
  const queue = useAppStore((s) => s.queue)
  const selectedModel = useAppStore((s) => s.selectedModel)
  const sendPrompt = useAppStore((s) => s.sendPrompt)
  const cancel = useAppStore((s) => s.cancel)

  const running = turnStatus === 'running'
  const canSend = activeSessionId !== null && text.trim() !== '' && !running

  const send = (): void => {
    if (!canSend) return
    void sendPrompt(text.trim(), [])
    setText('')
  }

  return (
    <section className="region region-composer" data-region="ComposerCard">
      <OverlayHost />
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
