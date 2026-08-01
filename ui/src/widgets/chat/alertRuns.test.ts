import { describe, expect, it } from 'vitest'
import { countByKind, groupAlerts, runHeadline } from './alertRuns'
import type { Alert } from '@/entities/alerts'

const alert = (arcId: string, kind?: Alert['kind']): Alert => ({
  arcId,
  goal: `goal ${arcId}`,
  reason: `reason ${arcId}`,
  ...(kind ? { kind } : {}),
})

describe('groupAlerts', () => {
  it('renders nothing when there are no alerts', () => {
    expect(groupAlerts([])).toEqual([])
  })

  it('leaves a lone alert as a single card', () => {
    const nodes = groupAlerts([alert('a')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind).toBe('single')
  })

  it('merges two simultaneous alerts into ONE run — the whole point of the rule', () => {
    const nodes = groupAlerts([alert('a'), alert('b')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'run' })
    expect(nodes[0]?.kind === 'run' && nodes[0].alerts).toHaveLength(2)
  })

  it('still produces exactly one artifact for many alerts', () => {
    // The requirement is about artifact COUNT: someone returning to the session
    // reads one thing regardless of how much piled up while they were away.
    const nodes = groupAlerts([alert('a'), alert('b'), alert('c'), alert('d'), alert('e')])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind === 'run' && nodes[0].alerts).toHaveLength(5)
  })

  it('does not split the run by kind', () => {
    // Splitting by kind would put the operator back at two artifacts, which is
    // exactly what merging exists to prevent.
    const nodes = groupAlerts([alert('a', 'arc-failed'), alert('b', 'stale-worktree')])
    expect(nodes).toHaveLength(1)
  })

  it('does not mutate the input list', () => {
    const input = [alert('a'), alert('b')]
    groupAlerts(input).forEach((node) => {
      if (node.kind === 'run') node.alerts.push(alert('injected'))
    })
    expect(input).toHaveLength(2)
  })
})

describe('runHeadline', () => {
  it('states how many things need the operator', () => {
    expect(runHeadline([alert('a'), alert('b'), alert('c')])).toBe('3 things need you')
  })
})

describe('countByKind', () => {
  it('counts each kind, most frequent first', () => {
    expect(countByKind([
      alert('a', 'arc-failed'),
      alert('b', 'stale-worktree'),
      alert('c', 'arc-failed'),
    ])).toEqual([
      { kind: 'arc-failed', count: 2 },
      { kind: 'stale-worktree', count: 1 },
    ])
  })

  it('counts a kind-less alert as "other" rather than dropping it', () => {
    // A drifted alert shape still needs the operator; losing it from the count
    // would make the headline disagree with the rows underneath it.
    expect(countByKind([alert('a')])).toEqual([{ kind: 'other', count: 1 }])
  })

  it('breaks count ties by kind name so the summary line is stable', () => {
    expect(countByKind([alert('a', 'stale-worktree'), alert('b', 'arc-failed')])).toEqual([
      { kind: 'arc-failed', count: 1 },
      { kind: 'stale-worktree', count: 1 },
    ])
  })
})
