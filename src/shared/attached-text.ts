/**
 * Attached text & VS Code plugin context handling.
 * Pure module: safe for webview, extension host, and unit tests alike.
 */

export const VSCODE_CONTEXT_PROMPT = `[DSH_VSCODE_CONTEXT]
Environment: DeepSeek Harness VS Code sidebar plugin.
Instruction: When referencing workspace files, code symbols, or line coordinates in your explanations or tool calls, always prefer using absolute file paths in standard path:line format (e.g. /path/to/file.ts:10 or /path/to/file.ts:10-25) so that references in the sidebar are clickable and openable in VS Code.
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
