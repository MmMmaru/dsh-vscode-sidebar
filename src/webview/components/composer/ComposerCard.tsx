/**
 * ComposerCard (owned by W4): the rounded input card of the bottom bar
 * (PRD 3.3). Assembles QueueDock / TodoPanel above the card, the card itself
 * (OverlayHost mount point — pending takeover panels replace the input area —
 * AttachmentRail, ComposerInput, and the toolbar row: + file picker and
 * PermissionSelect on the left, ModelSelect / ContextMeter / SendStopButton
 * on the right), plus StatsLine below. Owns the draft text, the not-yet-sent
 * image attachments with their intake pre-check (5 images max, 5MB each,
 * png/jpeg/webp/gif; a violating batch is rejected whole with a toast), and
 * the drag & drop intake listeners.
 * Contract: ARCHITECTURE.md section 5.3 — no props, reads the store slices.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { MessageId } from '../../../extension/protocol/brand'
import type { ImageMediaType } from '../../../extension/protocol/llm'
import { useAppStore } from '../../store'
import type { Attachment } from '../../types'
import { OverlayHost } from '../overlay/OverlayHost'
import { AttachmentRail } from './AttachmentRail'
import { ComposerInput } from './ComposerInput'
import { ContextMeter } from './ContextMeter'
import { ModelSelect } from './ModelSelect'
import { PermissionSelect } from './PermissionSelect'
import { QueueDock } from './QueueDock'
import { SendStopButton } from './SendStopButton'
import { StatsLine } from './StatsLine'
import { TodoPanel } from './TodoPanel'
import './composer.css'

/** Attachment intake limits (DeepSeek Chat semantics; the host re-enforces at submit). */
export const IMAGE_LIMITS = {
  maxCount: 5,
  maxBytes: 5 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

/** File shape the intake pre-check needs (browser File or a test stub). */
export interface IntakeFile {
  type: string
  size: number
  name: string
}

/**
 * Batch intake pre-check: returns a Chinese rejection message when the batch
 * (added to the current attachments) violates a limit, null when accepted.
 * Format precedes limits, so a batch with a non-image announces that first.
 */
export function validateImageBatch(files: readonly IntakeFile[], currentCount: number): string | null {
  if (files.length === 0) return null
  if (files.some((f) => !(IMAGE_LIMITS.mediaTypes as readonly string[]).includes(f.type))) {
    return '仅支持 png / jpeg / webp / gif 图片'
  }
  if (currentCount + files.length > IMAGE_LIMITS.maxCount) {
    return `每条消息最多 ${IMAGE_LIMITS.maxCount} 张图片`
  }
  if (files.some((f) => f.size > IMAGE_LIMITS.maxBytes)) {
    return `单张图片不能超过 ${Math.round(IMAGE_LIMITS.maxBytes / 1024 / 1024)}MB`
  }
  return null
}

/** Read one image File into a composer Attachment (base64 data + preview URL). */
function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result)
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type as ImageMediaType,
        data: result.slice(result.indexOf(',') + 1),
        previewUrl: URL.createObjectURL(file),
      })
    }
    reader.readAsDataURL(file)
  })
}

