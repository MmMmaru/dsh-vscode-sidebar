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
  /** 1-based start line; absent for references without a line suffix
   * (markdown links like `[a.py](/x/a.py)`), which open at line 1. */
  line?: number
  /** 1-based end line, when the ref spells a range (`file.ts:10-20`, `#L10-L20`). */
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

/** URL scheme of two or more letters (`https:`, `mailto:`); a single letter
 * before the colon is a Windows drive prefix, not a scheme. */
const HAS_LONG_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/

/** GitHub-style line fragment (`#L18` / `#L18-L40`). */
const LINE_FRAGMENT = /^L(\d+)(?:-L(\d+))?$/

/**
 * Parse a markdown link href as a file-jump target (the `a`-renderer side of
 * the code-jump feature; plain-text scanning stays with extractFileRefs).
 * Rejects anything that is not a local file reference: scheme URLs
 * (`https://…`, `mailto:…`), protocol-relative URLs, pure `#` anchors and
 * non-line fragments (`#section`). Accepts absolute / relative / `~/` /
 * Windows-drive paths, an optional GitHub-style `#L<n>` / `#L<n>-L<m>`
 * fragment, and the colon suffixes of extractFileRefs (`:line`, `:line-line`,
 * `:line:col`). A path without any line suffix yields a ref with `line`
 * absent (the opener reveals line 1).
 * @param href - the raw markdown link href.
 * @returns the parsed reference, or null when the href is not a local file.
 */
export function parseFileHref(href: string): FileRef | null {
  if (href === '' || href.startsWith('#')) return null
  if (HAS_SCHEME.test(href) || PROTOCOL_RELATIVE.test(href) || HAS_LONG_SCHEME.test(href)) return null
  // Strip and parse an optional fragment; only GitHub line fragments count as
  // jump coordinates, anything else disqualifies the href as a file target.
  let rest = href
  let line: number | undefined
  let endLine: number | undefined
  const hashIndex = rest.indexOf('#')
  if (hashIndex >= 0) {
    const fragment = rest.slice(hashIndex + 1)
    rest = rest.slice(0, hashIndex)
    const match = LINE_FRAGMENT.exec(fragment)
    if (match === null) return null
    line = Number(match[1])
    endLine = match[2] === undefined ? undefined : Number(match[2])
    if (line <= 0 || (endLine !== undefined && endLine < line)) return null
  }
  if (rest === '' || !looksLikePath(rest)) return null
  if (line !== undefined) {
    // The fragment supplied the coordinates; a colon line suffix in the path
    // itself would make the pair ambiguous — reject instead of mis-resolving.
    if (extractFileRefs(rest).length > 0) return null
    return { path: rest, line, ...(endLine === undefined ? {} : { endLine }), start: 0, end: href.length }
  }
  // No fragment: the colon suffixes ride the shared scanner; a full-span match
  // wins, a partial/absent match means the whole href is the bare path.
  const refs = extractFileRefs(rest)
  const full = refs.length === 1 ? refs[0] : undefined
  if (full !== undefined && full.start === 0 && full.end === rest.length) return full
  if (refs.length > 0) return null // colon digits mid-href: ambiguous, not a jump target
  return { path: rest, start: 0, end: href.length }
}
