/**
 * Composer slice (owned by W4). Prompt sending, queue state, model selection
 * and the permission-mode selector. Queue state arrives through session/queue
 * mux frames; the model catalog rides session.models.
 * Contract: ARCHITECTURE.md section 5.2.
 */

import type { StateCreator } from 'zustand'
import type { MessageId, SessionId } from '../../extension/protocol/brand'
import type { MuxFrame } from '../../extension/protocol/events'
import type { HostDescription } from '../../extension/protocol/host'
import type { PromptContentPart, QueueAction } from '../../extension/protocol/sessions'
import type { SessionModels } from '../../extension/protocol/sessions'
import { assemblePromptText, parseUserMessage, wrapAttachedText } from '../../shared/attached-text'
import { fetchIdeContent, rpc } from '../bridge'
import { formatIdeInsert, hasIdeBlock } from '../ide-insert'
import type { Attachment, ModelInfo, PermissionMode, QueuedMessage } from '../types'
import type { AppStore } from './index'

/** State + actions owned by the composer workflow. */
export interface ComposerSlice {
  /** Pending inbox snapshot of the active session (session/queue frames). */
  queue: QueuedMessage[]
  /** Flattened selectable models across provider groups. */
  models: ModelInfo[]
  /** Current model selection of the active session (provider + model + effort). */
  selectedModel: SessionModels['current'] | null
  /** Model chosen before any session exists; applied on the next session create. */
  pendingModelSelection: { provider: string; model: string; reasoningEffort?: string } | null
  /** Permission-mode selector value (UI-owned; see types.ts). */
  permissionMode: PermissionMode
  /** Whether send-time IDE context injection is enabled (toggle chip). */
  ideContextEnabled: boolean

  /** Send a prompt; without an active session one is created first (Codex-style). */
  sendPrompt: (text: string, attachments: Attachment[]) => Promise<void>
  /** Interrupt the current turn of the active session. */
  cancel: () => Promise<void>
  /** Change the model route; without a session the choice is stashed as pending. */
  selectModel: (provider: string, model: string, reasoningEffort?: string) => Promise<void>
  setPermissionMode: (mode: PermissionMode) => void
  /** Toggle send-time IDE context injection (persisted in localStorage). */
  setIdeContextEnabled: (enabled: boolean) => void
  /** Load the global model catalog (llm.models); session.models refines later. */
  loadGlobalModels: () => Promise<void>
  /**
   * Preselect the saved deployment default (host.describe echoes the last
   * selected model) so the chip is filled before any session exists.
   */
  loadDefaultModel: () => Promise<void>
  /** Load the model catalog + current selection of a session. */
  loadModels: (sessionId: SessionId) => Promise<void>
  /** Mutate one pending queue item (edit / remove / steer). */
  updateQueueItem: (itemId: MessageId, action: QueueAction) => Promise<void>
  /** Queue-frame handler: session/queue snapshots replace `queue` wholesale. */
  applyQueueFrame: (frame: MuxFrame) => void
}

/** Flatten one session/queue snapshot item into a QueuedMessage. */
function toQueuedMessage(item: { id: MessageId; placement: QueuedMessage['placement']; message: QueuedMessage['message'] }): QueuedMessage {
  const text = item.message.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? (b.attachment.name ?? '[image]') : ''))
    .filter((t) => t !== '')
    .join('\n')
  return { id: item.id, placement: item.placement, text, message: item.message }
}

/**
 * Send-time IDE context enrichment: when the active editor holds a non-empty
 * selection, the selection is appended as a formatted code block; with no
 * selection the ACTIVE FILE PATH is attached as lightweight context (the
 * model can read the file itself with tools). Skipped when the draft already
 * carries an inserted IDE block. Best-effort — any failure (no editor,
 * timeout) silently leaves the prompt untouched.
 * @param text - the draft text.
 * @param enabled - whether send-time IDE context is toggled on.
 * @param lang - UI language for fallback phrasing.
 * @returns the prompt text, enriched when editor context is available.
 */
