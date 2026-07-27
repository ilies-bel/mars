import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PurgeArchiveEntry } from '@/shared/schemas'
import { GhostArc } from './GhostArc'

const entry = (overrides?: Partial<PurgeArchiveEntry>): PurgeArchiveEntry => ({
  id: 'purged-origin-1',
  originId: null,
  branch: 'task/purged-origin-1',
  terminalStatus: 'done',
  purgedAt: '2024-06-01T12:00:00Z',
  integratedCommits: ['abc1234def5678', 'dead0000beef1111', 'cafe0000babe2222'],
  compensationTaskId: 'comp-1',
  ...overrides,
})

describe('GhostArc', () => {
  it('renders data-arc-state="purged"', () => {
    const html = renderToStaticMarkup(
      <GhostArc entry={entry()} compensationArcId="comp-1" />,
    )
    expect(html).toContain('data-arc-state="purged"')
  })

  it('renders data-arc-id with the purged entry id', () => {
    const html = renderToStaticMarkup(
      <GhostArc entry={entry()} compensationArcId="comp-1" />,
    )
    expect(html).toContain('data-arc-id="purged-origin-1"')
  })

  it('renders data-compensation-target pointing to the live arc', () => {
    const html = renderToStaticMarkup(
      <GhostArc entry={entry()} compensationArcId="live-arc-42" />,
    )
    expect(html).toContain('data-compensation-target="live-arc-42"')
  })

  it('renders the arrow character', () => {
    const html = renderToStaticMarkup(
      <GhostArc entry={entry()} compensationArcId="comp-1" />,
    )
    expect(html).toContain('↦')
  })

  it('includes first 3 commit short SHAs in the tooltip', () => {
    const html = renderToStaticMarkup(
      <GhostArc entry={entry()} compensationArcId="comp-1" />,
    )
    expect(html).toContain('title="abc1234, dead000, cafe000"')
  })

  it('renders empty tooltip when no integrated commits exist', () => {
    const html = renderToStaticMarkup(
      <GhostArc entry={entry({ integratedCommits: [] })} compensationArcId="comp-1" />,
    )
    expect(html).not.toContain('title=')
  })
})
