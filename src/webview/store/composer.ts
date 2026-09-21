/**
 * Composer slice (owned by W4). Prompt sending, queue state, model selection
 * and the permission-mode selector.
 * Contract: ARCHITECTURE.md section 5.2.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the queue no longer arrives as
 * `session/queue` mux frames and the model catalog no longer comes from the
 * retired `llm.models` / `session.models` pair. Both are now Host-wide:
 *   - `session/control` (stream) carries every session's queue, its
 *     `modelSelection` projection, and the generation's baseline of both;
 *   - `session/modelCatalog` (unary) answers the Host's routable model groups
 *     and its configured default route (the retired `host.describe` source).
 */

import type { StateCreator } from 'zustand'
import type { MessageId, SessionId } from '../../extension/protocol/brand'
import type { SessionControlFrame, SessionProjectionBaseline, SessionQueuedItem } from '../../extension/protocol/follow'
import type { CommandAttachment, CommandExecutionView } from '../../extension/protocol/rpc-map'
import type {
  ModelSelection,
  ModelSelectionProjection,
  PromptContentPart,
  QueueAction,
  SessionModelCatalog,
} from '../../extension/protocol/sessions'
import { assemblePromptText, parseUserMessage, wrapAttachedText } from '../../shared/attached-text'
import { fetchIdeContent, rpc } from '../bridge'
import { hasIdeBlock } from '../ide-insert'
import type { Attachment, ModelInfo, PermissionMode, QueuedMessage } from '../types'
import type { AppStore } from './index'

/** State + actions owned by the composer workflow. */
export interface ComposerSlice {
  /** Pending inbox snapshot of the ACTIVE session (control `queue` frames). */
  queue: QueuedMessage[]
  /**
   * Host-wide queue mirror, keyed by session. Kept because the control baseline
   * is delivered once per generation: switching to a session after it arrived
   * must not show the previous session's dock.
   */
  queueBySession: Record<string, QueuedMessage[]>
  /** Flattened selectable models across provider groups. */
  models: ModelInfo[]
  /** Current model selection of the active session (provider + model + effort). */
  selectedModel: ModelSelection | null
  /** Host-wide `modelSelection` projection mirror, keyed by session. */
  modelSelectionBySession: Record<string, ModelSelectionProjection>
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
  /** Load the Host-wide model catalog (`session/modelCatalog`). */
  loadGlobalModels: () => Promise<void>
  /**
   * Preselect the Host's configured default route (the retired `host.describe`
   * echoed the same route) so the chip is filled before any session exists.
   */
  loadDefaultModel: () => Promise<void>
  /** Load the model catalog + the session's current `modelSelection` route. */
  loadModels: (sessionId: SessionId) => Promise<void>
  /** Adopt the queue mirror of a newly selected session. */
  syncQueue: (sessionId: SessionId) => void
  /** Mutate one pending queue item (edit / remove / steer). */
  updateQueueItem: (itemId: MessageId, action: QueueAction) => Promise<void>
  /**
   * Control-frame handler. The queue mirror and the `modelSelection` mirror are
   * generation-scoped: the first frame of every generation is a baseline holding
   * BOTH maps in full, so it replaces them wholesale; `queue` / `projection`
   * frames after it are per-session deltas. Job frames belong to the
   * conversation slice and are ignored here.
   */
  applyQueueFrame: (frame: SessionControlFrame) => void
}

/** Human-readable text of an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Narrow one model selection (`{provider, model, reasoningEffort?}`). */
function toModelSelection(value: unknown): ModelSelection | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const model = record['model']
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  const reasoningEffort = record['reasoningEffort']
  return {
    provider,
    model,
    ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
  }
}

/**
 * Narrow one `modelSelection` projection value.
 * @param value - the projection value (`unknown` on the wire).
 * @returns the recorded pair, or null when the value is not a model selection.
 */
function toModelSelectionProjection(value: unknown): ModelSelectionProjection | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const lastUsed = record['lastUsed']
  const next = record['next']
  // Both slots optional-null, but the pair itself must be present.
  if (lastUsed === undefined && next === undefined) return null
  return {
    lastUsed: toModelSelection(lastUsed),
    next: toModelSelection(next),
  }
}

/** The route a session will use next: the pending choice, else the last used. */
function currentOfSelection(selection: ModelSelectionProjection): ModelSelection | null {
  return selection.next ?? selection.lastUsed
}

