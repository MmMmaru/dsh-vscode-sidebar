/**
 * Combined application store. Merges the slices and holds the root connection
 * state plus initialize(), the single place where bridge subscriptions fan
 * messages out to the per-slice handlers:
 *
 *   session  -> conversation.applySessionFrame
 *   control  -> sessions.applyControlFrame / composer.applyQueueFrame
 *               and conversation.applyConversationProjection
 *   workspace-> sessions.applyWorkspaceFrame
 *   remote   -> overlay.applyPendingOverlay / overlay.clearPendingOverlay,
 *               plus sessions.applyRemoteEvent
 *
 * Slices never subscribe to the bridge themselves.
 *
 * MIGRATION NOTE (dsh 0.1.5-rc.2 / Typert Remote): this used to fan out two
 * frame families (`mux` and `host`) from the two apiproxy sockets. Both sockets
 * are gone, so the fan-out is now a switch over the four channels of
 * `RemoteChannelMessage`. Two consequences worth knowing:
 *
 *   - The session journal is no longer broadcast. One `session/follow` stream is
 *     subscribed for whichever session is active, and re-subscribed whenever the
 *     active session changes (see `syncSubscription`).
 *   - Answerable requests arrive on the `remote` channel as pre-shaped
 *     `PendingOverlayReplay` values keyed by `eventId`, so the overlay slice no
 *     longer demultiplexes frames.
 */

import { create } from 'zustand'
import type { HostStatus } from '../../shared/bridge'
import type { PendingOverlayReplay } from '../../shared/bridge'
import type { SessionId } from '../../extension/protocol/brand'
import type { SessionAddress } from '../../extension/protocol/follow'
import { onCommand, onEnvChanged, onEvent, onHostStatus, onPortChanged, onStreamError, setEnv as bridgeSetEnv, setPort as bridgeSetPort, followSession, unfollowSession, rpc, waitInit } from '../bridge'
import { createComposerSlice, type ComposerSlice } from './composer'
import { createConversationSlice, type ConversationSlice } from './conversation'
import { createGoalSlice, type GoalSlice } from './goal'
import { createOverlaySlice, type OverlaySlice } from './overlay'
import { createSessionsSlice, type SessionsSlice } from './sessions'
import { createSettingsSlice, type SettingsSlice } from './settings'

/** Root state owned by the skeleton itself (connection facts + bootstrap). */
export interface RootSlice {
  /** Current workspace root; the session ownership anchor. */
  cwd: string
  /** Configured base port for DSH host. */
  port: number
  /**
   * Custom environment variables configured for the spawned dsh host
   * (`dsh.env`); empty when none are set. Hosts that are already running keep
   * their original environment, so an edit only applies to the next spawn.
   */
  env: Record<string, string>
  hostStatus: HostStatus
  /** True once the init payload arrived. */
  initialized: boolean

  /** Update the configured DSH base port. */
  setPort: (port: number) => Promise<void>
  /**
   * Persist the custom host environment and adopt what the extension stored.
   * Reverts the optimistic state when the extension reports a failure.
   */
  setEnv: (env: Record<string, string>) => Promise<void>
  /** Bootstrap: wait for init, install sessions, wire channel/status/command fan-out. */
  initialize: () => Promise<void>
}

/** The full store: root slice + the six workflow-owned slices. */
export type AppStore = RootSlice & SessionsSlice & ConversationSlice & ComposerSlice & OverlaySlice & SettingsSlice & GoalSlice

/**
 * The session address the extension is currently following, or null. Tracked
 * outside the store because it mirrors an extension-side subscription, not UI
 * state, and must survive store updates without causing re-renders.
 */
let followedAddress: string | null = null
/** Monotonic guard so a slow address lookup cannot win a race with a newer pick. */
let followGeneration = 0

/**
 * Resolve the durable address for one session id.
 *
 * A subagent child CANNOT be followed as an ordinary session: the host answers
 * `session/agent-busy` with "subagent Sessions require their durable parent
 * address". Children are also the one row shape that lacks a `mode` (ordinary
 * sessions are `session-<uuid>`, children are bare `<uuid>`), so the parent
 * listing is the only place to read it from.
 * @param state - the current store state (for the row's lineage).
 * @param sessionId - the selected session.
 * @returns the address to hand to `followSession`.
 */
async function resolveAddress(state: AppStore, sessionId: SessionId): Promise<SessionAddress> {
  const meta = state.sessions.find((s) => s.sessionId === sessionId)
  const parentSessionId = meta?.parentSessionId
  if (meta?.origin !== 'subagent' || parentSessionId === undefined) return { kind: 'session', sessionId }
  try {
    const listing = await rpc<{ entries: { id: string; mode: 'one-shot' | 'continuable' }[] }>('subagents/list', {
      parentSessionId,
    })
    const entry = listing.entries.find((candidate) => candidate.id === sessionId)
    if (entry !== undefined) {
      return { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: entry.mode }
    }
  } catch {
    // A host without the subagent domain: fall through to the plain address and
    // let the host's own error surface rather than hiding the failure here.
  }
  return { kind: 'session', sessionId }
}

/** Subscribe (or re-subscribe) the journal for the active session. */
async function syncSubscription(state: AppStore, force = false): Promise<void> {
  const active = state.activeSessionId
  if (!force && active === followedAddress) return
  followedAddress = active
  const generation = ++followGeneration
  if (active === null) {
    unfollowSession()
    return
  }
  const address = await resolveAddress(state, active)
  // Superseded by a newer selection while the lookup was in flight.
  if (generation !== followGeneration) return
  followSession(address)
}

