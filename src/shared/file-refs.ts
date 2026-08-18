/**
 * File-reference extraction (shared by the webview renderer and the extension
 * resolver). Pure module: no vscode/node imports, safe for the browser bundle
 * and for node unit tests alike.
 *
 * The matcher is deliberately conservative. A reference looks like
 * `path:line`, `path:line:col` or `path:startLine-endLine` where the path part
 * is a relative/absolute/Windows path and the trailing number(s) are line
 * coordinates. Candidates are validated after the raw regex match so URLs
 * (`https://host:8080/...`), wall-clock times (`12:30`) and bare `word:123`
 * fragments are rejected.
 */

/** One parsed `path:line[:col]` / `path:start-end` reference. */
export interface FileRef {
  /** The path part exactly as it appears in the text. */
  path: string
  /** 1-based start line. */
  line: number
  /** 1-based end line, when the ref spells a range (`file.ts:10-20`). */
  endLine?: number
  /** 1-based column, when the ref spells `file.ts:10:5`. */
  col?: number
  /** [start, end) offsets of the whole match inside the source text. */
  start: number
  end: number
}

/**
 * Candidate matcher: any run of path-ish characters followed by `:digits`,
 * with an optional `-digits` range and an optional `:digits` column. The
 * lookbehind stops mid-word matches like `abc123:45` inside `xyzabc123`.
 */
const FILE_REF_RE = /(?<![A-Za-z0-9_/\\])((?:(?:[A-Za-z]:)[\\/])?[A-Za-z0-9_./\\~-]+):(\d+)(?:-(\d+))?(?::(\d+))?/g

/** A path part that is only digits (e.g. the `12` of `12:30`). */
const DIGITS_ONLY = /^\d+$/

/** URL scheme separators (`https://host:8080` must not match). */
const HAS_SCHEME = /:\/\//

/** Protocol-relative URL fragment (`//host:8080` must not match). */
const PROTOCOL_RELATIVE = /^\/\//

/** Windows drive prefix (`C:\...` or `C:/...`). */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/

/**
 * Post-validation of one candidate path: it must look like a file path (contain
 * a separator or an extension) and must not be a URL or a bare number.
 * @param path - the raw path part captured by the regex.
 */
function looksLikePath(path: string): boolean {
  if (path === '') return false
  if (DIGITS_ONLY.test(path)) return false
  if (HAS_SCHEME.test(path)) return false
  if (PROTOCOL_RELATIVE.test(path)) return false
  if (path.endsWith('.') || path.endsWith(',')) return false
  const hasSeparator = path.includes('/') || path.includes('\\')
  const hasExtension = /\.[A-Za-z0-9]+$/.test(path)
  const isHome = path.startsWith('~/')
  return hasSeparator || hasExtension || isHome || WIN_DRIVE.test(path)
}

/**
 * Scan a text fragment for `path:line` references.
 * @param text - the source text (a markdown text node, typically).
 * @returns every reference found, in source order.
 */
export function extractFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  for (const match of text.matchAll(FILE_REF_RE)) {
    const path = match[1] ?? ''
    const line = Number(match[2])
    const endLine = match[3] === undefined ? undefined : Number(match[3])
    const col = match[4] === undefined ? undefined : Number(match[4])
    if (!looksLikePath(path) || line <= 0) continue
    if (endLine !== undefined && endLine < line) continue
    refs.push({
      path,
      line,
      ...(endLine === undefined ? {} : { endLine }),
      ...(col === undefined ? {} : { col }),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return refs
}

/**
 * Split a text fragment into plain segments and reference spans, for renderers
 * that want to turn each reference into an interactive chip.
 * @param text - the source text.
 * @returns alternating plain strings and `FileRef` objects (refs are kept in
 * source order; plain segments may be empty strings between adjacent refs).
 */
export function splitFileRefs(text: string): Array<string | FileRef> {
  const refs = extractFileRefs(text)
  if (refs.length === 0) return [text]
  const parts: Array<string | FileRef> = []
  let cursor = 0
  for (const ref of refs) {
    if (ref.start > cursor) parts.push(text.slice(cursor, ref.start))
    parts.push(ref)
    cursor = ref.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
