/**
 * Vendored protocol types from deepseek-harness at dsh 0.1.5-rc.2
 * (Typert Remote / api-gateway).
 * Sources (built install): each package's `lib/typert.host.js` descriptor.
 *
 * Remote method registry for the unary surface. Each row carries the payload
 * and value pair a generic string-method client consumes, where `payload` is
 * the EXACT `args` object the wire requires.
 *
 * Two rules govern every payload here, both enforced host-side by
 * `assertExactArguments` (missing/renamed top-level keys are rejected; extra
 * NESTED keys are silently stripped):
 *   1. Most methods take one parameter named `request`, so the payload key is
 *      literally `request`. `session/list` is the exception: its parameter is
 *      named `_request`.
 *   2. A descriptor parameter sourced from a lookup crosses the wire under its
 *      lookup field name, which is `agentId` for lookup key `agent` (NOT the
 *      upstream parameter name).
 *
 * Streams are absent by design: they are not unary calls. See
 * {@link import('./sessions').SessionStreamMap} plus ./follow and ./workspace.
 */

import type { SessionRpc, SessionStreamMap } from './sessions'
import type { DirectoryPickerRpc } from './host'
import type { AgentPresetsRpc, CredentialsRpc, LlmRpc, SettingsRpc } from './settings'
import type { SubagentsRpc } from './subagents'
import type { GoalRef, SkillEntry, WorkspaceView } from './views'
import type { GoalView } from './goals'
import type { GoalId, SessionId, WorkspaceId } from './brand'
import type { SessionAddress, SessionFollowFrame, SessionControlFrame } from './follow'
import type { WorkspaceFollowFrame } from './workspace'
import type { SubagentCatalog } from './subagents'
import type { SessionSummary } from './sessions'

/**
 * Payload/value shapes of the workspace-domain unary Remote methods.
 *
 * There is NO unary workspace list in 0.1.5-rc.2: the workspace set, its order,
 * and `archivedSessionIds` all arrive from the `workspace/follow` stream
 * baseline. The retired `workspace.list` is deliberately not reintroduced here.
 */
export interface WorkspaceRpc {
  'workspace/create': {
    payload: { request: { path: string } }
    value: { workspace: WorkspaceView; created: boolean }
  }
  'workspace/rename': {
    payload: { request: { workspaceId: WorkspaceId; title: string } }
    value: { workspace: WorkspaceView }
  }
  'workspace/delete': {
    payload: { request: { workspaceId: WorkspaceId } }
    value: { deleted: true }
  }
  'workspace/insertBefore': {
    payload: { request: { workspaceId: WorkspaceId; beforeWorkspaceId?: WorkspaceId } }
    value: { workspaceIds: WorkspaceId[] }
  }
  'workspace/insertSessionBefore': {
    payload: { request: { workspaceId: WorkspaceId; sessionId: SessionId; beforeSessionId?: SessionId } }
    value: { workspace: WorkspaceView }
  }
  /**
   * Archiving is the ONLY way to retire a session: 0.1.5-rc.2 exposes no
   * session delete anywhere on the Remote surface.
   */
  'workspace/archiveSession': {
    payload: { request: { sessionId: SessionId } }
    value: { archivedSessionIds: SessionId[] }
  }
}

/**
 * Payload/value shapes of the goal-domain unary Remote methods.
 *
 * The namespace is `goals` (plural), every method takes the owning agent as a
 * required `agentId` lookup parameter, and the ref-taking methods answer the
 * flat {@link GoalView} rather than the old bare `{ref}` acknowledgement. The
 * `goal` projection value is unchanged and still nested — see ./goals.
 */
export interface GoalsRpc {
  'goals/create': {
    payload: { agentId: SessionId; request: { objective: string; maxGoalRounds?: number } }
    value: { ref: GoalRef }
  }
  'goals/edit': {
    payload: { agentId: SessionId; ref: GoalRef; request: { objective?: string; maxGoalRounds?: number } }
    value: GoalView
  }
  'goals/pause': { payload: { agentId: SessionId; ref: GoalRef }; value: GoalView }
  'goals/resume': { payload: { agentId: SessionId; ref: GoalRef }; value: GoalView }
  'goals/complete': { payload: { agentId: SessionId; ref: GoalRef }; value: GoalView }
  /** Answers the cleared ref; the projection tombstone arrives on the control stream. */
  'goals/clear': { payload: { agentId: SessionId; ref: GoalRef }; value: GoalRef }
  /** Whole current goal, or undefined when none is current. */
  'goals/get': { payload: { agentId: SessionId }; value: GoalView | undefined }
}

/** Payload/value shapes of the skills-domain unary Remote methods. */
export interface SkillsRpc {
  'skills/list': { payload: { request: { sessionId: SessionId } }; value: { skills: readonly SkillEntry[] } }
}

/** Payload/value shapes of the commands-domain unary Remote methods. */
export interface CommandsRpc {
  /**
   * Runs one slash-command line. `submittedAttachments` is the descriptor's
   * exact wire name — the retired client-side call sent `images`, which the
   * host rejects.
   */
  'commands/execute': {
    payload: {
      agentId: SessionId
      line: string
      submittedAttachments: readonly CommandAttachment[]
    }
    value: CommandExecutionView | undefined
  }
  'commands/list': { payload: { agentId: SessionId }; value: readonly CommandDescriptorView[] }
}

/** One attachment submitted alongside a slash command. */
export type CommandAttachment =
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string }

/** One registered slash command. */
export interface CommandDescriptorView {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
}

/** Result of running one slash command. */
export interface CommandExecutionView {
  readonly commandId: string
  readonly result: { kind: string; text?: string; sourceEventSeq?: number }
}

/**
 * Method name → { payload, value } for every unary endpoint this plugin calls.
 * Map keys are the wire path segments (`POST /api/<namespace>/<method>`).
 * Agent-preset methods are included because the settings UI reads the roster.
 */
export interface RpcMethodMap extends
  SessionRpc,
  DirectoryPickerRpc,
  WorkspaceRpc,
  GoalsRpc,
  SkillsRpc,
  CommandsRpc,
  SettingsRpc,
  CredentialsRpc,
  LlmRpc,
  AgentPresetsRpc,
  SubagentsRpc {}

/** Any registered RPC method name. */
export type RpcMethod = keyof RpcMethodMap

/** Business request payload of method K (the exact `args` object). */
export type RequestPayload<K extends RpcMethod> = RpcMethodMap[K]['payload']

/** Business return value of method K (the ok slot of the result). */
export type ResponseValue<K extends RpcMethod> = RpcMethodMap[K]['value']

/**
 * Stream endpoints → the frames each yields. Kept beside the unary map so one
 * module answers "what can this host do", while making the unary/stream split
 * explicit at the type level.
 */
export interface RpcStreamMap {
  'session/follow': { args: { request: SessionStreamMap['session/follow']['request'] }; frame: SessionFollowFrame }
  'session/control': { args: Record<string, never>; frame: SessionControlFrame }
  'workspace/follow': { args: Record<string, never>; frame: WorkspaceFollowFrame }
}

/** Any registered stream method name. */
export type RpcStreamMethod = keyof RpcStreamMap

/** Re-exports so this module's public surface names the domain value types. */
export type { GoalId, SessionAddress, SessionSummary, SubagentCatalog }
