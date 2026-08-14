/**
 * SidebarProvider: registers the sidebar WebviewView and injects the Vite
 * build output (media/main.js + media/style.css) under a strict CSP.
 * Contract: ARCHITECTURE.md section 4.5.
 */

import * as vscode from 'vscode'
import type { Bridge } from './bridge'

/**
 * The sidebar view provider. Holds the live view so toolbar commands can
 * reveal it, and hands each created webview to the bridge.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  /** View id matching package.json contributes.views. */
  static readonly viewType = 'dsh.sidebar'

  private view: vscode.WebviewView | null = null

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: Bridge,
  ) {}

  /**
   * VSCode callback: configure the webview (scripts, local roots, CSP) and
   * attach it to the bridge.
   * @param view - the webview view being resolved.
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    }
    view.webview.html = renderHtml(view.webview, this.context.extensionUri)
    const attached = this.bridge.attach(view.webview)
    view.onDidDispose(() => {
      attached.dispose()
      if (this.view === view) this.view = null
    })
  }

  /** Reveal the sidebar view (used by toolbar commands); no-op when uncreated. */
  reveal(): void {
    this.view?.show(true)
  }

  /** The live view's webview, when the view exists. */
  get activeWebview(): vscode.Webview | null {
    return this.view?.webview ?? null
  }
}

/**
 * Build the webview HTML referencing the fixed Vite output names.
 * CSP allows only the extension's own media/ for scripts/styles plus data:
 * images (attachments render as data URIs later).
 * @param webview - the target webview (for cspSource/asWebviewUri).
 * @param extensionUri - the extension root URI.
 * @returns the full HTML document.
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'))
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'))
  const nonce = crypto.randomUUID().replaceAll('-', '')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>DeepSeek</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`
}
