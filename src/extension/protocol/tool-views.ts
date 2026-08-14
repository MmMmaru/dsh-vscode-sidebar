/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/core/tools/src/presentation.ts
 * Type-only full copy of the tool render-intent vocabulary (the `ContentBlock`
 * import is rewired to the local vendored llm module).
 */

import type { ContentBlock } from './llm'

/**
 * Category of a tool call, used by a UI to pick an icon or treatment. The
 * provider-neutral vocabulary lets tools describe themselves without depending
 * on a particular client; `other` is the default.
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/**
 * A file location a tool reads or modifies, so a capable UI can "follow along" —
 * highlight or jump to the file (and line) as the tool runs.
 */
export interface FileLocation {
  path: string
  line?: number
}

/**
 * A single-file change a tool is about to make, for a UI that renders inline
 * diffs. `oldText` is `null` for a new-file create (nothing to diff against);
 * an overwrite also uses `null`, because a call-time presenter has no access
 * to the file's prior content.
 */
export interface FileDiff {
  path: string
  /** Prior content, or `null` for a new file / an overwrite. */
  oldText: string | null
  /** Content after the change. */
  newText: string
}

/** Provider-neutral pending-call presentation. Tools declare one tagged intent. */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

/**
 * The default card: a titled tool-call row with an optional category icon, a
 * salient raw input, extra content blocks, and follow-along file locations.
 */
export interface GenericCallView {
  card: 'generic'
  /** Human-readable, always-visible label describing what THIS call does. */
  title: string
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind
  /** The salient input to show in a detail/expanded view. */
  rawInput?: unknown
  /** UI-facing content blocks to show on the pending call alongside the title. */
  content?: ContentBlock[]
  /** Files this call reads/modifies, for editor follow-along. */
  locations?: FileLocation[]
}

/**
 * A call that IS a shell command running in a working directory: a capable UI
 * renders it as a terminal card (cwd-headed, with the command as the title).
 */
export interface TerminalCallView {
  card: 'terminal'
  /** The command, shown as the terminal card's title / header line. */
  title: string
  /** A human-readable one-line summary rendered ABOVE the terminal card. */
  description?: string
  /** Working directory the command runs in (relative paths resolve against the session workspace). */
  cwd?: string
}

/**
 * A call that creates or modifies files, rendered as an inline diff card by a
 * capable UI. The diffs are derived from the call ARGUMENTS.
 */
export interface DiffCallView {
  card: 'diff'
  /** Card header (e.g. `Write foo.txt`). */
  title: string
  /** One entry per file the call changes. */
  diffs: FileDiff[]
  /** Files this call modifies, for editor follow-along (usually the diffs' paths). */
  locations?: FileLocation[]
}

/** One numbered line of a file, the unit a ReadResultView carries. */
export interface ReadFileLine {
  /** 1-based line number in the file. */
  number: number
  /** The line without its trailing newline. */
  text: string
}

/**
 * How a tool wants the COMPLETED call shown — the result state, after `execute`
 * returns. A `card`-tagged union mirroring ToolCallView.
 */
export type ToolResultView =
  | GenericResultView
  | TerminalResultView
  | DiffResultView
  | SearchResultView
  | ReadResultView
  | WebResultView

/** The default completed card: an optional replacement title and reformatted content. */
export interface GenericResultView {
  card: 'generic'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** UI-facing result content, reformatted from the model-facing result. */
  content?: ContentBlock[]
}

/** The completed state of a TerminalCallView: captured output and exit status. */
export interface TerminalResultView {
  card: 'terminal'
  /** Replacement title for the completed call. */
  title?: string
  /** Captured command output (stdout+stderr as the tool chooses to combine them). */
  output?: string
  /** Process exit code, when the run ended by exiting (not a signal). */
  exitCode?: number
  /** Signal name that killed the process (e.g. `SIGTERM`). Mutually exclusive with `exitCode`. */
  signal?: string
}

/** A completed file mutation rendered as an inline diff card. */
export interface DiffResultView {
  card: 'diff'
  /** Replacement title for the completed call. */
  title?: string
  /** The change to show, in file order — applied contextual hunks, or a whole-file diff. */
  diffs: FileDiff[]
}

/** One matched line inside a SearchFileMatches group. */
export interface SearchLineMatch {
  /** 1-based line number of the match within its file. */
  lineNumber: number
  /** The matched line text (per-line preview budget already applied). */
  line: string
}

/** One file's grouped content matches, in first-seen file order. */
export interface SearchFileMatches {
  /** The file the matches belong to (the model-facing display path). */
  path: string
  /** The file's matched lines, in output order. */
  matches: SearchLineMatch[]
}

/** A completed content search (grep) rendered as a search card grouped by file. */
export interface SearchMatchesResultView {
  card: 'search'
  shape: 'matches'
  /** Replacement title for the completed call. */
  title?: string
  /** Matched lines grouped by file, in first-seen file order. */
  files: SearchFileMatches[]
  /** Whether the tool capped the inline result. */
  truncated: boolean
  /** Total matches the search found before capping. */
  total: number
}

/** A completed path search (glob) rendered as a flat path list. */
export interface SearchPathsResultView {
  card: 'search'
  shape: 'paths'
  /** Replacement title for the completed call. */
  title?: string
  /** The discovered paths, in the tool's result order. */
  paths: string[]
  /** Whether the tool capped the inline result. */
  truncated: boolean
  /** Total paths the search found before capping. */
  total: number
}

/** A completed search rendered as a search card (matches or paths variant). */
export type SearchResultView = SearchMatchesResultView | SearchPathsResultView

/**
 * A completed file read rendered as a line-numbered, optionally
 * syntax-highlighted code view by a capable UI.
 */
export interface ReadResultView {
  card: 'read'
  /** Replacement title for the completed call. */
  title?: string
  /** The read file's path (the model-facing path). */
  path: string
  /** The 1-based first line the window requested. */
  offset: number
  /** The returned window's lines, in file order, each keeping its file line number. */
  lines: ReadFileLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** A syntax-highlighting language hint derived from the file extension. */
  lang?: string
  /** The model-facing result content with its envelope stripped. */
  content?: ContentBlock[]
}

/** One citeable source in a completed WebSearchResultView. */
export interface WebSource {
  /** The source URL. */
  url: string
  /** The source title, when the provider returned one. */
  title?: string
  /** A short excerpt or summary, when the provider returned one. */
  snippet?: string
  /** Publication/crawl timestamp as an ISO-8601 string, when present. */
  publishedAt?: string
}

/** A completed web retrieval rendered as a structured card by a capable UI. */
export type WebResultView = WebSearchResultView | WebFetchResultView

/** The completed state of a `web_search` call. */
export interface WebSearchResultView {
  card: 'web'
  kind: 'search'
  /** Replacement title for the completed call. */
  title?: string
  /** The faithful, structured sources the model cited. */
  sources: WebSource[]
  /** The provider-generated answer text, when any. */
  answer?: string
  /** True when the web service cut the source list to honor the result cap. */
  truncated: boolean
}

/** The completed state of a `web_fetch` call. */
export interface WebFetchResultView {
  card: 'web'
  kind: 'fetch'
  /** Replacement title for the completed call. */
  title?: string
  /** The final URL after allowed redirects. */
  url: string
  /** HTTP status code of the fetched response. */
  statusCode: number
  /** True when the provider capped or trimmed the rendered text. */
  truncated: boolean
}
