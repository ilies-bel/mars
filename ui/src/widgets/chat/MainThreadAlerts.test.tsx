import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MainThreadAlerts } from './MainThreadAlerts'
import type { Alert } from '@/entities/alerts'

const alert = (arcId: string, kind?: Alert['kind']): Alert => ({
  arcId,
  goal: `ship ${arcId}`,
  reason: `${arcId} verify failed`,
  technical: `stack trace for ${arcId}`,
  ...(kind ? { kind } : {}),
})

const render = (alerts: Alert[]): string =>
  renderToStaticMarkup(<MainThreadAlerts alerts={alerts} onDiscuss={() => {}} />)

describe('MainThreadAlerts', () => {
  it('renders nothing when no alerts are open', () => {
    expect(render([])).toBe('')
  })

  it('renders a lone alert as a single card, not a timeline', () => {
    const html = render([alert('a')])
    expect(html).toContain('data-testid="main-thread-alert"')
    expect(html).not.toContain('data-testid="alert-event-timeline"')
    expect(html).toContain('ship a')
    expect(html).toContain('a verify failed')
  })

  it('merges two alerts into ONE event timeline rather than two cards', () => {
    const html = render([alert('a'), alert('b')])
    expect(html).toContain('data-testid="alert-event-timeline"')
    // The single-card path must not also render, or the operator is back to
    // reading several artifacts — the exact thing merging prevents.
    expect(html).not.toContain('data-testid="main-thread-alert"')
    const timelines = html.split('data-testid="alert-event-timeline"').length - 1
    expect(timelines).toBe(1)
  })

  it('gives the merged timeline one row per alert and a count headline', () => {
    const html = render([alert('a'), alert('b'), alert('c')])
    expect(html).toContain('3 things need you')
    const rows = html.split('data-testid="alert-timeline-row"').length - 1
    expect(rows).toBe(3)
  })

  it('summarises the merged run by kind', () => {
    const html = render([
      alert('a', 'arc-failed'),
      alert('b', 'arc-failed'),
      alert('c', 'stale-worktree'),
    ])
    expect(html).toContain('2 failed')
    expect(html).toContain('1 stale worktree')
  })

  it('keeps technical detail collapsed so the merge stays one readable artifact', () => {
    const html = render([alert('a'), alert('b')])
    expect(html).not.toContain('stack trace for a')
    expect(html).toContain('Details')
  })

  it('offers a per-alert Discuss so each alert still spawns its own subthread', () => {
    // The merge is presentational. The alerts remain separate work with
    // separate objectives, so collapsing them into one subthread would lose that.
    const html = render([alert('a'), alert('b')])
    expect(html).toContain('Discuss: ship a')
    expect(html).toContain('Discuss: ship b')
  })
})
