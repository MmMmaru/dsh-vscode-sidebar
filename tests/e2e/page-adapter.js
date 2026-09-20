/**
 * E2E page adapter, served as a real script file (not inlined into harness.ts).
 * It stands in for the VS Code webview host: the app's acquireVsCodeApi
 * postMessage travels to the Node harness over WebSocket, and harness messages
 * are re-dispatched through window.postMessage exactly like the real VS Code
 * webview message channel. Messages posted before the socket opens (the app
 * sends "ready" at boot) are queued.
 *
 * The WS port and the view mode ride on the <body> data attributes, so this
 * file stays a static asset.
 */
;(function () {
  var body = document.body
  var port = body.getAttribute('data-ws-port')
  var viewMode = body.getAttribute('data-view-mode') || 'sidebar'
  globalThis.__DSH_VIEW_MODE__ = viewMode

  var ws = new WebSocket('ws://127.0.0.1:' + port + '/ws')
  var queue = []
  globalThis.__e2eWs = ws

  globalThis.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'webview', message: message }))
        } else {
          queue.push(message)
        }
      },
    }
  }

  ws.onopen = function () {
    while (queue.length > 0) ws.send(JSON.stringify({ type: 'webview', message: queue.shift() }))
  }
  ws.onmessage = function (event) {
    var data = JSON.parse(event.data)
    if (data.type === 'host') window.postMessage(data.message, '*')
  }
})()