/** Read every session's `modelSelection` value out of a control baseline cut. */
function toSelectionMirror(baseline: Record<string, SessionProjectionBaseline>): Record<string, ModelSelectionProjection> {
  const mirror: Record<string, ModelSelectionProjection> = {}
  for (const [sessionId, values] of Object.entries(baseline)) {
    const selection = toModelSelectionProjection(values.values['modelSelection'])
    if (selection !== null) mirror[sessionId] = selection
  }
  return mirror
}

/** Flatten one provider-group catalog into the picker's selectable models. */
function toModelInfos(catalog: SessionModelCatalog): ModelInfo[] {
  return catalog.groups.flatMap((group) =>
    group.models.map((m) => ({
      provider: group.id,
      providerName: group.name,
      id: m.id,
      name: m.name,
      description: m.description,
      reasoning: m.reasoning,
    })),
  )
}

/**
 * Flatten one queue item's content blocks into a single-line preview.
 * @param content - the pending message's content (`unknown` on the wire).
 * @returns the joined text of every renderable block.
 */
function toPreviewText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
      if (record['type'] === 'image') {
        const attachment = record['attachment']
        const name = typeof attachment === 'object' && attachment !== null
          ? (attachment as Record<string, unknown>)['name']
          : undefined
        return typeof name === 'string' ? name : '[image]'
      }
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/** Flatten one control queue item into the dock's view model. */
function toQueuedMessage(item: SessionQueuedItem): QueuedMessage {
  const content = Array.isArray(item.message.content) ? item.message.content : []
  return {
    id: item.id as MessageId,
    placement: item.placement,
    text: toPreviewText(item.message.content),
    // The wire promises only `{id, content}` for a pending message: role and
    // source are not sent, which QueuedMessage.message now reflects exactly.
    message: { id: item.message.id as MessageId, content },
  }
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

export const createComposerSlice: StateCreator<AppStore, [], [], ComposerSlice> = (set, get) => {
  /**
   * Publish a freshly computed queue mirror and re-derive the ACTIVE session's
   * dock rows from it, so the dock can never show another session's items.
   * @param mirror - the new mirror, keyed by session.
   */
  const publishQueues = (mirror: Record<string, QueuedMessage[]>): void => {
    const active = get().activeSessionId
    set({ queueBySession: mirror, queue: active === null ? [] : mirror[active] ?? [] })
  }

  /**
   * Publish a freshly computed model-selection mirror and, when the active
   * session is covered by it, adopt that route in the picker.
   * @param mirror - the new mirror, keyed by session.
   */
  const publishSelections = (mirror: Record<string, ModelSelectionProjection>): void => {
    const active = get().activeSessionId
    const selection = active === null ? undefined : mirror[active]
    set({
      modelSelectionBySession: mirror,
      ...(selection === undefined ? {} : { selectedModel: currentOfSelection(selection) }),
    })
  }

  return {
    queue: [],
    queueBySession: {},
    models: [],
    selectedModel: null,
    modelSelectionBySession: {},
    pendingModelSelection: null,
    permissionMode: 'workspace-write',
    ideContextEnabled: readIdeContextEnabled(),

    sendPrompt: async (text, attachments) => {
      // Codex-style: typing before any session exists creates one on send.
      if (get().activeSessionId === null) await get().newChat()
      const sessionId = get().activeSessionId
      if (sessionId === null) throw new Error('no active session')

      // Slash commands: one line starting with `/` is executed by the Host's
      // command registry before it can become a prompt. `undefined` means no
      // command claimed the line, so it falls through as an ordinary prompt.
      const trimmed = text.trim()
      if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
        // The descriptor's wire name is `submittedAttachments` (the retired
        // client sent `images`, which the host rejects outright).
        const submittedAttachments: CommandAttachment[] = attachments.map((a) => ({
          type: 'image',
          mediaType: a.mediaType,
          data: a.data,
          name: a.name,
        }))

        try {
          const execution = await rpc<CommandExecutionView | undefined>('commands/execute', {
            agentId: sessionId,
            line: trimmed,
            submittedAttachments,
          })

          // The Host recognized and executed the slash command.
          if (execution !== undefined) {
            if (execution.result.kind === 'error' && execution.result.text !== undefined) {
              get().appendError(execution.result.text)
            }
            return
          }
        } catch (error) {
          // The command surface is part of the protocol now, so a failure here
          // is a real failure: the old "guess an old host from the error string"
          // compatibility shims are gone and the reason is surfaced instead of
          // being dropped on the floor.
          get().appendError(`斜杠命令执行失败：${errorText(error)}`)
          return
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
      await rpc('session/prompt', {
        request: {
          // Client-minted and required in 0.1.5-rc.2: the host echoes it on the
          // queue/command events standing for this submission.
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })
      // Sending a prompt makes its session the most recent one: bump and re-sort
      // immediately (the user/message event confirms with the host time later).
      get().touchSession(sessionId, Date.now())
    },

    cancel: async () => {
      const sessionId = get().activeSessionId
      if (sessionId === null) return
      await rpc('session/cancel', { request: { sessionId } })
    },

    selectModel: async (provider, model, reasoningEffort) => {
      const sessionId = get().activeSessionId
      if (sessionId === null) {
        // No session yet: stash the choice; newChat applies it after create.
        set({ pendingModelSelection: { provider, model, reasoningEffort }, selectedModel: { provider, model, reasoningEffort } })
        return
      }
      const { selected } = await rpc<{ selected: ModelSelection }>('session/selectModel', {
        request: { sessionId, provider, model, reasoningEffort },
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
      // Host-wide catalog: it no longer needs an active session to be useful.
      const catalog = await rpc<SessionModelCatalog>('session/modelCatalog', {})
      set({ models: toModelInfos(catalog) })
    },

    loadDefaultModel: async () => {
      const catalog = await rpc<SessionModelCatalog>('session/modelCatalog', {})
      // Never override a choice the user already made this run.
      if (get().selectedModel !== null || get().pendingModelSelection !== null) return
      set({ selectedModel: catalog.default })
    },

    loadModels: async (sessionId) => {
      const catalog = await rpc<SessionModelCatalog>('session/modelCatalog', {})
      // The per-session route is no longer a unary answer: it is the session's
      // `modelSelection` projection, so it comes from the control mirror and
      // falls back to the host default when the session recorded none.
      const selection = get().modelSelectionBySession[sessionId]
      const selectedModel = selection === undefined ? catalog.default : (currentOfSelection(selection) ?? catalog.default)
      set({ models: toModelInfos(catalog), selectedModel })
    },

    syncQueue: (sessionId) => {
      set({ queue: get().queueBySession[sessionId] ?? [] })
    },

    updateQueueItem: async (itemId, action) => {
      const sessionId = get().activeSessionId
      if (sessionId === null) return
      await rpc('session/updateQueue', { request: { sessionId, itemId, action } })
      // The authoritative session/control `queue` frame refreshes `queue`.
    },

    applyQueueFrame: (frame) => {
      switch (frame.type) {
        // GENERATION BOUNDARY: every generation of the control stream opens with
        // exactly one baseline carrying the COMPLETE queue, job and projection
        // maps. It is a full replacement, not a delta — merging it into a
        // previous generation's mirror would keep items the host already
        // dropped (and the old generation's model selections alive).
        case 'baseline': {
          const mirror: Record<string, QueuedMessage[]> = {}
          for (const [sessionId, items] of Object.entries(frame.value.queues)) {
            mirror[sessionId] = items.map(toQueuedMessage)
          }
          const selections = toSelectionMirror(frame.value.projections)
          const active = get().activeSessionId
          set({
            queueBySession: mirror,
            modelSelectionBySession: selections,
            queue: active === null ? [] : mirror[active] ?? [],
            ...(active === null || selections[active] === undefined
              ? {}
              : { selectedModel: currentOfSelection(selections[active]) }),
          })
          break
        }
        // Delta: this session's queue changed; the frame is the complete new list
        // for that session, so it replaces that session's mirror entry.
        case 'queue': {
          const mirror = { ...get().queueBySession, [frame.sessionId]: frame.items.map(toQueuedMessage) }
          publishQueues(mirror)
          break
        }
        // Delta: one projection value. Only the model route is this slice's.
        case 'projection': {
          if (frame.key !== 'modelSelection') break
          const selection = toModelSelectionProjection(frame.value)
          if (selection === null) {
            console.warn(`[dsh] modelSelection 投影值形状不符合协议，已忽略（${JSON.stringify(frame.value)}）`)
            break
          }
          publishSelections({ ...get().modelSelectionBySession, [frame.sessionId]: selection })
          break
        }
        // Background jobs are the conversation slice's concern (`activeJobs`).
        case 'jobs':
          break
      }
    },
  }
}
