/**
 * TopologyView is a Canvas/G6 component: it needs a real DOM + canvas and will
 * not render under `renderToStaticMarkup` or jsdom once G6 is constructed. So
 * the testable value lives in the PURE model (see topologyGraphModel.test.ts).
 *
 * Here we cover only the empty-state path, which short-circuits BEFORE G6 is
 * ever constructed and is therefore safe under the static renderer. We do NOT
 * attempt to instantiate G6 in tests.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { TopologyView } from './TopologyView'

const noTasks: ProgressTask[] = []
const noProposals: ProgressProposalNode[] = []

describe('TopologyView – empty state', () => {
  it('renders the empty-state message when there are no tasks', () => {
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    expect(html).toContain('No active tasks')
  })

  it('does not construct any canvas/graph chrome in the empty state', () => {
    // The empty path returns a plain <main> with a <p>; no graph container.
    const html = renderToStaticMarkup(<TopologyView tasks={noTasks} proposals={noProposals} />)
    expect(html).not.toContain('Task dependency graph')
    expect(html.length).toBeGreaterThan(0)
  })

  it('renders empty state regardless of the optional toolbar props', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={noTasks}
        proposals={noProposals}
        ghostedClusters={new Set(['Blocked'])}
        selectedProposalId="p1"
        searchMatchIds={new Set(['x'])}
        onSelectProposal={() => {}}
      />,
    )
    expect(html).toContain('No active tasks')
  })
})
