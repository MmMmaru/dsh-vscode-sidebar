/**
 * Sessions slice (owned by W2). Session list state plus its actions; the
 * selectSession orchestration also drives the other slices (queue mirror, model
 * catalog, overlay, journal subscription) through the combined store's get().
 * Contract: ARCHITECTURE.md section 5.2.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): the two retired handlers —
 * `applyHostFrame` (fed by the old host socket) and `applyProjectionFrame` (fed
 * by the old mux socket) — are replaced by three channel handlers:
 *   control   -> applyControlFrame    Host-wide `session/control` projections
 *   workspace -> applyWorkspaceFrame  `workspace/follow` archived set
 *   remote    -> applyRemoteEvent     sparse `$events` broadcasts
 * Both streams are generation-scoped: after any carrier loss the stream reopens
 * and its FIRST frame is a complete baseline, never a delta (see the handlers).
 * The session journal is no longer broadcast either: it is a per-session
 * `session/follow` subscription owned by the conversation slice, so the list is
 * kept fresh by the two streams above plus the `api-session/*` broadcasts.
 */

import type { StateCreator } from 'zustand'
import type { SessionId, WorkspaceId } from '../../extension/protocol/brand'
import type { SessionControlFrame } from '../../extension/protocol/follow'
import type { SessionProjectionsBlock, SessionSummary } from '../../extension/protocol/sessions'
import type { WorkspaceView } from '../../extension/protocol/views'
import type { WorkspaceFollowFrame } from '../../extension/protocol/workspace'
import { rpc } from '../bridge'
import type { SessionMeta } from '../types'
import type { AppStore } from './index'

/** State + actions owned by the chat-list workflow. */
export interface SessionsSlice {
  /** Session list for the current workspace (cwd-filtered at init). */
  sessions: SessionMeta[]
  activeSessionId: SessionId | null
  /**
   * Session ids the workspace stream reports as archived. Archived rows are
   * hidden from the list; the set is kept because the workspace baseline can
   * arrive before (or after) the init payload's rows.
   */
  archivedSessionIds: SessionId[]

  /** Install the init payload's list, keeping only rows for `cwd` (or cwd-less). */
  initSessions: (all: SessionMeta[], cwd: string) => void
  /**
   * Select a session: adopt its queue mirror, load its model catalog entry and
   * become the address the `session/follow` journal is subscribed to.
   */
  selectSession: (id: SessionId) => Promise<void>
  /** Create a blank session and select it; a still-blank active session is reused. */
  newChat: () => Promise<void>
  renameSession: (id: SessionId, title: string) => Promise<void>
  /**
   * Remove a session from the workspace. The dsh RPC surface has no delete;
   * archiving is the destructive operation (ARCHITECTURE.md section 5.2 note).
   */
  deleteSession: (id: SessionId) => Promise<void>
  /** Fork a session, optionally at a specific event seq (protocol: session/fork atSeq). */
  forkSession: (id: SessionId, atSeq?: number) => Promise<void>
  /** Bump a session's updatedAt and move it to the top of the list. */
  touchSession: (id: SessionId, at?: number) => void
  /**
   * Control-frame handler: the Host-wide `session/control` stream carries every
   * session's projection values (this slice only needs `title` and
   * `sessionListMetadata`; queue and job frames belong to other slices).
   */
  applyControlFrame: (frame: SessionControlFrame) => void
  /** Workspace-frame handler: `workspace/follow` owns the archived session set. */
  applyWorkspaceFrame: (frame: WorkspaceFollowFrame) => void
  /**
   * Broadcast-event handler for the sparse `$events` emits this slice needs
   * (`api-session/added|removed|status|activity|error`); every other event is
   * ignored, because `$events` is a hint feed, not a state feed.
   */
  applyRemoteEvent: (event: string, args: unknown[]) => void
}

/**
 * Read the `title` projection value.
 * @param value - the projection value (`unknown` on the wire).
 * @returns the title, `null` for an explicit "no title", or undefined when the
 * value is not a title at all (leave the row untouched).
 */
function readTitleValue(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  return undefined
}

