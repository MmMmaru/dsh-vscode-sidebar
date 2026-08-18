/**
 * Path resolution for the code-jump feature (TODO 5), kept free of the
 * `vscode` module so unit tests can import it without an alias.
 *
 * Resolution order (per product decision): absolute paths are used as-is;
 * relative paths resolve against the session cwd first, then the workspace
 * root; `~/` expands to the user home. The first candidate that exists wins.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** A parsed file reference, as sent by the webview (`ide-open-file`). */
export interface OpenFileTarget {
  /** The path part exactly as it appeared in the text. */
  path: string
  /** 1-based start line. */
  line: number
  /** 1-based end line, for `file.ts:10-20` ranges. */
  endLine?: number
  /** 1-based column, for `file.ts:10:5`. */
  col?: number
  /** Session working directory (workspace-relative sessions share it). */
  cwd?: string
}

/**
 * Candidate absolute paths for one reference, in resolution order.
 * @param target - the parsed reference.
 * @param workspaceRoot - fallback base when the session cwd is absent.
 */
export function resolveCandidates(target: OpenFileTarget, workspaceRoot: string): string[] {
  const raw = target.path
  const home = os.homedir()
  const withHome = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
  const candidates: string[] = []
  if (path.isAbsolute(withHome)) {
    candidates.push(withHome)
    return candidates
  }
  const bases = [target.cwd, workspaceRoot].filter((b): b is string => b !== undefined && b !== '')
  // De-duplicate while preserving order (cwd === workspaceRoot is common).
  for (const base of bases) {
    const joined = path.join(base, withHome)
    if (!candidates.includes(joined)) candidates.push(joined)
  }
  return candidates
}

/** First existing candidate, or null when none resolves. */
export function resolveExistingFile(target: OpenFileTarget, workspaceRoot: string): string | null {
  for (const candidate of resolveCandidates(target, workspaceRoot)) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Unreadable path (permissions, invalid characters): try the next one.
    }
  }
  return null
}
