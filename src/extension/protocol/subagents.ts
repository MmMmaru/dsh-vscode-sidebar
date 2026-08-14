/**
 * Vendored protocol types from deepseek-harness.
 * Source commit: 47f943859bef60e4160492346772ded9b24f765a
 * Source: packages/host/apiproxy/src/api/subagents.ts
 * Browser-safe subagent domain contract: catalog rows, addresses, receipts.
 */

import type { MessageId, SessionId } from './brand'
import type { ContentBlock } from './llm'
import type { HistoryEntry, SessionProjectionsBlock } from './sessions'

/** Complete durable direct-child catalog row. */
export type SubagentListEntry =
  | ({
    kind: 'child'
    id: SessionId
    /** Whether the child Agent driver is running at the Host sampling boundary. */
    activity: 'running' | 'inactive'
    /** Whether a direct descendant has durable `origin: 'subagent'`. */
    hasChildren: boolean
  } & (
    | { mode: 'one-shot'; label?: string }
    | { mode: 'continuable'; label: string }
  ))
  | {
    kind: 'diagnostic'
    id: SessionId
    reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/** Inbox identity returned once the continuation accepts one human message. */
export interface SubagentPromptReceipt {
  messageId: MessageId
}

/** Uniform acknowledgement that one interrupt request was admitted. */
export interface SubagentInterruptReceipt {
  accepted: true
}

/** Durable parent/child address that selects subagent transport in the client. */
export type SubagentAddress =
  & { parentSessionId: SessionId; childSessionId: SessionId }
  & ({ mode: 'one-shot' } | { mode: 'continuable' })

/** Complete direct-child catalog plus the delivery-time parent availability hint. */
export interface SubagentCatalog {
  entries: SubagentListEntry[]
  parentAvailable: boolean
}

/** Payload/value shapes of the subagent-domain RPC methods. */
export interface SubagentsRpc {
  'subagent.list': { payload: { parentSessionId: SessionId }; value: SubagentCatalog }
  'subagent.history': {
    payload: SubagentAddress & { beforeSeq?: number; maxMessages?: number }
    value: { events: HistoryEntry[]; hasMore: boolean; projections?: SessionProjectionsBlock }
  }
  'subagent.prompt': {
    payload: Extract<SubagentAddress, { mode: 'continuable' }> & { content: ContentBlock[]; clientTimeZone?: string }
    value: SubagentPromptReceipt
  }
  'subagent.interrupt': {
    payload: Extract<SubagentAddress, { mode: 'continuable' }>
    value: SubagentInterruptReceipt
  }
}
