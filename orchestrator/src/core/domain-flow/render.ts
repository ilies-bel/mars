import type { DomainFlow, DomainFlowNode } from './types'

/** Render a single node as a two-line markdown block. */
const renderNode = (node: DomainFlowNode): string => {
  switch (node.kind) {
    case 'event': {
      const marker = node.pivotal ? '◆' : '•'
      return `${marker} ${node.name}\n  ${node.description}`
    }
    case 'policy':
      return `→ Policy: ${node.name}\n  ${node.description}`
    case 'hotspot':
      return `⚠ Hotspot: ${node.name} — ${node.question}`
  }
}

/**
 * Render a `DomainFlow` as a compact markdown diagram.
 *
 * Returns an empty string when the flow has no nodes (no-flow elision).
 * Nodes are emitted in the array order in which they were authored.
 */
export const renderDomainFlow = (flow: DomainFlow): string => {
  if (flow.nodes.length === 0) return ''

  const nodeLines = flow.nodes.map(renderNode).join('\n\n')
  return `## Domain Flow: ${flow.name}\n\n${nodeLines}`
}
