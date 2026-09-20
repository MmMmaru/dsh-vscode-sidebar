/**
 * Combined application store (owned by the contract skeleton; W2-W6 each own
 * one slice file). Merges the slices and holds the root connection state plus
 * initialize(), the single place where bridge subscriptions fan frames out to
 * the per-slice handlers:
 *   mux  -> conversation.applyMuxFrame / overlay.applyOverlayFrame /
 *           composer.applyQueueFrame / sessions.applyProjectionFrame
 *   host -> sessions.applyHostFrame
 * Slices never subscribe to the bridge themselves.
 */

import { create } from 'zustand'
import type { HostFrame, MuxFrame } from '../../extension/protocol/events'
import type { HostStatus } from '../../shared/bridge'
import { onCommand, onEnvChanged, onEvent, onHostStatus, onPortChanged, setEnv as bridgeSetEnv, setPort as bridgeSetPort, waitInit } from '../bridge'
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
  /** dsh host version reported by host.describe. */
  hostVersion: string
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
  /** Bootstrap: wait for init, install sessions, wire event/status/command fan-out. */
  initialize: () => Promise<void>
}

/** The full store: root slice + the six workflow-owned slices. */
export type AppStore = RootSlice & SessionsSlice & ConversationSlice & ComposerSlice & OverlaySlice & SettingsSlice & GoalSlice

export const useAppStore = create<AppStore>()((...a) => {
  const [, get] = a
  return {
    cwd: '',
    hostVersion: '',
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
      // Fan-out subscriptions first so no frame is lost while init is in flight.
      onEvent((channel, frame) => {
        if (channel === 'mux') {
          const mux = frame as MuxFrame
          get().applyMuxFrame(mux)
          get().applyOverlayFrame(mux)
          get().applyQueueFrame(mux)
          get().applyProjectionFrame(mux)
        } else {
          get().applyHostFrame(frame as HostFrame)
        }
      })
      onHostStatus((status) => {
        useAppStore.setState({ hostStatus: status })
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
        hostVersion: init.hostVersion,
        port: init.port ?? 3080,
        env: init.env ?? {},
        initialized: true,
        hostStatus: 'ready',
      })
      get().initSessions(init.sessions, init.cwd)
      // Replay answerable overlays that arrived while the webview was hidden
      // (a disposed sidebar webview is re-resolved on show): select the
      // session holding the pending question/approval, then install the state
      // so the takeover panel re-appears and the stuck session can be answered.
      const overlays = init.pendingOverlays ?? []
      const firstOverlay = overlays[0]
      if (overlays.length > 0 && firstOverlay !== undefined) {
        const target = overlays.find((o) => o.kind === 'question') ?? firstOverlay
        if (useAppStore.getState().sessions.some((s) => s.sessionId === target.frame.sessionId)) {
          await get().selectSession(target.frame.sessionId)
        }
        get().applyOverlays(overlays)
      }
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
})
