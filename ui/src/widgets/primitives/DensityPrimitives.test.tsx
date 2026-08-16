import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageHeader, SectionLabel } from './DensityPrimitives'

// ---------------------------------------------------------------------------
// PageHeader
// ---------------------------------------------------------------------------

describe('PageHeader', () => {
  it('renders the title', () => {
    const html = renderToStaticMarkup(<PageHeader title="Progress" />)
    expect(html).toContain('Progress')
  })

  it('renders with border-b and bg-surface layout classes', () => {
    const html = renderToStaticMarkup(<PageHeader title="Progress" />)
    expect(html).toContain('border-b')
    expect(html).toContain('bg-surface')
  })

  it('renders title in mono font', () => {
    const html = renderToStaticMarkup(<PageHeader title="Progress" />)
    expect(html).toContain('font-mono')
    expect(html).toContain('font-semibold')
  })

  it('omits subtitle span when subtitle is not provided', () => {
    const html = renderToStaticMarkup(<PageHeader title="Progress" />)
    // Only one span (the title), no muted-foreground text
    expect(html).not.toContain('muted-foreground')
  })

  it('renders subtitle when provided', () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Progress" subtitle="4 active tasks" />,
    )
    expect(html).toContain('4 active tasks')
    expect(html).toContain('muted-foreground')
  })

  it('omits the right slot wrapper when right is not provided', () => {
    const html = renderToStaticMarkup(<PageHeader title="Progress" />)
    expect(html).not.toContain('ml-auto')
  })

  it('renders the right slot when provided', () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Progress" right={<button>Filter</button>} />,
    )
    expect(html).toContain('ml-auto')
    expect(html).toContain('Filter')
  })

  it('renders all three parts together', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Progress"
        subtitle="4 active"
        right={<span>toggle</span>}
      />,
    )
    expect(html).toContain('Progress')
    expect(html).toContain('4 active')
    expect(html).toContain('toggle')
    expect(html).toContain('ml-auto')
  })
})

// ---------------------------------------------------------------------------
// SectionLabel
// ---------------------------------------------------------------------------

describe('SectionLabel', () => {
  it('renders children text', () => {
    const html = renderToStaticMarkup(<SectionLabel>Proposals</SectionLabel>)
    expect(html).toContain('Proposals')
  })

  it('renders as a span element', () => {
    const html = renderToStaticMarkup(<SectionLabel>In Progress</SectionLabel>)
    expect(html).toMatch(/<span[^>]*>In Progress<\/span>/)
  })

  it('applies uppercase mono styling', () => {
    const html = renderToStaticMarkup(<SectionLabel>Blocked</SectionLabel>)
    expect(html).toContain('uppercase')
    expect(html).toContain('font-mono')
    expect(html).toContain('font-semibold')
  })

  it('applies letter-spacing and muted colour', () => {
    const html = renderToStaticMarkup(<SectionLabel>Failed</SectionLabel>)
    expect(html).toContain('tracking-')
    expect(html).toContain('muted-foreground')
  })
})
