/**
 * Extension entry: activate wires HostManager/DshClient/Bridge, registers the
 * SidebarProvider and the toolbar commands; deactivate disposes the client and
 * (unless configured to keep it) the spawned host.
 * Contract: ARCHITECTURE.md section 4.1.
 */

import * as vscode from 'vscode'
import { Bridge } from './bridge'
import { DshClient } from './dsh-client'
import { HostManager } from './host-manager'
import { SidebarProvider, renderHtml } from './sidebar-provider'

let host: HostManager | null = null
let client: DshClient | null = null

/**
 * VSCode activation hook: build the connection layer and register views/commands.
 * @param context - the extension context.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('DSH')
  const hostManager = new HostManager(log)
  hostManager.basePort = vscode.workspace.getConfiguration('dsh').get<number>('port', 3080)
  const dshClient = new DshClient()
  dshClient.onLog = (line: string) => log.appendLine(line)
  const bridge = new Bridge(dshClient, hostManager)
  const provider = new SidebarProvider(context, bridge)

  host = hostManager
  client = dshClient

  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider),
    vscode.commands.registerCommand('dsh.newChat', () => {
      provider.reveal()
      const target = provider.activeWebview
      if (target) bridge.postCommand('newChat', [target])
    }),
    vscode.commands.registerCommand('dsh.openSettings', () => {
      provider.reveal()
      const target = provider.activeWebview
      if (target) bridge.postCommand('openSettings', [target])
    }),
    vscode.commands.registerCommand('dsh.openFullPanel', () => openFullPanel(context, bridge)),
  )
}

/** VSCode deactivation hook: close WS; kill the host only when we spawned it and config says so. */
export function deactivate(): void {
  const keepHost = vscode.workspace.getConfiguration('dsh').get<boolean>('keepHostOnExit', false)
  void client?.dispose()
  if (!keepHost) void host?.dispose()
}

/**
 * Open the full-panel (editor-area) webview backed by the same bridge.
 * @param context - the extension context (for the extension URI).
 * @param bridge - the shared bridge.
 */
function openFullPanel(context: vscode.ExtensionContext, bridge: Bridge): void {
  const panel = vscode.window.createWebviewPanel('dsh.fullPanel', 'DeepSeek', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    retainContextWhenHidden: true,
  })
  panel.webview.html = renderHtml(panel.webview, context.extensionUri)
  const attached = bridge.attach(panel.webview)
  panel.onDidDispose(() => attached.dispose())
}
