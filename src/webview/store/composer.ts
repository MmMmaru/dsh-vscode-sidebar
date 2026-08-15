/**
 * Composer slice (owned by W4). Prompt sending, queue state, model selection
 * and the permission-mode selector. Queue state arrives through session/queue
 * mux frames; the model catalog rides session.models.
 * Contract: ARCHITECTURE.md section 5.2.
 */

import type { StateCreator } from 'zustand'
import type { MessageId, SessionId } from '../../extension/protocol/brand'
import type { MuxFrame } from '../../extension/protocol/events'
import type { PromptContentPart, QueueAction } from '../../extension/protocol/sessions'
import type { SessionModels } from '../../extension/protocol/sessions'
import { rpc } from '../bridge'
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

  /** Send a prompt; without an active session one is created first (Codex-style). */
  sendPrompt: (text: string, attachments: Attachment[]) => Promise<void>
  /** Interrupt the current turn of the active session. */
  cancel: () => Promise<void>
  /** Change the model route; without a session the choice is stashed as pending. */
  selectModel: (provider: string, model: string, reasoningEffort?: string) => Promise<void>
  setPermissionMode: (mode: PermissionMode) => void
  /** Load the global model catalog (llm.models); session.models refines later. */
  loadGlobalModels: () => Promise<void>
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

export const createComposerSlice: StateCreator<AppStore, [], [], ComposerSlice> = (set, get) => ({
  queue: [],
  models: [],
  selectedModel: null,
  pendingModelSelection: null,
  permissionMode: 'workspace-write',

  sendPrompt: async (text, attachments) => {
    // Codex-style: typing before any session exists creates one on send.
    if (get().activeSessionId === null) await get().newChat()
    const sessionId = get().activeSessionId
    if (sessionId === null) throw new Error('no active session')
    const content: PromptContentPart[] = [
      { type: 'text', text },
      ...attachments.map((a): PromptContentPart => ({ type: 'image', mediaType: a.mediaType, data: a.data, name: a.name })),
    ]
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
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

  setPermissionMode: (mode) => set({ permissionMode: mode }),

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
