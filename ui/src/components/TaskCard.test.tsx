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
  it('is keyboard-focusable via tabIndex=0', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-1')} index={0} />)
    expect(html).toContain('tabindex="0"')
  })

  it('has role=button so assistive technology treats it as pressable', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-2')} index={0} />)
    expect(html).toContain('role="button"')
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
    expect(html).toContain('hover:bg-panel')
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
  it('suppresses the default outline in favour of a custom ring', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-7')} index={0} />)
    expect(html).toContain('focus-visible:outline-none')
  })

  it('applies a flame-coloured focus ring for keyboard navigation', () => {
    const html = renderToStaticMarkup(<TaskCard task={minTask('t-8')} index={0} />)
    expect(html).toContain('focus-visible:ring-2')
    expect(html).toContain('focus-visible:ring-flame')
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
