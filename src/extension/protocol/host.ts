/**
 * Vendored protocol types from deepseek-harness at dsh 0.1.5-rc.2
 * (Typert Remote / api-gateway).
 * Source (built install): dsh-api-workspace-controller/lib/types/types.d.ts
 *
 * MIGRATION NOTE — the whole `host` namespace is gone in 0.1.5-rc.2:
 *   - `host.describe` has NO replacement (no Remote method returns the host
 *     version, and the `$events` ready frame carries only `{home}`).
 *   - `host.openPath`        -> `session/openWorkspacePath` (see ./sessions).
 *   - `host.pickDirectory`   -> `directoryPicker/pick`
 *   - `host.listDirectory`   -> `directoryPicker/list`
 *   - `host.createDirectory` -> `directoryPicker/createDirectory`
 * What remains host-shaped is the directory picker, kept in this module.
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

/** `directoryPicker/list` response value: one directory level plus its ancestry. */
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

/** Payload/value shapes of the directory-picker-domain unary methods. */
export interface DirectoryPickerRpc {
  /** Opens the host's native picker; `null` when the user cancelled. */
  'directoryPicker/pick': { payload: Record<string, never>; value: string | null }
  /** Omitting `path` lists the host account's home directory, never the process cwd. */
  'directoryPicker/list': { payload: { path?: string }; value: DirectoryListing }
  /** Creates one directory and answers its absolute path. */
  'directoryPicker/createDirectory': { payload: { path: string; name: string }; value: string }
}