/**
 * Read the `blank` bit of the `sessionListMetadata` projection value.
 * @param value - the projection value (`unknown` on the wire).
 * @returns the bit, or undefined when the value is not that projection.
 */
function readBlankValue(value: unknown): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const blank = (value as Record<string, unknown>)['blank']
  return typeof blank === 'boolean' ? blank : undefined
}

/**
 * Index one projection-values bag without trusting its wire shape.
 * @param values - the `values` bag of a projection baseline/block.
 * @param key - projection key to read.
 * @returns the raw value, or undefined when the bag does not hold it.
 */
function readProjectionValue(values: unknown, key: string): unknown {
  if (typeof values !== 'object' || values === null) return undefined
  return (values as Record<string, unknown>)[key]
}

/** Read an optional string field from an untyped wire object. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Recompute one row from a generation's projection CUT (the control baseline).
 *
 * The cut is complete for every session the host knows, so a key it omits means
 * the projection unit is not mounted: `title` has a `null` state and is therefore
 * recomputed even to null. `blank` is not nullable, so an omitted metadata value
 * keeps the row's last known bit instead of inventing one.
 * @param row - the row being recomputed.
 * @param values - that session's values in the cut, or undefined when the cut
 * does not mention the session at all.
 * @returns the recomputed row, or the SAME object when nothing changed.
 */
function fromProjectionCut(row: SessionMeta, values: unknown): SessionMeta {
  if (values === undefined) return row.title === null ? row : { ...row, title: null }
  const title = readTitleValue(readProjectionValue(values, 'title')) ?? null
  const blank = readBlankValue(readProjectionValue(values, 'sessionListMetadata'))
  const nextBlank = blank === undefined ? row.blank : blank
  if (title === row.title && nextBlank === row.blank) return row
  return { ...row, title, blank: nextBlank }
}

/**
 * Apply ONE projection delta (`{key, value}`) to a row. Unlike the baseline cut,
 * a delta says nothing about the keys it does not carry, so every other field is
 * left untouched.
 * @param row - the row being patched.
 * @param key - the projection key that changed.
 * @param value - its new value.
 * @returns the patched row, or the SAME object when nothing changed.
 */
function fromProjectionDelta(row: SessionMeta, key: string, value: unknown): SessionMeta {
  if (key === 'title') {
    const title = readTitleValue(value)
    if (title === undefined || title === row.title) return row
    return { ...row, title }
  }
  if (key === 'sessionListMetadata') {
    const blank = readBlankValue(value)
    if (blank === undefined || blank === row.blank) return row
    return { ...row, blank }
  }
  return row
}

/**
 * Narrow the `api-session/added` payload (a `SessionSummary`) far enough to be
 * safe to consume; the required fields are checked, the optional ones are
 * copied only when they carry the declared type.
 * @param value - the event's first positional argument.
 * @returns the summary, or null when the host sent something else.
 */
function readSessionSummary(value: unknown): SessionSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const sessionId = record['sessionId']
  const updatedAt = record['updatedAt']
  const running = record['running']
  const blank = record['blank']
  if (typeof sessionId !== 'string') return null
  if (typeof updatedAt !== 'number' || typeof running !== 'boolean' || typeof blank !== 'boolean') return null
  const cwd = readOptionalString(record['cwd'])
  const parentSessionId = readOptionalString(record['parentSessionId'])
  const origin = record['origin'] === 'subagent' ? 'subagent' : undefined
  const projections = record['projections']
  return {
    sessionId: sessionId as SessionId,
    updatedAt,
    running,
    blank,
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId as SessionId }),
    ...(origin === undefined ? {} : { origin }),
    ...(projections === undefined ? {} : { projections: projections as SessionProjectionsBlock }),
  }
}

/**
 * Build one list row from an `api-session/added` summary. The row's title rides
 * the summary's own projection block when the host included one.
 * @param summary - the validated summary.
 * @returns the list row.
 */
