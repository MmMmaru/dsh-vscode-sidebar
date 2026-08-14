/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/host/apiproxy/src/api/rpc-map.ts (+ method domains)
 * RPC method registry. Simplification vs upstream: the upstream map derives
 * payload/value types from method signatures (Parameters/ReturnType through
 * RpcRequest/RpcResponse); here each row carries the payload/value pair
 * directly, which is the shape a generic string-method client consumes.
 * `respond` is a client-response (POST /api/respond), so it is absent here.
 */

import type { SessionRpc } from './sessions'
import type { HostRpc } from './host'
import type { SettingsRpc, CredentialsRpc, LlmRpc } from './settings'
import type { SubagentsRpc } from './subagents'
import type { GoalRef, SkillEntry, WorkspaceView } from './views'
import type { GoalId, SessionId, WorkspaceId } from './brand'

/** Payload/value shapes of the workspace-domain RPC methods. */
export interface WorkspaceRpc {
  'workspace.list': { payload: Record<string, never>; value: { items: WorkspaceView[]; archivedSessionIds: SessionId[] } }
  'workspace.create': { payload: { path: string }; value: { workspace: WorkspaceView; created: boolean } }
  'workspace.rename': { payload: { workspaceId: WorkspaceId; title: string }; value: { workspace: WorkspaceView } }
  'workspace.delete': { payload: { workspaceId: WorkspaceId }; value: { deleted: true } }
  'workspace.insertBefore': {
    payload: { workspaceId: WorkspaceId; beforeWorkspaceId?: WorkspaceId }
    value: { workspaceIds: WorkspaceId[] }
  }
  'workspace.insertSessionBefore': {
    payload: { workspaceId: WorkspaceId; sessionId: SessionId; beforeSessionId?: SessionId }
    value: { workspace: WorkspaceView }
  }
  'workspace.archiveSession': { payload: { sessionId: SessionId }; value: { archivedSessionIds: SessionId[] } }
}

/** Payload/value shapes of the goal-domain RPC methods (mutations only; reads ride projections). */
export interface GoalsRpc {
  'goal.create': { payload: { sessionId: SessionId; objective: string; maxGoalRounds?: number }; value: { ref: GoalRef } }
  'goal.edit': {
    payload: { sessionId: SessionId; ref: GoalRef; objective?: string; maxGoalRounds?: number }
    value: { ref: GoalRef }
  }
  'goal.pause': { payload: { sessionId: SessionId; ref: GoalRef }; value: { ref: GoalRef } }
  'goal.resume': { payload: { sessionId: SessionId; ref: GoalRef }; value: { ref: GoalRef } }
  'goal.complete': { payload: { sessionId: SessionId; ref: GoalRef }; value: { ref: GoalRef } }
  'goal.clear': { payload: { sessionId: SessionId; ref: GoalRef }; value: { cleared: true } }
}

/** Payload/value shapes of the skills-domain RPC methods. */
export interface SkillsRpc {
  'skill.list': { payload: { sessionId: SessionId }; value: { skills: readonly SkillEntry[] } }
}

/**
 * Method name → { payload, value }. Map keys are the wire path segments
 * (POST /api/<method>). Agent-preset methods are omitted in this minimal copy
 * (they join when the settings UI needs them).
 */
export interface RpcMethodMap extends
  SessionRpc,
  HostRpc,
  WorkspaceRpc,
  GoalsRpc,
  SkillsRpc,
  SettingsRpc,
  CredentialsRpc,
  LlmRpc,
  SubagentsRpc {}

/** Any registered RPC method name. */
export type RpcMethod = keyof RpcMethodMap

/** Business request payload of method K. */
export type RequestPayload<K extends RpcMethod> = RpcMethodMap[K]['payload']

/** Business return value of method K (the ok slot of the result). */
export type ResponseValue<K extends RpcMethod> = RpcMethodMap[K]['value']

/** Re-export to keep GoalId referenced in this module's public surface. */
export type { GoalId }
