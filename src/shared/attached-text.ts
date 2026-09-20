/**
 * Attached text & VS Code plugin context handling.
 * Pure module: safe for webview, extension host, and unit tests alike.
 */

export const VSCODE_CONTEXT_PROMPT = `[DSH_VSCODE_CONTEXT]
Environment: DeepSeek Harness VS Code sidebar plugin.
Instruction: When referencing or explaining workspace files, code symbols, or line coordinates in your explanations, always format them as markdown links with the file name and the target as an absolute file path with line numbers, using the format [\`filename\`](/absolute/path/to/filename:line) or [\`filename\`](/absolute/path/to/filename:startLine-endLine) (e.g. [\`index.ts\`](/path/to/src/index.ts:10) or [\`App.tsx\`](/path/to/src/App.tsx:15-30)), so that references in the sidebar render as clickable code chips that immediately open and locate in VS Code.
[/DSH_VSCODE_CONTEXT]`

const CONTEXT_RE = /\[DSH_VSCODE_CONTEXT\][\s\S]*?\[\/DSH_VSCODE_CONTEXT\]\n?/g
const ATTACHED_TEXT_RE = /\[DSH_ATTACHED_TEXT(?:\s+name="([^"]*)")?(?:\s+lines="([^"]*)")?(?:\s+path="([^"]*)")?\]([\s\S]*?)\[\/DSH_ATTACHED_TEXT\]/g
const LEGACY_IDE_BLOCK_RE = /### (?:选中代码|文件内容|文件)(?:（([^）]+)）|：([^\n]+))?\n\n```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g

export interface AttachedTextBlock {
  name: string
  lines: number
  path?: string
  content: string
}

export interface ParsedUserMessage {
  cleanText: string
  attachedTexts: AttachedTextBlock[]
}

/** Remove [DSH_VSCODE_CONTEXT] block from prompt text. */
export function stripVscodeContext(text: string): string {
  return text.replace(CONTEXT_RE, '').trim()
}

/**
 * Assemble the exact prompt text sent to the host. The VS Code environment
 * guide is appended only to prompts AFTER the session's first one: the host
 * derives the session title from the FIRST human message, so keeping the guide
 * out of that message guarantees titles never contain plugin-context content,
 * while later prompts still carry the absolute path:line reference guidance.
 * Slash commands never carry the guide (the host executes them verbatim).
 * @param enriched - IDE-context-enriched user text (or the raw slash command).
 * @param hasPriorUserMessage - whether the timeline already holds a user message.
 * @param isSlashCommand - whether the prompt is a host slash command.
 * @returns the exact text to submit as the prompt's text block.
 */
export function assemblePromptText(enriched: string, hasPriorUserMessage: boolean, isSlashCommand: boolean): string {
  if (isSlashCommand || !hasPriorUserMessage) return enriched
  return `${enriched}\n\n${VSCODE_CONTEXT_PROMPT}`
}

/** Threshold to determine if pasted text should be condensed into a .txt attachment block. */
export const PASTE_CONDENSE_THRESHOLD = {
  minLines: 10,
  minChars: 400,
}

/** Check if text is long enough to be condensed into a .txt attachment. */
export function isLongText(text: string): boolean {
  const lines = text.split('\n').length
  return lines >= PASTE_CONDENSE_THRESHOLD.minLines || text.length >= PASTE_CONDENSE_THRESHOLD.minChars
}

const COMMON_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'ini', 'csv', 'tsv',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'sh', 'bash', 'zsh',
  'html', 'htm', 'css', 'scss', 'less', 'sql', 'graphql', 'vue', 'svelte', 'dart', 'kt', 'swift',
  'env', 'gitignore', 'dockerfile', 'makefile',
])

/** Check if a file is a text-based document or source code file. */
export function isTextFile(file: { name: string; type?: string }): boolean {
  if (file.type && file.type.startsWith('text/')) return true
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  return COMMON_TEXT_EXTENSIONS.has(ext)
}

/** Wrap long text or code into a [DSH_ATTACHED_TEXT] container. */
export function wrapAttachedText(name: string, content: string, path?: string): string {
  const lineCount = content.split('\n').length
  const pathAttr = path ? ` path="${path}"` : ''
  return `[DSH_ATTACHED_TEXT name="${name}" lines="${lineCount}"${pathAttr}]\n${content}\n[/DSH_ATTACHED_TEXT]`
}

/**
 * Parse a raw user message string into clean conversational prompt text
 * and extracted attached text blocks (for compact UI rendering).
 */
export function parseUserMessage(rawText: string): ParsedUserMessage {
  let text = stripVscodeContext(rawText)
  const attachedTexts: AttachedTextBlock[] = []

  // 1. Extract modern [DSH_ATTACHED_TEXT] blocks
  text = text.replace(ATTACHED_TEXT_RE, (_, name, linesStr, path, content) => {
    const trimmedContent = (content as string).trim()
    const lines = linesStr ? parseInt(linesStr, 10) : trimmedContent.split('\n').length
    attachedTexts.push({
      name: name || (path ? path.slice(path.lastIndexOf('/') + 1) : 'text.txt'),
      lines: isNaN(lines) ? trimmedContent.split('\n').length : lines,
      path: path || undefined,
      content: trimmedContent,
    })
    return ''
  })

  // 2. Extract legacy IDE blocks (if any exist in history or un-wrapped formats)
  text = text.replace(LEGACY_IDE_BLOCK_RE, (match, path1, path2, body) => {
    const filePath = (path1 || path2 || '').trim()
    const content = (body as string).trim()
    const lineCount = content.split('\n').length
    const fileName = filePath ? filePath.slice(filePath.lastIndexOf('/') + 1) : 'code.txt'
    attachedTexts.push({
      name: fileName,
      lines: lineCount,
      path: filePath || undefined,
      content,
    })
    return ''
  })

  return {
    cleanText: text.trim(),
    attachedTexts,
  }
}
