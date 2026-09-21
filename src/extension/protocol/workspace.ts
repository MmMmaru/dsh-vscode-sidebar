/**
 * Stream frames of the Typert Remote workspace domain (dsh 0.1.5-rc.2).
 * Source (built install):
 *   dsh-api-workspace-controller/lib/types/types.d.ts:109-131
 *
 * `workspace/follow` replaces both the retired `workspace.list` unary (there is
 * NO unary workspace list in 0.1.5-rc.2) and the four `host/workspace-*` mux
 * frames. Every generation opens with exactly one `baseline`, so a reconnect is
 * handled by discarding prior state and re-applying the new baseline.
 */

import type { SessionId, WorkspaceId } from './brand'
import type { WorkspaceView } from './views'

/** Complete workspace browser state at the start of one generation. */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[]
  readonly archivedSessionIds: readonly SessionId[]
}

/** One ordered workspace change after a generation's baseline. */
export type WorkspaceFollowIncrement =
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

/** Any frame of the `workspace/follow` stream. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceBaseline }
  | WorkspaceFollowIncrement