async function enrichWithIdeContext(text: string, enabled: boolean, lang: 'zh' | 'en' = 'zh'): Promise<string> {
  if (hasIdeBlock(text)) {
    const parsed = parseUserMessage(text)
    if (parsed.cleanText.trim() === '' && parsed.attachedTexts.length > 0) {
      const first = parsed.attachedTexts[0]
      if (first !== undefined) {
        const prefix = lang === 'en'
          ? `Please analyze ${first.name}:`
          : `请分析 ${first.name}：`
        return `${prefix}\n\n${text.trim()}`
      }
    }
    return text
  }

  if (!enabled) return text
  let content
  try {
    content = await fetchIdeContent('selection')
  } catch {
    return text
  }
  if (content.error !== undefined) return text
  if (content.fromSelection === true && content.text.trim() !== '') {
    const fileName = content.path ? (content.path.slice(content.path.lastIndexOf('/') + 1) || 'selection.txt') : 'selection.txt'
    const block = wrapAttachedText(fileName, content.text, content.path)
    if (text.trim() === '') {
      const prefix = lang === 'en'
        ? `Please analyze the selected code from ${fileName}:`
        : `请分析来自 ${fileName} 的选中代码：`
      return `${prefix}\n\n${block}`
    }
    return `${text.trim()}\n\n${block}`
  }
  // No selection: the payload still carries the active file path (the
  // 'selection' kind falls back to the whole document); attach only the path.
  if (content.path !== undefined) {
    const fileName = content.path.slice(content.path.lastIndexOf('/') + 1) || 'file.txt'
    const block = wrapAttachedText(fileName, `### ${lang === 'en' ? 'Current file' : '当前文件'}：${content.path}`, content.path)
    if (text.trim() === '') {
      const prefix = lang === 'en'
        ? `Please check the current file ${fileName}:`
        : `请查看当前文件 ${fileName}：`
      return `${prefix}\n\n${block}`
    }
    return `${text.trim()}\n\n${block}`
  }
  return text
}

/** localStorage key of the send-time IDE-context toggle (survives webview
 * recreation — the sidebar webview is destroyed on hide). */
const IDE_CONTEXT_KEY = 'dsh.settings.ideContextEnabled'

/** Read the persisted toggle; absent/unreadable means enabled (default). */
function readIdeContextEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    const raw = localStorage.getItem(IDE_CONTEXT_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

/** Persist the toggle; guarded for non-DOM hosts (node verification). */
function writeIdeContextEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(IDE_CONTEXT_KEY, enabled ? '1' : '0')
  } catch {
    // Storage unavailable: the in-memory value still applies this session.
  }
}

