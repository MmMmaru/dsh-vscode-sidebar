/**
 * Sessions slice (owned by W2). Session list state plus its actions; the
 * selectSession orchestration also drives history/model loading on the other
 * slices through the combined store's get().
 * Contract: ARCHITECTURE.md section 5.2.
 */

import type { StateCreator } from 'zustand'
import type { SessionId } from '../../extension/protocol/brand'
import type { HostFrame, MuxFrame } from '../../extension/protocol/events'
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
    if (get().activeSessionId === id) return
    set({ activeSessionId: id })
    get().clearConversation()
    get().clearOverlay()
    await Promise.all([get().loadHistory(id), get().loadModels(id)])
  },

  newChat: async () => {
    const { sessionId } = await rpc<{ sessionId: SessionId }>('session.create', { cwd: get().cwd })
    // The host/session-added frame also inserts the row; applyHostFrame dedupes.
    await get().selectSession(sessionId)
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
      case 'host/session-status':
        set({
          sessions: get().sessions.map((s) =>
            s.sessionId === frame.sessionId ? { ...s, running: frame.running } : s),
        })
        break
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
    if (frame.type !== 'session/projection') return
    if (frame.key === 'title' && typeof frame.value === 'string') {
      set({
        sessions: get().sessions.map((s) =>
          s.sessionId === frame.sessionId ? { ...s, title: frame.value as string } : s),
      })
    }
  },
})
