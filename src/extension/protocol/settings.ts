/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Sources:
 *   packages/host/apiproxy/src/api/settings.ts    (SettingsNamespaceView family)
 *   packages/host/apiproxy/src/api/credentials.ts (CredentialView)
 *   packages/host/apiproxy/src/api/llm.ts         (ConfigurableProviderView, DiscoveredModelView)
 * Settings/credentials/llm wire views. Every settings payload leaving the host
 * is redacted: secret values never ride a response; the `secrets` slot list
 * tells a form a write-only field exists and whether it is configured.
 */

import type { ModelCatalogFailure, ModelProviderGroup } from './sessions'

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[]
  /** Whether the slot currently holds a value (the value itself never rides). */
  set: boolean
}

/** Wire view of one registered settings namespace. */
export interface SettingsNamespaceView {
  /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
  ns: string
  /** Serialized schemastery schema envelope (`schema.toJSON()`). */
  schema: unknown
  /** Redacted resolved value (schema defaults → composition base → user layer). */
  value: unknown
  /** Redacted composition base layer, when the registrant declared one. */
  base?: unknown
  /** Redacted raw user section; a field's presence here marks it user-overridden. */
  user?: unknown
  /** When the owner applies changes. */
  applies: 'live' | 'restart'
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[]
  /** Monotonic revision of the raw user section; send back as `expectedRevision` on a write. */
  revision: number
}

/** One path-addressed edit carried by `settings.mutate`. The empty path addresses the section root. */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Wire view of one credential reference's state (structurally value-free). */
export interface CredentialView {
  /** Whether any layer currently supplies a non-empty value. */
  configured: boolean
  /** Winning layer when configured (`env`, `file`, …); provider vocabulary. */
  source?: string
  /** Whether `credentials.set`/`credentials.unset` can affect this reference. */
  writable: boolean
}

/** Wire view of one configurable provider. */
export interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string
  /** Human-readable name for configuration surfaces. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[]
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean
  /** Whether the owning adapter knows this route only because configuration declared it. */
  declared?: boolean
}

/** Wire view of one model an interrogated endpoint advertises. */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}

/** Payload/value shapes of the settings-domain unary Remote methods (0.1.5-rc.2). */
export interface SettingsRpc {
  'settings/describe': {
    payload: Record<string, never>
    value: { writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }
  }
  /** Was `settings.openDocument` before the rename. */
  'settings/openSettingsDocument': { payload: Record<string, never>; value: { opened: true } }
  'settings/update': {
    payload: { ns: string; patch: object; expectedRevision?: number }
    value: SettingsNamespaceView
  }
  'settings/replace': {
    payload: { ns: string; section: object; expectedRevision?: number }
    value: SettingsNamespaceView
  }
  'settings/mutate': {
    payload: { ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }
    value: SettingsNamespaceView
  }
  'settings/canOpenAgentPresetDirectory': { payload: Record<string, never>; value: boolean }
  'settings/openAgentPresetDirectory': {
    payload: { agentPreset: string }
    value: { opened: true } | { opened: false; path: string }
  }
}

/**
 * Payload/value shapes of the credentials-domain unary Remote methods.
 *
 * `credentials/describe` answers the record DIRECTLY — the old
 * `{credentials: {...}}` wrapper is gone. `set` and `unset` answer `void`, so a
 * successful response omits the `value` key entirely.
 */
export interface CredentialsRpc {
  'credentials/describe': { payload: { refs: string[] }; value: Record<string, CredentialView> }
  'credentials/set': { payload: { ref: string; value: string }; value: void }
  'credentials/unset': { payload: { ref: string }; value: void }
}

/** One configured provider route as `llm/listProviders` reports it. */
export interface LlmProviderView {
  readonly id: string
  readonly name: string
}

/**
 * Payload/value shapes of the llm-domain unary Remote methods.
 *
 * The catalog list answers a BARE ARRAY: the old `{providers: [...]}` and
 * `{groups, failures}` wrappers are gone. The full model catalog moved to
 * `session/modelCatalog` (see ./sessions).
 */
export interface LlmRpc {
  'llm/listProviders': { payload: Record<string, never>; value: LlmProviderView[] }
  'llm/listConfigurableProviders': { payload: Record<string, never>; value: ConfigurableProviderView[] }
  'llm/discoverModels': {
    payload: {
      settingsNs: string
      /** The draft endpoint fields were nested under `request` in 0.1.5-rc.2. */
      request: { provider?: string; baseURL?: string; api?: string; apiKey?: string }
    }
    value: DiscoveredModelView[]
  }
}

/** One agent preset as the presets list reports it. */
export interface AgentPresetEntry {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  /** Present when the preset failed to compose; the reason text. */
  readonly broken?: string
}

/** Payload/value shapes of the agent-preset-domain unary Remote methods. */
export interface AgentPresetsRpc {
  'agentPresets/list': {
    payload: Record<string, never>
    value: { presets: AgentPresetEntry[]; authorable: boolean }
  }
  'agentPresets/read': {
    payload: { agentPreset: string }
    value: { agentPreset: string; trust: 'system' | 'user'; content: string; name?: string; description?: string }
  }
  /** Selects the preset for one agent; answers the accepted preset id. */
  'agentPresets/select': { payload: { agentId: string; agentPreset: string }; value: string }
  'agentPresets/copy': { payload: { from: string; id: string; name?: string }; value: void }
  'agentPresets/deletePreset': { payload: { id: string }; value: void }
}
