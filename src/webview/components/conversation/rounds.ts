/**
 * rounds.ts: "one round, one fold" grouping for the conversation flow.
 *
 * A round is a maximal run of consecutive step nodes — reasoning (Think) and
 * tool calls — between two visible outputs (user message / assistant text).
 * Settled rounds collapse into a single disclosure row so only the model's
 * output prose stays in view; the trailing live round (still streaming or
 * awaiting a tool result) renders expanded until it settles.
 */

import type { ConversationNode, ReasoningNode, ToolCallNode } from '../../types'

/** One renderable item of the conversation flow. */
export interface RoundItem {
  kind: 'round'
  /** Stable key: derived from the round's first node id. */
  id: string
  nodes: Array<ReasoningNode | ToolCallNode>
  /** Any member still streaming / pending: render expanded, pulse the summary. */
  live: boolean
}

export type FlowItem = { kind: 'node'; node: ConversationNode } | RoundItem

function isStepNode(node: ConversationNode): node is ReasoningNode | ToolCallNode {
  return node.kind === 'reasoning' || node.kind === 'tool-call'
}

/** A step still producing content keeps its round expanded (live). */
function isLiveStep(node: ReasoningNode | ToolCallNode): boolean {
  return node.kind === 'reasoning' ? node.streaming : node.status === 'pending'
}

/** Group the projected nodes into plain nodes and collapsible rounds. */
export function groupRounds(nodes: readonly ConversationNode[]): FlowItem[] {
  const items: FlowItem[] = []
  let run: Array<ReasoningNode | ToolCallNode> = []
  const flush = (): void => {
    const first = run[0]
    if (first === undefined) return
    items.push({ kind: 'round', id: `round-${first.id}`, nodes: run, live: run.some(isLiveStep) })
    run = []
  }
  for (const node of nodes) {
    if (isStepNode(node)) {
      run.push(node)
    } else {
      flush()
      items.push({ kind: 'node', node })
    }
  }
  flush()
  return items
}

/** Bold header label for a round, by composition. */
export function roundLabel(nodes: readonly (ReasoningNode | ToolCallNode)[]): string {
  const hasReasoning = nodes.some((n) => n.kind === 'reasoning')
  const hasTools = nodes.some((n) => n.kind === 'tool-call')
  if (hasReasoning && hasTools) return '思考与工具'
  return hasTools ? '工具调用' : '思考'
}

/** Muted summary: step count · tool-call count · deduped tool names. */
export function roundSummary(nodes: readonly (ReasoningNode | ToolCallNode)[]): string {
  const tools = nodes.filter((n): n is ToolCallNode => n.kind === 'tool-call')
  const parts = [`${nodes.length} 步`]
  if (tools.length > 0) parts.push(`${tools.length} 个工具调用`)
  const names = [...new Set(tools.map((t) => t.name))]
  if (names.length > 0) parts.push(names.join(', '))
  return parts.join(' · ')
}
