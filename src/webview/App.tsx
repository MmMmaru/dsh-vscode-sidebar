/**
 * Minimal W0 webview page: proves the bridge handshake by rendering the init
 * payload (cwd, host version, session count) and the live host status.
 * W2-W6 replace this with the real chat UI.
 */

import { useEffect, useState, type JSX } from 'react'
import type { HostStatus, InitPayload } from '../shared/bridge'
import { onHostStatus, waitInit } from './api'

/** Root component: waits for init, then shows connection facts. */
export function App(): JSX.Element {
  const [init, setInit] = useState<InitPayload | null>(null)
  const [status, setStatus] = useState<HostStatus>('starting')

  useEffect(() => {
    void waitInit().then(setInit)
    return onHostStatus(setStatus)
  }, [])

  return (
    <main className="app">
      <h1>DeepSeek Harness</h1>
      <p className={`status status-${status}`}>host: {status}</p>
      {init === null ? (
        <p>正在连接 dsh host…</p>
      ) : (
        <dl>
          <dt>cwd</dt>
          <dd>{init.cwd}</dd>
          <dt>host version</dt>
          <dd>{init.hostVersion}</dd>
          <dt>sessions</dt>
          <dd>{init.sessions.length}</dd>
        </dl>
      )}
    </main>
  )
}
