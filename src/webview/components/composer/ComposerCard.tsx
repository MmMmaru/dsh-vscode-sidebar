/**
 * ComposerCard (owned by W4): the rounded input card of the bottom bar
 * (PRD 3.3). Assembles QueueDock / TodoPanel above the card, the card itself
 * (OverlayHost mount point — pending takeover panels replace the input area —
 * AttachmentRail, ComposerInput, and the toolbar row: + file picker and
 * PermissionSelect on the left, ModelSelect / ContextMeter / SendStopButton
 * on the right). Owns the draft text, the not-yet-sent
 * image attachments with their intake pre-check (5 images max, 5MB each,
 * png/jpeg/webp/gif; a violating batch is rejected whole with a toast), and
 * the drag & drop intake listeners.
 * Contract: ARCHITECTURE.md section 5.3 — no props, reads the store slices.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { MessageId } from '../../../extension/protocol/brand'
import type { ImageMediaType } from '../../../extension/protocol/llm'
import { isTextFile, parseUserMessage, wrapAttachedText, type AttachedTextBlock } from '../../../shared/attached-text'
import { onIdeContent } from '../../bridge'
import { formatIdeInsert } from '../../ide-insert'
import { useAppStore } from '../../store'
import type { Attachment } from '../../types'
import { useI18n } from '../../i18n'
import { OverlayHost } from '../overlay/OverlayHost'
import { AttachmentRail } from './AttachmentRail'
import { ComposerInput } from './ComposerInput'
import { ContextMeter } from './ContextMeter'
import { GoalBar } from './GoalBar'
import { ModelSelect } from './ModelSelect'
import { PermissionSelect } from './PermissionSelect'
import { QueueDock } from './QueueDock'
import { SendStopButton } from './SendStopButton'
import { SubagentDock } from './SubagentDock'
import { TodoPanel } from './TodoPanel'
import './composer.css'

/** Attached text chip rail rendered above the composer textarea. */
function AttachedTextRail(props: { items: AttachedTextBlock[]; onRemove: (index: number) => void }): JSX.Element | null {
  const { t } = useI18n()
  if (props.items.length === 0) return null
  return (
    <div className="composer-attached-text-rail" aria-label="文本附件列表">
      {props.items.map((item, idx) => (
        <div key={idx} className="composer-attached-text-chip" title={item.path ?? item.name}>
          <span className="composer-attached-text-icon" aria-hidden>📄</span>
          <span className="composer-attached-text-name">{item.name}</span>
          <span className="composer-attached-text-lines">{item.lines} {t('linesUnit')}</span>
          <button
            type="button"
            className="composer-attached-text-remove"
            aria-label={`移除 ${item.name}`}
            onClick={() => props.onRemove(idx)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

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
  const { t } = useI18n()
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const turnStatus = useAppStore((s) => s.turnStatus)
  // The host's per-session running flag: survives history reloads, unlike the
  // event-driven turnStatus which resets to idle on every selectSession.
  const sessionRunning = useAppStore(
    (s) => s.sessions.find((meta) => meta.sessionId === s.activeSessionId)?.running === true,
  )
  const queue = useAppStore((s) => s.queue)
  const todos = useAppStore((s) => s.todos)
  const models = useAppStore((s) => s.models)
  const selectedModel = useAppStore((s) => s.selectedModel)
  const permissionMode = useAppStore((s) => s.permissionMode)
  const ideContextEnabled = useAppStore((s) => s.ideContextEnabled)
  const setIdeContextEnabled = useAppStore((s) => s.setIdeContextEnabled)
  const sendPrompt = useAppStore((s) => s.sendPrompt)
  const cancel = useAppStore((s) => s.cancel)
  const selectModel = useAppStore((s) => s.selectModel)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const updateQueueItem = useAppStore((s) => s.updateQueueItem)
  const pendingApproval = useAppStore((s) => s.pendingApproval)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const planReview = useAppStore((s) => s.planReview)
  const goal = useAppStore((s) => s.goal)
  const editGoal = useAppStore((s) => s.editGoal)
  const pauseGoal = useAppStore((s) => s.pauseGoal)
  const resumeGoal = useAppStore((s) => s.resumeGoal)
  const clearGoal = useAppStore((s) => s.clearGoal)

  const [cleanText, setCleanText] = useState('')
  const [attachedTexts, setAttachedTexts] = useState<AttachedTextBlock[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const toastSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)

  const running = turnStatus === 'running' || sessionRunning
  // Sending without a session auto-creates one (sendPrompt handles it), so the
  // input is always usable once the host is up.
  const canSend = cleanText.trim() !== '' || attachedTexts.length > 0 || attachments.length > 0
  // Takeover semantics: a pending overlay replaces the whole input area.
  const overlayActive = pendingApproval !== null || pendingQuestion !== null || planReview !== null

  const showToast = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])

  const handleCleanTextChange = useCallback((text: string) => {
    setCleanText(text)
  }, [])

  const handleRemoveAttachedText = useCallback((index: number) => {
    setAttachedTexts((cur) => cur.filter((_, i) => i !== index))
  }, [])

  const handleAddAttachedText = useCallback((name: string, content: string, path?: string) => {
    const lines = content.split('\n').length
    setAttachedTexts((cur) => [...cur, { name, lines, content, path }])
  }, [])

  const handlePasteLongText = useCallback((text: string) => {
    const existingCount = attachedTexts.filter((b) => b.name.startsWith('pasted_text')).length
    const fileName = existingCount === 0 ? 'pasted_text.txt' : `pasted_text_${existingCount + 1}.txt`
    handleAddAttachedText(fileName, text)
    const lines = text.split('\n').length
    showToast(t('condensedToAttachment', { lines }))
  }, [attachedTexts, handleAddAttachedText, showToast, t])

  // IDE context via the dsh.insert* commands: the extension host reads the
  // active editor and posts `ide-content`; failures surface as a toast,
  // successes append to the draft as an attached text block or code block.
  useEffect(() => {
    return onIdeContent((content) => {
      if (content.error !== undefined) {
        showToast(content.error)
        return
      }
      const fileName = content.path ? content.path.slice(content.path.lastIndexOf('/') + 1) : 'selection.txt'
      handleAddAttachedText(fileName, content.text, content.path)
    })
  }, [handleAddAttachedText, showToast])

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

  /** Intake from any source (picker / drop / paste): handle images and text files. */
  const intakeFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    const imageFiles: File[] = []
    const textFiles: File[] = []
    for (const f of files) {
      if (isTextFile(f)) {
        textFiles.push(f)
      } else {
        imageFiles.push(f)
      }
    }

    if (textFiles.length > 0) {
      for (const tf of textFiles) {
        try {
          const text = await tf.text()
          handleAddAttachedText(tf.name, text, tf.name)
          showToast(t('attachedFileSuccess', { name: tf.name }))
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err))
        }
      }
    }

    if (imageFiles.length > 0) {
      const rejected = validateImageBatch(imageFiles, attachments.length)
      if (rejected !== null) {
        showToast(rejected)
        return
      }
      try {
        const added = await Promise.all(imageFiles.map(fileToAttachment))
        setAttachments((cur) => [...cur, ...added])
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : String(err))
      }
    }
  }, [attachments.length, handleAddAttachedText, showToast, t])

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
      void intakeFiles([...(e.dataTransfer?.files ?? [])])
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

  // Esc interrupt, document-wide: with a running turn and no popup/menu/overlay
  // owning Escape, the key cancels the turn (same action as the stop button).
  // The textarea handles its own Escape (popup dismiss → cancel) and menus /
  // dialogs / inputs keep their own Escape semantics, so those targets skip.
  useEffect(() => {
    if (!running) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (overlayActive) return
      if (document.querySelector('.composer-suggest') !== null) return
      const target = e.target
      if (
        target instanceof Element &&
        target.closest('input, textarea, .composer-menu, .composer-dialog-backdrop, .model-select, .permission-select')
      ) {
        return
      }
      void cancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [running, overlayActive, cancel])

  const send = (): void => {
    if (!canSend) return
    const blocks = attachedTexts.map((b) => wrapAttachedText(b.name, b.content, b.path)).join('\n\n')
    const trimmedClean = cleanText.trim()
    const text = trimmedClean === '' ? blocks : (blocks !== '' ? `${trimmedClean}\n\n${blocks}` : trimmedClean)
    const sent = attachments
    for (const a of sent) {
      if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl)
    }
    setCleanText('')
    setAttachedTexts([])
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
      <SubagentDock />
      <TodoPanel todos={todos} />
      <GoalBar goal={goal} onEdit={editGoal} onPause={pauseGoal} onResume={resumeGoal} onClear={clearGoal} />
      <div className={`composer-card${dragActive ? ' drag-active' : ''}`} data-composer-card>
        <OverlayHost />
        {!overlayActive && (
          <>
            <AttachedTextRail items={attachedTexts} onRemove={handleRemoveAttachedText} />
            <AttachmentRail items={attachments} onRemove={removeAttachment} />
            <ComposerInput
              value={cleanText}
              onChange={handleCleanTextChange}
              onSend={send}
              onStop={() => void cancel()}
              running={running}
              disabled={false}
              sessionId={activeSessionId}
              onPasteFiles={(files) => void intakeFiles(files)}
              onPasteLongText={handlePasteLongText}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <button
                  type="button"
                  className="composer-chip composer-add"
                  data-composer-tool="attach"
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
                <button
                  type="button"
                  className={`composer-chip composer-add${ideContextEnabled ? ' composer-chip-active' : ''}`}
                  data-composer-tool="ide"
                  aria-label={ideContextEnabled ? '关闭 IDE 上下文注入' : '开启 IDE 上下文注入'}
                  title="IDE 上下文注入：发送时自动附加选中内容/当前文件（模型可见，对话里只显示提示）"
                  onClick={() => setIdeContextEnabled(!ideContextEnabled)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <PermissionSelect value={permissionMode} onChange={setPermissionMode} />
              </div>
              <div className="composer-trailing">
                <ModelSelect models={models} selected={selectedModel} onSelect={selectModel} />
                <ContextMeter />
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
    </section>
  )
}
