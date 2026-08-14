/**
 * Settings slice (owned by W6). Settings modal visibility plus the
 * settings/credentials/llm RPC read-write surface. Namespace values are always
 * redacted wire views; secrets are write-only via credentials.*.
 * Contract: ARCHITECTURE.md section 5.2 (extended for W6).
 */

import type { StateCreator } from 'zustand'
import type {
  ConfigurableProviderView,
  SettingsNamespaceView,
} from '../../extension/protocol/settings'
import { rpc } from '../bridge'
import type { AppStore } from './index'

/** Result of settings.describe. */
interface SettingsDescribeResult {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}

/** State + actions owned by the settings workflow. */
export interface SettingsSlice {
  settingsOpen: boolean
  /** Redacted namespace wire views, keyed load from settings.describe. */
  namespaces: SettingsNamespaceView[]
  /** Configurable providers (llm.providers). */
  providers: ConfigurableProviderView[]
  /** False marks a read-only settings plane. */
  settingsWritable: boolean

  openSettings: () => void
  closeSettings: () => void
  /** Load namespaces + providers (called when the modal opens). */
  loadSettings: () => Promise<void>
  /** Merge a patch into one namespace; optimistic concurrency via revision. */
  updateSettings: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
  /** Write one secret credential (value never rides back). */
  setCredential: (ref: string, value: string) => Promise<void>
  unsetCredential: (ref: string) => Promise<void>
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  settingsOpen: false,
  namespaces: [],
  providers: [],
  settingsWritable: false,

  openSettings: () => {
    set({ settingsOpen: true })
    void get().loadSettings()
  },
  closeSettings: () => set({ settingsOpen: false }),

  loadSettings: async () => {
    const [described, providers] = await Promise.all([
      rpc<SettingsDescribeResult>('settings.describe', {}),
      rpc<{ providers: ConfigurableProviderView[] }>('llm.providers', {}),
    ])
    set({
      namespaces: described.namespaces,
      settingsWritable: described.writable,
      providers: providers.providers,
    })
  },

  updateSettings: async (ns, patch, expectedRevision) => {
    const updated = await rpc<SettingsNamespaceView>('settings.update', { ns, patch, expectedRevision })
    set({ namespaces: get().namespaces.map((n) => (n.ns === ns ? updated : n)) })
  },

  setCredential: async (ref, value) => {
    await rpc('credentials.set', { ref, value })
  },

  unsetCredential: async (ref) => {
    await rpc('credentials.unset', { ref })
  },
})
