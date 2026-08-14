/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/host/apiproxy/src/api/host.ts
 * Host-domain payload/value types. No protocol version upstream: client and
 * host ship together; the plugin checks the host app version itself.
 */

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention. */
  hidden: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /** Ancestor chain from the filesystem root to the listed directory inclusive. */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound. */
  truncated: boolean
}

/** host.describe response value: a one-shot host snapshot. */
export interface HostDescription {
  /** The host app's (apps/cli) package.json version. */
  version: string
  /** The host process working directory. */
  cwd: string
  /** Default provider for new agents, when explicitly configured. */
  provider?: string
  /** Default model for new agents, when explicitly configured. */
  model?: string
  /** Count of currently attached sessions (those with a live agent). */
  attachedSessions: number
  /** Whether this deployment can hand a path to a user-visible native desktop. */
  canOpenPath: boolean
}

/** Payload/value shapes of the host-domain RPC methods. */
export interface HostRpc {
  'host.describe': { payload: Record<string, never>; value: HostDescription }
  'host.pickDirectory': { payload: Record<string, never>; value: { path: string | null } }
  'host.listDirectory': { payload: { path?: string }; value: DirectoryListing }
  'host.createDirectory': { payload: { path: string; name: string }; value: { path: string } }
  'host.openPath': { payload: { path: string }; value: { opened: true } }
}
