/**
 * Settings slice (owned by W6). Settings modal visibility plus the
 * settings/credentials/llm/agentPreset RPC read-write surface. Namespace values
 * are always redacted wire views; secrets are write-only via credentials.*.
 * Contract: ARCHITECTURE.md section 5.2 (extended for W6 with presets,
 * credential states, settings.mutate, provider removal and UI preferences).
 */

import type { StateCreator } from 'zustand'
import type {
  ConfigurableProviderView,
  CredentialView,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '../../extension/protocol/settings'
import { rpc } from '../bridge'
import type { PermissionMode } from '../types'
import type { AppStore } from './index'

/** Result of settings.describe. */
interface SettingsDescribeResult {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}

/**
 * One agent preset row from agentPreset.list. The vendored protocol copy omits
 * the agent-preset domain (see protocol/rpc-map.ts), so the wire view is
 * declared here against upstream packages/host/apiproxy/src/api/agent-presets.ts.
 */
export interface AgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  /** Why the preset cannot compose a session, when broken. */
  broken?: string
}

/** UI preferences of the General section (language / appearance / Enter / permission). */
export interface UiPrefs {
  language: 'zh' | 'en'
  appearance: 'vscode' | 'light' | 'dark'
  busyEnter: 'queue' | 'steer'
  permissionMode: PermissionMode
}

/** Where one UI preference persists: a writable settings namespace or localStorage. */
export type UiPrefSource = 'settings' | 'local'

const DEFAULT_UI_PREFS: UiPrefs = {
  language: 'zh',
  appearance: 'vscode',
  busyEnter: 'queue',
  permissionMode: 'workspace-write',
}

/** localStorage key holding the JSON-serialized UiPrefs fallback. */
const LOCAL_PREFS_KEY = 'dsh.settings.uiPrefs'

/** Namespace + field each UI preference maps to, with wire (de)serialization. */
const UI_PREF_BINDINGS: {
  [K in keyof UiPrefs]: {
    ns: string
    field: string
    toWire: (value: UiPrefs[K]) => string
    fromWire: (value: unknown) => UiPrefs[K] | undefined
  }
} = {
  language: {
    ns: 'locale',
    field: 'preference',
    toWire: (v) => v,
    fromWire: (v) => (v === 'zh' || v === 'en' ? v : undefined),
  },
  appearance: {
    ns: 'ui-theme',
    field: 'preference',
    // 'vscode' rides the wire as the dsh 'system' preference.
    toWire: (v) => (v === 'vscode' ? 'system' : v),
    fromWire: (v) => (v === 'system' ? 'vscode' : v === 'light' || v === 'dark' ? v : undefined),
  },
  busyEnter: {
    ns: 'ui-conversation',
    field: 'busyEnter',
    toWire: (v) => v,
    fromWire: (v) => (v === 'queue' || v === 'steer' ? v : undefined),
  },
  permissionMode: {
    ns: 'permission',
    field: 'defaultPreset',
    toWire: (v) => v,
    fromWire: (v) => (v === 'read-only' || v === 'workspace-write' || v === 'full-access' ? v : undefined),
  },
}

