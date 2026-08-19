/**
 * Extension-side file opening for the webview's code-jump feature: resolves a
 * `path:line` reference (see src/shared/file-refs.ts) to an existing file and
 * opens it in the IDE, revealing and highlighting the target range.
 *
 * Pure resolution logic lives in ./open-file-resolve (vscode-free, unit
 * testable); this module adds the vscode side (open document / reveal range).
 */

import * as vscode from 'vscode'
import { resolveExistingFile, type OpenFileTarget } from './open-file-resolve'

/**
 * Open the file at the target range and highlight it in the editor.
 * @param target - the reference to jump to.
 * @param workspaceRoot - fallback resolution base (workspace root).
 * @returns the opened document's fsPath; throws with a message when the file
 * cannot be resolved or opened.
 */
export async function openFileAt(target: OpenFileTarget, workspaceRoot: string): Promise<string> {
  const file = resolveExistingFile(target, workspaceRoot)
  if (file === null) {
    throw new Error(`找不到文件：${target.path}`)
  }
  const document = await vscode.workspace.openTextDocument(file)
  const editor = await vscode.window.showTextDocument(document, { preview: true })
  const lineCount = document.lineCount
  const startLine = Math.min(Math.max((target.line ?? 1) - 1, 0), lineCount - 1)
  const endLine =
    target.endLine === undefined
      ? startLine
      : Math.min(Math.max(target.endLine - 1, startLine), lineCount - 1)
  const col = target.col === undefined ? 0 : Math.max(target.col - 1, 0)
  const start = new vscode.Position(startLine, col)
  const end = new vscode.Position(endLine, document.lineAt(endLine).text.length)
  const range = new vscode.Range(start, end)
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
  editor.selection = new vscode.Selection(start, end)
  return file
}