/** Route one sparse broadcast event to the slice that owns its concern. */
function applyRemoteChannelEvent(get: () => AppStore, event: string, args: unknown[]): void {
  switch (event) {
    case 'approval/request':
    case 'user-questions/request': {
      const overlay = args[0] as PendingOverlayReplay | undefined
      if (overlay !== undefined) get().applyPendingOverlay(overlay)
      return
    }
    case 'request/cancelled': {
      const eventId = args[0]
      if (typeof eventId === 'string') get().clearPendingOverlay(eventId)
      return
    }
    default:
      get().applyRemoteEvent(event, args)
  }
}

export const useAppStore = create<AppStore>()((...a) => {
  const [, get] = a
  const store: AppStore = {
    cwd: '',
    port: 3080,
    env: {},
    hostStatus: 'starting',
    initialized: false,

    setPort: async (port: number) => {
      useAppStore.setState({ port })
      await bridgeSetPort(port)
    },

    setEnv: async (env: Record<string, string>) => {
      const previous = get().env
      // Optimistic: the editor settles on the extension's `env-changed` echo,
      // and a failure rolls the state back so the inputs stop lying.
      useAppStore.setState({ env })
      try {
        await bridgeSetEnv(env)
      } catch (error) {
        useAppStore.setState({ env: previous })
        throw error
      }
    },

    initialize: async () => {
      if (get().initialized) return
      // Fan-out subscriptions first so no message is lost while init is in flight.
      onEvent((message) => {
        switch (message.channel) {
          case 'session':
            get().applySessionFrame(message.frame)
            break
          case 'control':
            get().applyControlFrame(message.frame)
            get().applyQueueFrame(message.frame)
            // Owns the active session's background jobs, and delegates projection
            // frames on to applyConversationProjection itself.
            get().applyConversationControl(message.frame)
            // `goal` is the one projection key no slice claims in its own fan-out:
            // the others are absorbed by the sessions/composer/conversation
            // handlers above. Without this the goal bar keeps the revision it got
            // from the follow snapshot and the next mutation loses the CAS race.
            if (message.frame.type === 'projection') get().applyGoalProjection(message.frame)
            break
          case 'workspace':
            get().applyWorkspaceFrame(message.frame)
            break
          case 'remote':
            applyRemoteChannelEvent(get, message.event, message.args)
            break
        }
      })
      // A logically dead stream leaves the carrier up, so this is the only way
      // the failure becomes visible. The old client dropped these silently.
      onStreamError((failure) => {
        console.warn(`[dsh] ${failure.scope} 流已终止：${failure.error.code} ${failure.error.message}`)
      })
      onHostStatus((status) => {
        useAppStore.setState({ hostStatus: status })
        // A host restart tears down every extension-side subscription, so the
        // journal must be re-subscribed even though the active session is unchanged.
        if (status === 'ready') void syncSubscription(useAppStore.getState(), true)
      })
      // The extension is the source of truth for the persisted environment
      // (it drops invalid entries), so its echo settles the editor state.
      onEnvChanged((env) => {
        useAppStore.setState({ env })
      })
      onPortChanged((port) => {
        useAppStore.setState({ port })
      })
      onCommand((command) => {
        if (command === 'newChat') void get().newChat()
        else get().openSettings()
      })
      const init = await waitInit()
      useAppStore.setState({
        cwd: init.cwd,
        port: init.port ?? 3080,
        env: init.env ?? {},
        initialized: true,
        hostStatus: 'ready',
      })
      get().initSessions(init.sessions, init.cwd)
      // The workspace stream's first frame normally supplies this, but init races
      // it; seeding from the init payload means the workspace list is never
      // briefly empty. A later real baseline simply supersedes it.
      // Seeded unconditionally, because `archivedSessionIds` can arrive with no
      // workspaces and the archived set must not be left unseeded.
      get().applyWorkspaceFrame({
        type: 'baseline',
        value: { items: init.workspaces ?? [], archivedSessionIds: init.archivedSessionIds ?? [] },
      })
      // Replay answerable requests that arrived while the webview was hidden
      // (a disposed sidebar webview is re-resolved on show): select the
      // session holding the pending question/approval, then install the state
      // so the takeover panel re-appears and the stuck session can be answered.
      const overlays = init.pendingOverlays ?? []
      const firstOverlay = overlays[0]
      if (overlays.length > 0 && firstOverlay !== undefined) {
        const target = overlays.find((o) => o.kind === 'question') ?? firstOverlay
        if (useAppStore.getState().sessions.some((s) => s.sessionId === target.agentId)) {
          await get().selectSession(target.agentId as SessionId)
        }
        get().applyOverlays(overlays)
      }
      // Keep the followed journal in step with the active session.
      useAppStore.subscribe((state) => void syncSubscription(state))
      void syncSubscription(useAppStore.getState(), true)
      // Populate the model selector even before any session is selected.
      void get().loadGlobalModels().catch(() => undefined)
      // Preselect the last used model (saved host-side as the default).
      void get().loadDefaultModel().catch(() => undefined)
      // Reflect the saved default permission in the composer chip.
      void get().syncPermissionDefault().catch(() => undefined)
    },

    ...createSessionsSlice(...a),
    ...createConversationSlice(...a),
    ...createComposerSlice(...a),
    ...createOverlaySlice(...a),
    ...createSettingsSlice(...a),
    ...createGoalSlice(...a),
  }
  return store
})