function toSessionMeta(summary: SessionSummary): SessionMeta {
  const title = readTitleValue(readProjectionValue(summary.projections?.values, 'title'))
  return {
    sessionId: summary.sessionId,
    title: title ?? null,
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    parentSessionId: summary.parentSessionId,
    origin: summary.origin,
    cwd: summary.cwd,
  }
}

/**
 * Report a broadcast event whose positional arguments do not match the wire
 * contract. The old code dropped these silently, which made a protocol
 * disagreement indistinguishable from "nothing happened".
 * @param event - the event name.
 * @param args - the arguments as received.
 */
function warnMalformedRemoteEvent(event: string, args: unknown[]): void {
  console.warn(`[dsh] ${event}：事件参数形状不符合协议，已忽略（${JSON.stringify(args)}）`)
}

/**
 * Read the session id an `api-session/*` broadcast carries as its first
 * argument, warning instead of trusting the wire.
 * @param event - the event name (used for the warning).
 * @param args - the event's positional arguments.
 * @returns the branded session id, or null when the argument is not a string.
 */
function readSessionIdArg(event: string, args: unknown[]): SessionId | null {
  const value = args[0]
  if (typeof value !== 'string') {
    warnMalformedRemoteEvent(event, args)
    return null
  }
  return value as SessionId
}

