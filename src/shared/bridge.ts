/**
 * Bridge message protocol (extension host <-> webview), the frozen contract of
 * ARCHITECTURE.md section 3. All messages are JSON objects carried by
 * `vscode.postMessage` / `onDidReceiveMessage`. Shared by both sides: the
 * extension posts ExtensionMessage, the webview posts WebviewMessage.
 */

import type { SessionId } from '../extension/protocol/brand'
import type { MuxFrame, HostFrame } from '../extension/protocol/events'

/** Host lifecycle states pushed to the webview. */
export type HostStatus = 'starting' | 'ready' | 'down'

/**
 * UI-facing session list row (SessionMeta of ARCHITECTURE.md section 5.4).
 * Derived from the vendored SessionSummary by the bridge: `title` is read from
 * the row's `title` projection (null when absent).
 */
export interface SessionMeta {
  sessionId: SessionId
  /** Session title from the projection baseline; null means "no title yet". */
  title: string | null
  /** The later of creation and the latest human-authored prompt (epoch ms). */
  updatedAt: number
  /** Whether the attached agent is currently running. */
  running: boolean
  /** Conversation-not-started bit: true while no turn has run. */
  blank: boolean
  /** fork/spawn lineage; absent for root sessions. */
  parentSessionId?: SessionId
  /** Coarse durable origin used by navigation surfaces. */
  origin?: 'subagent'
  /** Session working directory; the webview filters the list by the workspace cwd. */
  cwd?: string
}

/** Payload of the `init` message answering `ready`. */
export interface InitPayload {
  /** Current VSCode workspace root (session ownership anchor). */
  cwd: string
  /** dsh host app version reported by `host.describe`. */
  hostVersion: string
  /** Full session list; the webview filters by `cwd`. */
  sessions: SessionMeta[]
}

/** Messages the webview sends to the extension host. */
export type WebviewMessage =
  /** webview mounted; requests initialization. */
  | { type: 'ready' }
  /** Passthrough dsh RPC; `method` is e.g. `session.list`. Answered by `rpc-result`. */
  | { type: 'rpc'; id: string; method: string; params?: unknown }

/** Messages the extension host sends to the webview. */
export type ExtensionMessage =
  /** Initialization data answering `ready`. */
  | ({ type: 'init' } & InitPayload)
  /** RPC answer paired by `id`. */
  | { type: 'rpc-result'; id: string; result?: unknown; error?: string }
  /** dsh event stream passthrough. */
  | { type: 'event'; channel: 'mux' | 'host'; frame: MuxFrame | HostFrame }
  /** Host lifecycle notification. */
  | { type: 'host-status'; status: HostStatus }
  /**
   * Toolbar command forwarded to the webview (extension of the frozen table for
   * the W1 commands; the webview store owns the actual behavior).
   */
  | { type: 'command'; command: 'newChat' | 'openSettings' }