export function ComposerCard(): JSX.Element {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const turnStatus = useAppStore((s) => s.turnStatus)
  const queue = useAppStore((s) => s.queue)
  const todos = useAppStore((s) => s.todos)
  const stats = useAppStore((s) => s.stats)
  const nodes = useAppStore((s) => s.nodes)
  const models = useAppStore((s) => s.models)
  const selectedModel = useAppStore((s) => s.selectedModel)
  const permissionMode = useAppStore((s) => s.permissionMode)
  const sendPrompt = useAppStore((s) => s.sendPrompt)
  const cancel = useAppStore((s) => s.cancel)
  const selectModel = useAppStore((s) => s.selectModel)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const updateQueueItem = useAppStore((s) => s.updateQueueItem)
  const pendingApproval = useAppStore((s) => s.pendingApproval)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const planReview = useAppStore((s) => s.planReview)

  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const toastSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)

  const running = turnStatus === 'running'
  // Sending without a session auto-creates one (sendPrompt handles it), so the
  // input is always usable once the host is up.
  const canSend = draft.trim() !== '' || attachments.length > 0
  // Takeover semantics: a pending overlay replaces the whole input area.
  const overlayActive = pendingApproval !== null || pendingQuestion !== null || planReview !== null
  // 128k context-window estimate for the occupancy ring (no capacity projection on the wire yet).
  const usedPct = stats === null ? 0 : (stats.inputTokens / 128_000) * 100
  const turns = nodes.filter((n) => n.kind === 'user-message').length

  const showToast = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])

  // Toast hold-then-fade cycle.
  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  // Revoke preview URLs of removed attachments.
  useEffect(() => {
    return () => {
      for (const a of attachments) {
        if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl)
      }
    }
  }, [attachments])

  /** Intake from any source (picker / drop / paste): pre-check the batch, then read files. */
  const intakeFiles = useCallback((files: readonly File[]): void => {
    if (files.length === 0) return
    const rejected = validateImageBatch(files, attachments.length)
    if (rejected !== null) {
      showToast(rejected)
      return
    }
    void Promise.all(files.map(fileToAttachment))
      .then((added) => setAttachments((cur) => [...cur, ...added]))
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
  }, [attachments.length, showToast])

  // Document-level drag & drop (dsh web behavior): a file drop anywhere over
  // the panel targets the composer; text drags pass through untouched.
  useEffect(() => {
    const hasFiles = (e: globalThis.DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false
    const reset = (): void => {
      dragDepthRef.current = 0
      setDragActive(false)
    }
    const onDragEnter = (e: globalThis.DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }
    const onDragOver = (e: globalThis.DragEvent): void => {
      if (!hasFiles(e) || e.dataTransfer === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: globalThis.DragEvent): void => {
      if (!hasFiles(e)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragActive(false)
    }
    const onDrop = (e: globalThis.DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      reset()
      intakeFiles([...(e.dataTransfer?.files ?? [])])
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [intakeFiles])

  const removeAttachment = (id: string): void => {
    setAttachments((cur) => {
      const removed = cur.find((a) => a.id === id)
      if (removed?.previewUrl !== undefined) URL.revokeObjectURL(removed.previewUrl)
      return cur.filter((a) => a.id !== id)
    })
  }

  const send = (): void => {
    if (!canSend) return
    const text = draft.trim()
    const sent = attachments
    for (const a of sent) {
      if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl)
    }
    setDraft('')
    setAttachments([])
    // mode 'queue' in sendPrompt: a running turn queues the message server-side.
    void sendPrompt(text, sent).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : String(err))
    })
  }

  const onEditQueueItem = async (id: MessageId, text: string): Promise<void> => {
    await updateQueueItem(id, { kind: 'edit', content: [{ type: 'text', text }] })
  }

  return (
    <section className="region region-composer composer-region" data-region="ComposerCard">
      <QueueDock
        queue={queue}
        running={running}
        onEdit={onEditQueueItem}
        onRemove={async (id) => updateQueueItem(id, { kind: 'remove' })}
        onSteer={async (id) => updateQueueItem(id, { kind: 'steer' })}
      />
      <TodoPanel todos={todos} />
      <div className={`composer-card${dragActive ? ' drag-active' : ''}`} data-composer-card>
        <OverlayHost />
        {!overlayActive && (
          <>
            <AttachmentRail items={attachments} onRemove={removeAttachment} />
            <ComposerInput
              value={draft}
              onChange={setDraft}
              onSend={send}
              running={running}
              disabled={false}
              sessionId={activeSessionId}
              onPasteFiles={intakeFiles}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <button
                  type="button"
                  className="composer-chip composer-add"
                  aria-label="添加图片附件"
                  title="添加图片附件"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={IMAGE_LIMITS.mediaTypes.join(',')}
                  multiple
                  hidden
                  onChange={(e) => {
                    intakeFiles([...(e.target.files ?? [])])
                    e.target.value = '' // re-picking the same file must re-fire change
                  }}
                />
                <PermissionSelect value={permissionMode} onChange={setPermissionMode} />
              </div>
              <div className="composer-trailing">
                <ModelSelect models={models} selected={selectedModel} onSelect={selectModel} />
                <ContextMeter usedPct={usedPct} />
                <SendStopButton running={running} canSend={canSend} onSend={send} onStop={() => void cancel()} />
              </div>
            </div>
          </>
        )}
        {toast !== null && (
          <div key={toast.seq} className="composer-toast" role="status">{toast.text}</div>
        )}
        {dragActive && <div className="composer-drop-overlay">松开以添加图片</div>}
      </div>
      <StatsLine stats={stats} turns={turns} />
    </section>
  )
}
