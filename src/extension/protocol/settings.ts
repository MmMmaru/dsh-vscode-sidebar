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

/** Payload/value shapes of the settings/credentials/llm RPC methods. */
export interface SettingsRpc {
  'settings.describe': {
    payload: Record<string, never>
    value: { writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }
  }
  'settings.openDocument': { payload: Record<string, never>; value: { opened: true } }
  'settings.update': {
    payload: { ns: string; patch: object; expectedRevision?: number }
    value: SettingsNamespaceView
  }
  'settings.replace': {
    payload: { ns: string; section: object; expectedRevision?: number }
    value: SettingsNamespaceView
  }
  'settings.mutate': {
    payload: { ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }
    value: SettingsNamespaceView
  }
}

/** Payload/value shapes of the credentials-domain RPC methods. */
export interface CredentialsRpc {
  'credentials.describe': { payload: { refs: string[] }; value: { credentials: Record<string, CredentialView> } }
  'credentials.set': { payload: { ref: string; value: string }; value: Record<string, never> }
  'credentials.unset': { payload: { ref: string }; value: Record<string, never> }
}

/** Payload/value shapes of the llm-domain RPC methods. */
export interface LlmRpc {
  'llm.providers': { payload: Record<string, never>; value: { providers: ConfigurableProviderView[] } }
  'llm.models': { payload: Record<string, never>; value: { groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] } }
  'llm.discoverModels': {
    payload: { settingsNs: string; provider?: string; baseURL?: string; api?: string; apiKey?: string }
    value: { models: DiscoveredModelView[] }
  }
}
