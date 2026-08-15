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
import { onCommand, onEvent, onHostStatus, waitInit } from '../bridge'
import { createComposerSlice, type ComposerSlice } from './composer'
import { createConversationSlice, type ConversationSlice } from './conversation'
import { createOverlaySlice, type OverlaySlice } from './overlay'
import { createSessionsSlice, type SessionsSlice } from './sessions'
import { createSettingsSlice, type SettingsSlice } from './settings'

/** Root state owned by the skeleton itself (connection facts + bootstrap). */
export interface RootSlice {
  /** Current workspace root; the session ownership anchor. */
  cwd: string
  /** dsh host version reported by host.describe. */
  hostVersion: string
  hostStatus: HostStatus
  /** True once the init payload arrived. */
  initialized: boolean

  /** Bootstrap: wait for init, install sessions, wire event/status/command fan-out. */
  initialize: () => Promise<void>
}

/** The full store: root slice + the five workflow-owned slices. */
export type AppStore = RootSlice & SessionsSlice & ConversationSlice & ComposerSlice & OverlaySlice & SettingsSlice

export const useAppStore = create<AppStore>()((...a) => {
  const [, get] = a
  return {
    cwd: '',
    hostVersion: '',
    hostStatus: 'starting',
    initialized: false,

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
      onCommand((command) => {
        if (command === 'newChat') void get().newChat()
        else get().openSettings()
      })
      const init = await waitInit()
      useAppStore.setState({ cwd: init.cwd, hostVersion: init.hostVersion, initialized: true, hostStatus: 'ready' })
      get().initSessions(init.sessions, init.cwd)
      // Populate the model selector even before any session is selected.
      void get().loadGlobalModels().catch(() => undefined)
      // Reflect the saved default permission in the composer chip.
      void get().syncPermissionDefault().catch(() => undefined)
    },

    ...createSessionsSlice(...a),
    ...createConversationSlice(...a),
    ...createComposerSlice(...a),
    ...createOverlaySlice(...a),
    ...createSettingsSlice(...a),
  }
})