/** The credential reference one provider profile resolves API keys through. */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Guarded localStorage read (absent under node verification hosts). */
function readLocalPrefs(): Partial<UiPrefs> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(LOCAL_PREFS_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    const out: Partial<UiPrefs> = {}
    for (const key of Object.keys(UI_PREF_BINDINGS) as Array<keyof UiPrefs>) {
      const value = parsed[key]
      if (value !== undefined && UI_PREF_BINDINGS[key].fromWire(UI_PREF_BINDINGS[key].toWire(value as never)) !== undefined) {
        (out as Record<string, unknown>)[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Guarded localStorage write of the full preference set. */
function writeLocalPrefs(prefs: UiPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Persistence is best-effort: a denied write leaves the in-memory state.
  }
}

/** Address of one provider profile, for edits and removal. */
export interface ProviderTarget {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  /** Page-managed credential ref, when the profile resolves keys through it. */
  credentialRef?: string
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
  /** Credential states keyed by ref (credentials.describe of known refs). */
  credentials: Record<string, CredentialView>
  /** Agent preset roster (agentPreset.list). */
  presets: AgentPresetEntry[]
  /** Current default preset id (roster isDefault, else first row). */
  defaultPresetId: string
  /** General-section UI preferences. */
  uiPrefs: UiPrefs
  /** Per-preference persistence target (settings namespace or localStorage). */
  uiPrefSources: Record<keyof UiPrefs, UiPrefSource>

  openSettings: () => void
  closeSettings: () => void
  /** Load namespaces + providers + credentials + presets (modal open). */
  loadSettings: () => Promise<void>
  /** Merge a patch into one namespace; optimistic concurrency via revision. */
  updateSettings: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
  /** Path-addressed edits against one namespace (settings.mutate). */
  mutateSettings: (ns: string, ops: SettingsPathOpView[], expectedRevision?: number) => Promise<void>
  /** Write one secret credential (value never rides back). */
  setCredential: (ref: string, value: string) => Promise<void>
  unsetCredential: (ref: string) => Promise<void>
  /** Remove a user-added provider: credential first, then the profile path. */
  removeProvider: (target: ProviderTarget) => Promise<void>
  /** Persist one UI preference (settings namespace when bound, else local). */
  setUiPref: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => Promise<void>
  /** Persist the default preset for subsequently created sessions. */
  selectDefaultPreset: (id: string) => Promise<void>
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  settingsOpen: false,
  namespaces: [],
  providers: [],
  settingsWritable: false,
  credentials: {},
  presets: [],
  defaultPresetId: '',
  uiPrefs: { ...DEFAULT_UI_PREFS },
  uiPrefSources: { language: 'local', appearance: 'local', busyEnter: 'local', permissionMode: 'local' },

  openSettings: () => {
    set({ settingsOpen: true })
    void get().loadSettings()
  },
  closeSettings: () => set({ settingsOpen: false }),

  loadSettings: async () => {
    const [described, providers, roster] = await Promise.all([
      rpc<SettingsDescribeResult>('settings.describe', {}),
      rpc<{ providers: ConfigurableProviderView[] }>('llm.providers', {}),
      rpc<{ presets: AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }>('agentPreset.list', {}),
    ])
    const refs = providers.providers.map((p) => deriveKeyRef(p.provider))
    const credentialViews = await rpc<{ credentials: Record<string, CredentialView> }>(
      'credentials.describe',
      { refs },
    )
    // Resolve each UI preference: a writable settings namespace wins; otherwise
    // the localStorage fallback (webview-local persistence).
    const localPrefs = readLocalPrefs()
    const uiPrefs = { ...DEFAULT_UI_PREFS }
    const uiPrefSources = { ...get().uiPrefSources }
    for (const key of Object.keys(UI_PREF_BINDINGS) as Array<keyof UiPrefs>) {
      const binding = UI_PREF_BINDINGS[key]
      const ns = described.namespaces.find((n) => n.ns === binding.ns)
      if (described.writable && ns !== undefined) {
        uiPrefSources[key] = 'settings'
        const wire = (ns.value as Record<string, unknown> | null)?.[binding.field]
        const parsed = binding.fromWire(wire)
        if (parsed !== undefined) (uiPrefs as Record<string, unknown>)[key] = parsed
      } else {
        uiPrefSources[key] = 'local'
        const local = localPrefs[key]
        if (local !== undefined) (uiPrefs as Record<string, unknown>)[key] = local
      }
    }
    set({
      namespaces: described.namespaces,
      settingsWritable: described.writable,
      providers: providers.providers,
      credentials: credentialViews.credentials,
      presets: roster.presets,
      defaultPresetId: roster.presets.find((p) => p.isDefault)?.id ?? roster.presets[0]?.id ?? '',
      uiPrefs,
      uiPrefSources,
    })
  },

  updateSettings: async (ns, patch, expectedRevision) => {
    const updated = await rpc<SettingsNamespaceView>('settings.update', { ns, patch, expectedRevision })
    set({ namespaces: get().namespaces.map((n) => (n.ns === ns ? updated : n)) })
  },

  mutateSettings: async (ns, ops, expectedRevision) => {
    const updated = await rpc<SettingsNamespaceView>('settings.mutate', { ns, ops, expectedRevision })
    set({ namespaces: get().namespaces.map((n) => (n.ns === ns ? updated : n)) })
  },

  setCredential: async (ref, value) => {
    await rpc('credentials.set', { ref, value })
    set({ credentials: { ...get().credentials, [ref]: { configured: true, writable: true } } })
  },

  unsetCredential: async (ref) => {
    await rpc('credentials.unset', { ref })
    set({ credentials: { ...get().credentials, [ref]: { configured: false, writable: true } } })
  },

  removeProvider: async (target) => {
    // Credential removal first: a second-step failure leaves the provider row
    // visible and the whole operation safely retryable (both unsets idempotent).
    if (target.credentialRef !== undefined) await get().unsetCredential(target.credentialRef)
    await get().mutateSettings(target.settingsNs, [{ op: 'unset', path: [...target.settingsPath] }])
    await get().loadSettings()
  },

  setUiPref: async (key, value) => {
    const binding = UI_PREF_BINDINGS[key]
    const next = { ...get().uiPrefs, [key]: value }
    set({ uiPrefs: next })
    if (get().uiPrefSources[key] === 'settings') {
      const ns = get().namespaces.find((n) => n.ns === binding.ns)
      await get().updateSettings(binding.ns, { [binding.field]: binding.toWire(value) }, ns?.revision)
    } else {
      writeLocalPrefs(next)
    }
  },

  selectDefaultPreset: async (id) => {
    // The default is a settings field; the host resolves it at session creation.
    const ns = get().namespaces.find((n) => n.ns === 'agent-presets')
    await get().updateSettings('agent-presets', { default: id }, ns?.revision)
    const roster = await rpc<{ presets: AgentPresetEntry[]; authorable: boolean; hasDocument: boolean }>(
      'agentPreset.list',
      {},
    )
    set({ presets: roster.presets, defaultPresetId: roster.presets.find((p) => p.isDefault)?.id ?? id })
  },
})
