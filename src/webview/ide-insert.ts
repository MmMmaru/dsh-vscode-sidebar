/**
 * IDE content insertion formatting (pure, unit-testable). The composer asks
 * the extension host for the active editor's selection / whole document and
 * appends the formatted block to the draft: a header line naming the source
 * file plus a fenced code block with the content, language tag derived from
 * the file extension when known.
 */

import type { IdeContentKind } from '../shared/bridge'

/** File extension -> code-fence language tag map (common web/TS/code cases). */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
  swift: 'swift',
}

/**
 * Derive a code-fence language tag from a file path, or undefined when the
 * extension is unknown (the fence then omits the tag).
 * @param path - file path (absolute or relative; only the extension matters).
 * @returns the fence language tag, or undefined.
 */
export function languageFromPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return EXTENSION_LANGUAGES[ext]
}

/**
 * Format IDE content as a draft block: source header + fenced code content.
 * @param kind - what was read ('selection' vs 'active-file').
 * @param text - the editor text.
 * @param path - source file path, when the host reported one.
 * @returns the markdown block to append to the draft.
 */
export function formatIdeInsert(kind: IdeContentKind, text: string, path?: string): string {
  const header = path === undefined
    ? (kind === 'selection' ? '选中代码' : '文件内容')
    : (kind === 'selection' ? `选中代码（${path}）` : `文件：${path}`)
  const language = languageFromPath(path)
  // Trim the trailing newline the document getText() always carries.
  const body = text.replace(/\n$/, '')
  return `### ${header}\n\n\`\`\`${language ?? ''}\n${body}\n\`\`\``
}

/** True when the draft already carries an inserted IDE block (chip/command
 * path), so the send-time auto-injection does not duplicate it. */
export function hasIdeBlock(text: string): boolean {
  return /### (?:选中代码|文件|当前文件)：/.test(text)
}
