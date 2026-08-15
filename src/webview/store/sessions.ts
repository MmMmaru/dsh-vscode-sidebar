/**
 * Sessions slice (owned by W2). Session list state plus its actions; the
 * selectSession orchestration also drives history/model loading on the other
 * slices through the combined store's get().
 * Contract: ARCHITECTURE.md section 5.2.
 */

import type { StateCreator } from 'zustand'
import type { SessionId, WorkspaceId } from '../../extension/protocol/brand'
import type { HostFrame, MuxFrame } from '../../extension/protocol/events'
import type { WorkspaceView } from '../../extension/protocol/views'
import { rpc } from '../bridge'
import type { SessionMeta } from '../types'
import type { AppStore } from './index'

/** State + actions owned by the chat-list workflow. */
export interface SessionsSlice {
  /** Session list for the current workspace (cwd-filtered at init). */
  sessions: SessionMeta[]
  activeSessionId: SessionId | null

  /** Install the init payload's list, keeping only rows for `cwd` (or cwd-less). */
  initSessions: (all: SessionMeta[], cwd: string) => void
  /** Select a session: load its history, models and queue snapshot. */
  selectSession: (id: SessionId) => Promise<void>
  /** Create a blank session and select it. */
  newChat: () => Promise<void>
  renameSession: (id: SessionId, title: string) => Promise<void>
  /**
   * Remove a session from the workspace. The dsh RPC surface has no delete;
   * archiving is the destructive operation (ARCHITECTURE.md section 5.2 note).
   */
  deleteSession: (id: SessionId) => Promise<void>
  /** Fork a session, optionally at a specific event seq (protocol: session.fork atSeq). */
  forkSession: (id: SessionId, atSeq?: number) => Promise<void>
  /** Host-frame handler: keeps the list in sync with host stream pushes. */
  applyHostFrame: (frame: HostFrame) => void
  /** Projection-frame handler: title updates ride session/projection mux frames. */
  applyProjectionFrame: (frame: MuxFrame) => void
}

export const createSessionsSlice: StateCreator<AppStore, [], [], SessionsSlice> = (set, get) => ({
  sessions: [],
  activeSessionId: null,

  initSessions: (all, cwd) => {
    const visible = all.filter((s) => s.cwd === undefined || s.cwd === cwd)
    visible.sort((a, b) => b.updatedAt - a.updatedAt)
    set({ sessions: visible })
  },

  selectSession: async (id) => {
    // Selecting a session marks it read (clears the blue unread dot) — even
    // when it is already the active one, so a finished turn can be acked.
    const markRead = get().sessions.map((s) => (s.sessionId === id ? { ...s, unread: false } : s))
    if (get().activeSessionId === id) {
      set({ sessions: markRead })
      return
    }
    set({ activeSessionId: id, sessions: markRead })
    get().clearConversation()
    get().clearOverlay()
    await Promise.all([get().loadHistory(id), get().loadModels(id)])
  },

  newChat: async () => {
    // Group the session under the per-root workspace so the dsh web UI can
    // manage it. workspace.create is idempotent per canonical path; if the
    // host predates workspaces, fall back to a plain cwd-scoped create.
    const cwd = get().cwd
    let payload: { workspaceId: WorkspaceId } | { cwd: string }
    try {
      const { workspace } = await rpc<{ workspace: WorkspaceView; created: boolean }>('workspace.create', { path: cwd })
      payload = { workspaceId: workspace.workspaceId }
    } catch {
      payload = { cwd }
    }
    const { sessionId } = await rpc<{ sessionId: SessionId }>('session.create', payload)
    // The host/session-added frame also inserts the row; applyHostFrame dedupes.
    await get().selectSession(sessionId)
    // A model chosen before the session existed is applied now.
    const pending = get().pendingModelSelection
    if (pending !== null) {
      set({ pendingModelSelection: null })
      await get().selectModel(pending.provider, pending.model, pending.reasoningEffort)
    }
  },

  renameSession: async (id, title) => {
    await rpc('session.rename', { sessionId: id, title })
    set({ sessions: get().sessions.map((s) => (s.sessionId === id ? { ...s, title } : s)) })
  },

  deleteSession: async (id) => {
    await rpc('workspace.archiveSession', { sessionId: id })
    set({ sessions: get().sessions.filter((s) => s.sessionId !== id) })
    if (get().activeSessionId === id) set({ activeSessionId: null })
  },

  forkSession: async (id, atSeq) => {
    const { sessionId } = await rpc<{ sessionId: SessionId }>('session.fork', { sessionId: id, atSeq })
    await get().selectSession(sessionId)
  },

  applyHostFrame: (frame) => {
    switch (frame.type) {
      case 'host/session-added': {
        if (get().sessions.some((s) => s.sessionId === frame.sessionId)) return
        const meta: SessionMeta = {
          sessionId: frame.sessionId,
          title: null,
          updatedAt: Date.now(),
          running: false,
          blank: frame.blank,
          parentSessionId: frame.parentSessionId,
          origin: frame.origin,
          cwd: frame.cwd,
        }
        set({ sessions: [meta, ...get().sessions] })
        break
      }
      case 'host/session-removed':
        set({ sessions: get().sessions.filter((s) => s.sessionId !== frame.sessionId) })
        break
      case 'host/session-status': {
        // A running -> idle transition marks the session unread (blue dot),
        // including the active one — it clears when the user selects it again.
        const ended =
          !frame.running &&
          get().sessions.some((s) => s.sessionId === frame.sessionId && s.running)
        set({
          sessions: get().sessions.map((s) =>
            s.sessionId === frame.sessionId
              ? { ...s, running: frame.running, ...(ended ? { unread: true } : {}) }
              : s),
        })
        break
      }
      case 'host/archived-sessions-changed': {
        const gone = new Set(frame.archivedSessionIds)
        set({ sessions: get().sessions.filter((s) => !gone.has(s.sessionId)) })
        break
      }
      case 'host/agent-error':
        if (frame.sessionId === get().activeSessionId) get().appendError(frame.message)
        break
      default:
        break
    }
  },

  applyProjectionFrame: (frame) => {
    // Any live turn ending marks the session unread (blue dot), including the
    // active one; selecting the session clears it. History pages arrive via
    // RPC, not the event stream, so old turns never hit this.
    if (frame.type === 'session/event' && frame.event.type === 'turn/end') {
      set({
        sessions: get().sessions.map((s) =>
          s.sessionId === frame.sessionId ? { ...s, unread: true } : s),
      })
      return
    }
    if (frame.type !== 'session/projection') return
    if (frame.key === 'title' && typeof frame.value === 'string') {
      set({
        sessions: get().sessions.map((s) =>
          s.sessionId === frame.sessionId ? { ...s, title: frame.value as string } : s),
      })
    }
  },
})