export const createSessionsSlice: StateCreator<AppStore, [], [], SessionsSlice> = (set, get) => {
  /**
   * Replace the archived set and hide its rows. A workspace baseline is a
   * complete cut, so this RECOMPUTES the visible list from the current rows
   * instead of merging with a previous generation's set.
   * @param archivedSessionIds - the authoritative archived ids.
   */
  const applyArchived = (archivedSessionIds: readonly SessionId[]): void => {
    const archived = new Set<string>(archivedSessionIds)
    const rows = get().sessions
    const visible = rows.filter((s) => !archived.has(s.sessionId))
    set({
      archivedSessionIds: [...archivedSessionIds],
      // Filtering never adds rows, so an equal length means nothing was hidden.
      ...(visible.length === rows.length ? {} : { sessions: visible }),
    })
  }

  return {
    sessions: [],
    activeSessionId: null,
    archivedSessionIds: [],

    initSessions: (all, cwd) => {
      const archived = new Set<string>(get().archivedSessionIds)
      const visible = all.filter((s) => (s.cwd === undefined || s.cwd === cwd) && !archived.has(s.sessionId))
      visible.sort((a, b) => b.updatedAt - a.updatedAt)
      set({ sessions: visible })
    },

    selectSession: async (id) => {
      // Selecting a session marks it read (clears the green unread dot) — even
      // when it is already the active one, so a finished turn can be acked.
      const markRead = get().sessions.map((s) => (s.sessionId === id ? { ...s, unread: false } : s))
      if (get().activeSessionId === id) {
        set({ sessions: markRead })
        // Refresh the subagent catalog even on re-select (children may have settled).
        void get().loadSubagents(id).catch(() => undefined)
        return
      }
      set({ activeSessionId: id, sessions: markRead })
      get().clearConversation()
      // The queue mirror is Host-wide, so the newly active session's items are
      // already known locally; adopt them instead of waiting for a queue frame.
      get().syncQueue(id)
      // Surface any takeover the newly active session was waiting on.
      get().refreshActiveOverlay()
      // History is no longer a unary load: becoming active re-subscribes the
      // `session/follow` journal (store/index.ts follows activeSessionId), whose
      // opening snapshot rebuilds the conversation. Only the model catalog is a
      // call here.
      await get().loadModels(id)
      // Fire-and-forget: hosts without the subagent domain reject, which is fine.
      void get().loadSubagents(id).catch(() => undefined)
    },

    newChat: async () => {
      // Reuse the active session when it is still blank OR its conversation has
      // no content yet (no user input) instead of minting another empty one —
      // clicking "new chat" on an empty session must not create a new session.
      const activeId = get().activeSessionId
      const active = get().sessions.find((s) => s.sessionId === activeId)
      const emptyConversation = activeId !== null && get().nodes.length === 0
      if (active !== undefined && (active.blank === true || emptyConversation)) return
      // Group the session under the per-root workspace so the dsh web UI can
      // manage it. workspace/create is idempotent per canonical path; if the
      // host cannot create one, fall back to a plain cwd-scoped create.
      const cwd = get().cwd
      let payload: { request: { workspaceId: WorkspaceId } } | { request: { cwd: string } }
      try {
        const { workspace } = await rpc<{ workspace: WorkspaceView; created: boolean }>(
          'workspace/create',
          { request: { path: cwd } },
        )
        payload = { request: { workspaceId: workspace.workspaceId } }
      } catch (error) {
        // Deliberate fallback, but not silent: a broken workspace domain would
        // otherwise be indistinguishable from a host that has none.
        console.warn(`[dsh] workspace/create 失败，回退为 cwd 会话：${error instanceof Error ? error.message : String(error)}`)
        payload = { request: { cwd } }
      }
      const { sessionId } = await rpc<{ sessionId: SessionId }>('session/create', payload)
      // The api-session/added broadcast also inserts the row; applyRemoteEvent dedupes.
      await get().selectSession(sessionId)
      // A new session starts at the configured default permission.
      set({ permissionMode: get().uiPrefs.permissionMode })
      // A model chosen before the session existed is applied now.
      const pending = get().pendingModelSelection
      if (pending !== null) {
        set({ pendingModelSelection: null })
        await get().selectModel(pending.provider, pending.model, pending.reasoningEffort)
      }
    },

    renameSession: async (id, title) => {
      await rpc('session/rename', { request: { sessionId: id, title } })
      set({ sessions: get().sessions.map((s) => (s.sessionId === id ? { ...s, title } : s)) })
    },

    deleteSession: async (id) => {
      try {
        await rpc('workspace/archiveSession', { request: { sessionId: id } })
      } catch (error) {
        // The list stays untouched on failure; the caller (ConfirmModal) shows
        // the reason and lets the user retry.
        throw new Error(`归档会话失败：${error instanceof Error ? error.message : String(error)}`)
      }
      set({ sessions: get().sessions.filter((s) => s.sessionId !== id) })
      if (get().activeSessionId === id) {
        get().resetGoal()
        set({ activeSessionId: null })
        get().refreshActiveOverlay()
      }
    },

    forkSession: async (id, atSeq) => {
      const { sessionId } = await rpc<{ sessionId: SessionId }>('session/fork', {
        request: { sessionId: id, atSeq },
      })
      await get().selectSession(sessionId)
    },

    touchSession: (id, at) => {
      const now = at ?? Date.now()
      const touched = get().sessions.map((s) => (s.sessionId === id && now > s.updatedAt ? { ...s, updatedAt: now } : s))
      if (touched.every((s, i) => s === get().sessions[i])) return
      touched.sort((a, b) => b.updatedAt - a.updatedAt)
      set({ sessions: touched })
    },

    applyControlFrame: (frame) => {
      switch (frame.type) {
        // GENERATION BOUNDARY: the control stream opens every generation with
        // exactly one baseline. Its `projections` map is NOT a complete cut: a cut
        // exists only for sessions whose projection unit is mounted in that host
        // process (measured 10 cuts for 245 sessions on a live host), while
        // `session/list` carries a title for almost every row. So a cut is applied
        // to the session it names, and a session the cut does not mention is left
        // alone — recomputing it from a missing cut erased every title the init
        // payload had just installed, which showed the whole list as 新会话.
        // A session whose projection unit really is unmounted arrives as a PRESENT
        // cut with `title: null` inside it.
        case 'baseline': {
          const rows = get().sessions
          let changed = false
          const next = rows.map((row) => {
            const cut = frame.value.projections[row.sessionId]
            if (cut === undefined) return row
            const patched = fromProjectionCut(row, cut.values)
            if (patched !== row) changed = true
            return patched
          })
          if (changed) set({ sessions: next })
          break
        }
        // Delta: one projection value for one session. Only the two keys this
        // slice renders are considered; every other key belongs to another slice.
        case 'projection': {
          const row = get().sessions.find((s) => s.sessionId === frame.sessionId)
          // An unknown session is NORMAL, not an error: the control stream is
          // Host-wide while this list is cwd-filtered, so most frames concern
          // rows this window does not show.
          if (row === undefined) break
          const patched = fromProjectionDelta(row, frame.key, frame.value)
          if (patched !== row) set({ sessions: get().sessions.map((s) => (s === row ? patched : s)) })
          break
        }
        // Queue items live in the composer slice, jobs in the conversation slice.
        case 'queue':
        case 'jobs':
          break
      }
    },

    applyWorkspaceFrame: (frame) => {
      switch (frame.type) {
        // GENERATION BOUNDARY: `workspace/follow` opens every generation with one
        // baseline holding the complete workspace set AND the complete archived
        // set. The archived set is therefore replaced wholesale, never merged
        // with the previous generation's.
        case 'baseline':
          applyArchived(frame.value.archivedSessionIds)
          break
        // Delta: the archive changed; this frame carries the full replacement set.
        case 'archived':
          applyArchived(frame.archivedSessionIds)
          break
        // Workspace rows and their manual order feed the workspace UI; the
        // session list only needs the archived set.
        case 'upsert':
        case 'remove':
        case 'order':
          break
      }
    },

    applyRemoteEvent: (event, args) => {
      switch (event) {
        case 'api-session/added': {
          const summary = readSessionSummary(args[0])
          if (summary === null) {
            warnMalformedRemoteEvent(event, args)
            return
          }
          // Cross-workspace isolation: the host broadcasts every window's
          // session additions; only rows of the current workspace enter the list.
          if (summary.cwd !== undefined && summary.cwd !== get().cwd) return
          // An archived row stays hidden even when the host re-announces it.
          if (get().archivedSessionIds.includes(summary.sessionId)) return
          if (get().sessions.some((s) => s.sessionId === summary.sessionId)) return
          set({ sessions: [toSessionMeta(summary), ...get().sessions] })
          return
        }
        case 'api-session/removed': {
          const sessionId = readSessionIdArg(event, args)
          if (sessionId === null) return
          set({ sessions: get().sessions.filter((s) => s.sessionId !== sessionId) })
          if (get().activeSessionId === sessionId) {
            get().resetGoal()
            set({ activeSessionId: null })
            get().refreshActiveOverlay()
          }
          return
        }
        case 'api-session/status': {
          const sessionId = readSessionIdArg(event, args)
          const running = args[1]
          if (sessionId === null) return
          if (typeof running !== 'boolean') {
            warnMalformedRemoteEvent(event, args)
            return
          }
          // The broadcast covers every session on the host, so most frames
          // concern rows outside this window's cwd-filtered list.
          const row = get().sessions.find((s) => s.sessionId === sessionId)
          if (row === undefined) return
          // A running -> idle transition marks the session unread (green dot),
          // including the active one — it clears when the user selects it again.
          const ended = !running && row.running
          if (row.running === running && !ended) return
          set({
            sessions: get().sessions.map((s) =>
              s.sessionId === sessionId
                ? { ...s, running, ...(ended ? { unread: true } : {}) }
                : s),
          })
          return
        }
        case 'api-session/activity': {
          const sessionId = readSessionIdArg(event, args)
          const updatedAt = args[1]
          if (sessionId === null) return
          if (typeof updatedAt !== 'number') {
            warnMalformedRemoteEvent(event, args)
            return
          }
          // The broadcast updatedAt means "the later of creation and the latest
          // human prompt", i.e. exactly the list's ordering key.
          get().touchSession(sessionId, updatedAt)
          return
        }
        case 'api-session/error': {
          const sessionId = readSessionIdArg(event, args)
          const message = args[1]
          if (sessionId === null) return
          if (typeof message !== 'string') {
            warnMalformedRemoteEvent(event, args)
            return
          }
          if (sessionId === get().activeSessionId) get().appendError(message)
          return
        }
        default:
          // Every other broadcast (commands/change, llm/adapters-updated,
          // settings/document-updated, …) belongs to another slice. `$events` is
          // sparse and event-driven, so there is no state to reconcile here.
          return
      }
    },
  }
}
