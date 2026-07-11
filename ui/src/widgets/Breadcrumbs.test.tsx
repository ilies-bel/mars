import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveBreadcrumbs, Breadcrumbs } from './Breadcrumbs'

describe('deriveBreadcrumbs', () => {
  it('returns empty for top-level page routes', () => {
    expect(deriveBreadcrumbs('#/progress')).toEqual([])
    expect(deriveBreadcrumbs('#/events')).toEqual([])
    expect(deriveBreadcrumbs('#/action-queue')).toEqual([])
    expect(deriveBreadcrumbs('#/kpi')).toEqual([])
    expect(deriveBreadcrumbs('')).toEqual([])
  })

  it('returns Events > label for KPI detail routes', () => {
    const crumbs = deriveBreadcrumbs('#/kpi/failure_rate')
    expect(crumbs).toEqual([
      { label: 'Events', href: '#/events' },
      { label: 'Failure Rate', href: null },
    ])
  })

  it('returns Events > label for all four KPI keys', () => {
    expect(deriveBreadcrumbs('#/kpi/cost_per_arc')[1].label).toBe('Cost per Arc')
    expect(deriveBreadcrumbs('#/kpi/autonomous_completion_rate')[1].label).toBe('Autonomous Completion')
    expect(deriveBreadcrumbs('#/kpi/recovery_success_rate')[1].label).toBe('Recovery Success')
  })

  it('returns task crumb for task overlay route', () => {
    const crumbs = deriveBreadcrumbs('#/task/abc123')
    expect(crumbs.length).toBe(1)
    expect(crumbs[0].label).toContain('abc123')
    expect(crumbs[0].href).toBeNull()
  })

  it('returns task + step crumbs for task overlay with step param', () => {
    const crumbs = deriveBreadcrumbs('#/task/abc123?step=code')
    expect(crumbs.length).toBe(2)
    expect(crumbs[0].label).toContain('abc123')
    expect(crumbs[0].href).toContain('#/task/abc123')
    expect(crumbs[1].label).toBe('Step: code')
    expect(crumbs[1].href).toBeNull()
  })

  it('returns Progress > Studio for studio routes', () => {
    const crumbs = deriveBreadcrumbs('#/studio/task-xyz')
    expect(crumbs).toEqual([
      { label: 'Progress', href: '#/progress' },
      { label: expect.stringContaining('task-xyz'), href: null },
    ])
  })

  it('truncates long IDs in task crumbs', () => {
    const crumbs = deriveBreadcrumbs('#/task/abcdefghijklmnop')
    expect(crumbs[0].label).toContain('…')
  })
})

describe('Breadcrumbs component', () => {
  it('renders nothing for top-level routes', () => {
    const html = renderToStaticMarkup(<Breadcrumbs hash="#/progress" />)
    expect(html).toBe('')
  })

  it('renders a nav with aria-label for KPI detail', () => {
    const html = renderToStaticMarkup(<Breadcrumbs hash="#/kpi/failure_rate" />)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toContain('Events')
    expect(html).toContain('Failure Rate')
  })

  it('renders the Events crumb as a clickable link', () => {
    const html = renderToStaticMarkup(<Breadcrumbs hash="#/kpi/failure_rate" />)
    expect(html).toContain('href="#/events"')
  })

  it('renders the current crumb as non-link text', () => {
    const html = renderToStaticMarkup(<Breadcrumbs hash="#/kpi/failure_rate" />)
    expect(html).toContain('font-semibold')
    expect(html).toContain('Failure Rate')
  })

  it('renders separator between crumbs', () => {
    const html = renderToStaticMarkup(<Breadcrumbs hash="#/kpi/failure_rate" />)
    expect(html).toContain('›')
  })
})
