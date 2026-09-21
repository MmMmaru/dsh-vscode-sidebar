/**
 * Bridge facade: the single import surface for store slices and components.
 * Picks the real VSCode bridge (./api) or the mock (./mock/bridge) at startup.
 * Switch to mock: append `?mock` to the webview URL, or build with
 * VITE_DSH_MOCK=1.
 */

import type { BridgeClient } from './api'
import * as real from './api'
import { mockBridge } from './mock/bridge'

/** True when the mock bridge is selected (URL query `?mock`, VITE_DSH_MOCK=1, or a globalThis.__DSH_MOCK__ flag for tests). */
export function selectMock(): boolean {
  if ((globalThis as { __DSH_MOCK__?: boolean }).__DSH_MOCK__ === true) return true
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock')) return true
  return import.meta.env?.VITE_DSH_MOCK === '1'
}

/** Whether this webview runs on fake data. */
export const isMock = selectMock()

function getClient(): BridgeClient {
  return selectMock() ? mockBridge : real
}

export const rpc: BridgeClient['rpc'] = (method, params) => getClient().rpc(method, params)
export const onEvent: BridgeClient['onEvent'] = (cb) => getClient().onEvent(cb)
export const onHostStatus: BridgeClient['onHostStatus'] = (cb) => getClient().onHostStatus(cb)
export const onCommand: BridgeClient['onCommand'] = (cb) => getClient().onCommand(cb)
export const waitInit: BridgeClient['waitInit'] = () => getClient().waitInit()
export const respondApproval: BridgeClient['respondApproval'] = (eventId, d) => getClient().respondApproval(eventId, d)
export const respondQuestion: BridgeClient['respondQuestion'] = (eventId, a) => getClient().respondQuestion(eventId, a)
export const followSession: BridgeClient['followSession'] = (address) => getClient().followSession(address)
export const unfollowSession: BridgeClient['unfollowSession'] = () => getClient().unfollowSession()
export const onStreamError: BridgeClient['onStreamError'] = (cb) => getClient().onStreamError(cb)
export const onIdeContent: BridgeClient['onIdeContent'] = (cb) => getClient().onIdeContent(cb)
export const requestIdeContent: BridgeClient['requestIdeContent'] = (k) => getClient().requestIdeContent(k)
export const fetchIdeContent: BridgeClient['fetchIdeContent'] = (k) => getClient().fetchIdeContent(k)
export const openFileInIde: BridgeClient['openFileInIde'] = (t) => getClient().openFileInIde(t)
export const setPort: BridgeClient['setPort'] = (p) => getClient().setPort(p)
export const restartHost: BridgeClient['restartHost'] = () => getClient().restartHost()
export const onPortChanged: BridgeClient['onPortChanged'] = (cb) => getClient().onPortChanged(cb)
export const setEnv: BridgeClient['setEnv'] = (env) => getClient().setEnv(env)
export const onEnvChanged: BridgeClient['onEnvChanged'] = (cb) => getClient().onEnvChanged(cb)
export const openSettingsTab: BridgeClient['openSettingsTab'] = () => getClient().openSettingsTab()
