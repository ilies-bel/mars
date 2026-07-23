import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkeletonBlock, SkeletonList } from './Skeleton'

// ---------------------------------------------------------------------------
// SkeletonBlock
// ---------------------------------------------------------------------------

describe('SkeletonBlock – pulsing bar', () => {
  it('renders a single div', () => {
    const html = renderToStaticMarkup(<SkeletonBlock />)
    expect(html).toContain('<div')
  })

  it('applies the animate-mars-pulse class for reduced-motion-aware animation', () => {
    const html = renderToStaticMarkup(<SkeletonBlock />)
    expect(html).toContain('animate-mars-pulse')
  })

  it('applies the bg-iron/20 base color', () => {
    const html = renderToStaticMarkup(<SkeletonBlock />)
    expect(html).toContain('bg-iron/20')
  })

  it('merges additional className for sizing', () => {
    const html = renderToStaticMarkup(<SkeletonBlock className="h-4 w-1/2" />)
    expect(html).toContain('h-4')
    expect(html).toContain('w-1/2')
  })

  it('does NOT use animate-pulse (the Tailwind default, not reduced-motion-aware)', () => {
    const html = renderToStaticMarkup(<SkeletonBlock />)
    // The class must be the custom mars variant, not Tailwind's built-in
    expect(html).not.toContain('"animate-pulse"')
  })
})

// ---------------------------------------------------------------------------
// SkeletonList
// ---------------------------------------------------------------------------

describe('SkeletonList – N-row loading region', () => {
  it('renders exactly the requested number of bars', () => {
    const html = renderToStaticMarkup(<SkeletonList rows={3} />)
    // Count occurrences of animate-mars-pulse (one per SkeletonBlock)
    const count = (html.match(/animate-mars-pulse/g) ?? []).length
    expect(count).toBe(3)
  })

  it('marks the container as aria-busy for screen readers', () => {
    const html = renderToStaticMarkup(<SkeletonList rows={2} />)
    expect(html).toContain('aria-busy="true"')
  })

  it('carries a default aria-label of "Loading"', () => {
    const html = renderToStaticMarkup(<SkeletonList rows={1} />)
    expect(html).toContain('aria-label="Loading"')
  })

  it('accepts a custom label', () => {
    const html = renderToStaticMarkup(
      <SkeletonList rows={1} label="Loading run timeline" />,
    )
    expect(html).toContain('aria-label="Loading run timeline"')
  })

  it('applies rowClassName to every bar', () => {
    const html = renderToStaticMarkup(
      <SkeletonList rows={2} rowClassName="h-4 mb-2" />,
    )
    const count = (html.match(/h-4/g) ?? []).length
    expect(count).toBe(2)
  })

  it('accepts a className on the wrapper', () => {
    const html = renderToStaticMarkup(
      <SkeletonList rows={1} className="flex flex-col gap-3" />,
    )
    expect(html).toContain('flex')
    expect(html).toContain('gap-3')
  })
})