export const createComposerSlice: StateCreator<AppStore, [], [], ComposerSlice> = (set, get) => ({
  queue: [],
  models: [],
  selectedModel: null,
  pendingModelSelection: null,
  permissionMode: 'workspace-write',
  ideContextEnabled: readIdeContextEnabled(),

  sendPrompt: async (text, attachments) => {
    // Codex-style: typing before any session exists creates one on send.
    if (get().activeSessionId === null) await get().newChat()
    const sessionId = get().activeSessionId
    if (sessionId === null) throw new Error('no active session')

    // Slash commands: if the message is a single line starting with `/`,
    // execute it via commands/execute RPC directly on the host!
    const trimmed = text.trim()
    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      const encodedImages = attachments.map((a) => ({
        mediaType: a.mediaType,
        data: a.data,
        name: a.name,
      }))

      try {
        const execResult = await rpc<{ commandId?: string; result?: { kind: 'success' | 'error'; text?: string } } | undefined>(
          'commands/execute',
          { args: { agentId: sessionId, line: trimmed, images: encodedImages } },
        )

        // If execResult is defined, the host recognized and executed the slash command.
        if (execResult !== undefined && execResult !== null) {
          if (execResult.result?.kind === 'error' && execResult.result.text) {
            get().appendError(execResult.result.text)
          }
          return
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // If it was a real RPC execution error from the command, report it.
        if (
          !errMsg.includes('unknown') &&
          !errMsg.includes('unhandled rpc') &&
          !errMsg.includes('no active Remote method') &&
          !errMsg.includes('definition-unavailable') &&
          !errMsg.includes('not found')
        ) {
          get().appendError(errMsg)
          return
        }
      }
    }

    // A prompt whose content is exactly one text block starting with `/` is a
    // slash command the HOST executes (goal/compact/plan...); IDE context must
    // not be appended or the host rejects it as an unknown command.
    const lang = get().uiPrefs.language ?? 'zh'
    const enriched = text.startsWith('/')
      ? text
      : await enrichWithIdeContext(text, get().ideContextEnabled, lang)

    // The VS Code environment guide is deferred to prompts AFTER the session's
    // first one: the host derives the session title from the FIRST human
    // message, and a first message polluted with the guide (its reordered
    // "user-first" form included) still leaks plugin context into titles.
    const hasPriorUserMessage = get().nodes.some((n) => n.kind === 'user-message')
    const prompt = assemblePromptText(enriched, hasPriorUserMessage, text.startsWith('/'))

    const content: PromptContentPart[] = [
      { type: 'text', text: prompt },
      ...attachments.map((a): PromptContentPart => ({ type: 'image', mediaType: a.mediaType, data: a.data, name: a.name })),
    ]
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    // Sending a prompt makes its session the most recent one: bump and re-sort
    // immediately (the user/message event confirms with the host time later).
    get().touchSession(sessionId, Date.now())
  },

  cancel: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    await rpc('session.cancel', { sessionId })
  },

  selectModel: async (provider, model, reasoningEffort) => {
    const sessionId = get().activeSessionId
    if (sessionId === null) {
      // No session yet: stash the choice; newChat applies it after create.
      set({ pendingModelSelection: { provider, model, reasoningEffort }, selectedModel: { provider, model, reasoningEffort } })
      return
    }
    const { selected } = await rpc<{ selected: SessionModels['current'] }>('session.selectModel', {
      sessionId,
      provider,
      model,
      reasoningEffort,
    })
    set({ selectedModel: selected })
  },

  setPermissionMode: (mode) => {
    set({ permissionMode: mode })
    void get().setUiPref('permissionMode', mode).catch(() => undefined)
  },

  setIdeContextEnabled: (enabled) => {
    writeIdeContextEnabled(enabled)
    set({ ideContextEnabled: enabled })
  },

  loadGlobalModels: async () => {
    const catalog = await rpc<{ groups: SessionModels['groups'] }>('llm.models', {})
    const models: ModelInfo[] = catalog.groups.flatMap((group) =>
      group.models.map((m) => ({
        provider: group.id,
        providerName: group.name,
        id: m.id,
        name: m.name,
        description: m.description,
        reasoning: m.reasoning,
      })),
    )
    // Global catalog fills the selector only until a session refines it.
    if (get().activeSessionId === null) set({ models })
  },

  loadDefaultModel: async () => {
    const desc = await rpc<HostDescription>('host.describe', {})
    if (desc.provider === undefined || desc.model === undefined) return
    // Never override a choice the user already made this run.
    if (get().selectedModel !== null || get().pendingModelSelection !== null) return
    set({ selectedModel: { provider: desc.provider, model: desc.model } })
  },

  loadModels: async (sessionId) => {
    const catalog = await rpc<SessionModels>('session.models', { sessionId })
    const models: ModelInfo[] = catalog.groups.flatMap((group) =>
      group.models.map((m) => ({
        provider: group.id,
        providerName: group.name,
        id: m.id,
        name: m.name,
        description: m.description,
        reasoning: m.reasoning,
      })),
    )
    set({ models, selectedModel: catalog.current })
  },

  updateQueueItem: async (itemId, action) => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    await rpc('session.updateQueue', { sessionId, itemId, action })
    // The authoritative session/queue frame refreshes `queue`.
  },

  applyQueueFrame: (frame) => {
    if (frame.type !== 'session/queue') return
    if (frame.sessionId !== get().activeSessionId) return
    set({ queue: frame.items.map(toQueuedMessage) })
  },
})
