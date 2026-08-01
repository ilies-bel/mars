import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UITask } from '@/shared/types'
import { TaskCard } from './TaskCard'

const minTask = (id: string, overrides: Partial<UITask> = {}): UITask => ({
  id,
  title: `Task ${id}`,
  status: 'queued',
  role: 'builder',
  failed: false,
  dropReason: null,
  retryCount: 0,
  priority: 2,
  blockerTaskId: null,
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
})

describe('TaskCard – live-activity pulse', () => {
  it('shows a pulsing status dot for a running task', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'running' })} index={0} />,
    )
    expect(html).toContain('animate-mars-pulse')
  })

  it('shows a pulsing status dot for a merging task', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'merging' })} index={0} />,
    )
    expect(html).toContain('animate-mars-pulse')
  })

  it('shows a pulsing status dot for a verifying task', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'verifying' })} index={0} />,
    )
    expect(html).toContain('animate-mars-pulse')
  })

  it('does NOT show a pulsing dot for a queued task', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'queued' })} index={0} />,
    )
    expect(html).not.toContain('animate-mars-pulse')
  })

  it('does NOT show a pulsing dot for a failed task', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'failed' })} index={0} />,
    )
    expect(html).not.toContain('animate-mars-pulse')
  })

  it('pulses a status dot — not the whole card — so text stays legible when running', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'running' })} index={0} />,
    )
    // The root <article> element must NOT carry the pulse class (text legibility)
    const rootClassMatch = html.match(/^<article[^>]*class="([^"]*)"/)
    expect(rootClassMatch?.[1] ?? '').not.toContain('animate-mars-pulse')
    // The pulse lives on a child indicator element, guarded by motion-safe:
    expect(html).toContain('motion-safe:animate-mars-pulse')
  })

  it('uses motion-safe: prefix so the dot is still when prefers-reduced-motion is set', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('t1', { status: 'running' })} index={0} />,
    )
    // motion-safe: ensures animation is suppressed at the Tailwind variant level
    expect(html).toContain('motion-safe:animate-mars-pulse')
    // No bare (unguarded) animate-mars-pulse class anywhere
    expect(html).not.toMatch(/(?<![:\w])animate-mars-pulse/)
  })
})

describe('TaskCard – task drawer navigation', () => {
  it('renders a link to the task drawer for this task', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('mars-abc123')} index={0} />)
    expect(html).toContain('href="#/task/mars-abc123"')
  })

  it('URL-encodes special characters in the task id within the drawer link', () => {
    const html = renderToStaticMarkup(
      <TaskCard task={minTask('task/id with spaces')} index={0} />,
    )
    expect(html).toContain('href="#/task/task%2Fid%20with%20spaces"')
  })

  it('the card container signals full-card clickability via cursor-pointer', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-abc')} index={0} />)
    expect(html).toContain('cursor-pointer')
  })
})

describe('TaskCard – keyboard operability', () => {
  it('is keyboard-focusable via a native button element', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-1')} index={0} />)
    // A native <button> is keyboard-focusable without needing an explicit tabindex
    expect(html).toContain('<button')
  })

  it('card article does not have role=button — no nested-interactive ARIA violation', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-2')} index={0} />)
    // role=button on a container that nests <a> and <details> violates the ARIA spec
    expect(html).not.toMatch(/<article[^>]*role="button"/)
    // Instead, a native <button> element makes the card pressable by assistive technology
    expect(html).toContain('<button')
  })
})

describe('TaskCard – press and hover feedback', () => {
  it('carries transition classes for smooth state changes', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-3')} index={0} />)
    // transition-[transform,background-color] and duration are present
    expect(html).toContain('transition-')
    expect(html).toContain('duration-150')
  })

  it('carries hover background shift class', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-4')} index={0} />)
    expect(html).toContain('hover:bg-secondary')
  })

  it('carries active press-scale class', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-5')} index={0} />)
    expect(html).toContain('active:scale-')
  })

  it('wraps the scale transform in a reduced-motion guard', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-6')} index={0} />)
    expect(html).toContain('motion-reduce:transform-none')
  })
})

describe('TaskCard – focus-visible ring', () => {
  it('suppresses the default browser outline on the drawer button', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-7')} index={0} />)
    expect(html).toContain('focus-visible:outline-none')
  })

  it('applies a flame-coloured focus ring on the card boundary when the drawer button is focused', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-8')} index={0} />)
    // CSS :has() scopes the ring to the card article, not just the button text area
    expect(html).toContain('has-[button:focus-visible]:ring-2')
    expect(html).toContain('has-[button:focus-visible]:ring-ring')
  })
})

describe('TaskCard – activity detail label', () => {
  it('shows friendly fast-forward label when activityDetail is merge:fast-forward', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-ff', { status: 'merging', activityDetail: 'merge:fast-forward' })}
        index={0}
      />,
    )
    expect(html).toContain('merging · fast-forward')
  })

  it('shows friendly acquire-lock label when activityDetail is merge:acquire-lock', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-lock', { status: 'merging', activityDetail: 'merge:acquire-lock' })}
        index={0}
      />,
    )
    expect(html).toContain('merging · waiting for lock')
  })

  it('shows friendly integration-gate label when activityDetail is merge:integration-gate', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-gate', { status: 'merging', activityDetail: 'merge:integration-gate' })}
        index={0}
      />,
    )
    expect(html).toContain('merging · integration tests')
  })

  it('shows friendly vega label when activityDetail is merge:vega', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-vega', { status: 'vega-reconciling', activityDetail: 'merge:vega' })}
        index={0}
      />,
    )
    expect(html).toContain('merging · resolving conflicts')
  })

  it('falls back to the raw activityDetail string when unmapped', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-raw', { status: 'merging', activityDetail: 'merge:unknown-phase' })}
        index={0}
      />,
    )
    expect(html).toContain('merge:unknown-phase')
  })

  it('falls back to coarse status label when activityDetail is null', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-coarse', { status: 'merging', activityDetail: null })}
        index={0}
      />,
    )
    // coarse label from substepLabel('merging')
    expect(html).toContain('merging')
    expect(html).not.toContain('·')
  })

  it('still shows the pulse dot when activityDetail is set', () => {
    const html = renderToStaticMarkup(
      <TaskCard
        task={minTask('t-pulse', { status: 'merging', activityDetail: 'merge:fast-forward' })}
        index={0}
      />,
    )
    expect(html).toContain('animate-mars-pulse')
  })
})

describe('TaskCard – type scale', () => {
  it('uses text-body scale class for the task title', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-scale-1')} index={0} />)
    expect(html).toContain('text-body')
    expect(html).not.toContain('text-[14px]')
  })

  it('uses text-meta scale class for secondary labels', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-scale-2')} index={0} />)
    expect(html).toContain('text-meta')
    expect(html).not.toContain('text-[11px]')
  })

  it('uses text-micro scale class for tertiary labels', () => {
    const task = minTask('t-scale-3', { retryCount: 2 })
    const html = renderToStaticMarkup(<TaskCard task={task} index={0} />)
    expect(html).toContain('text-micro')
    expect(html).not.toContain('text-[10px]')
  })
})
