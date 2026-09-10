import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CollapsibleSection } from './CollapsibleSection'

describe('CollapsibleSection', () => {
  it('renders children with the given label in the summary', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection label="My Section">
        <p>Content here</p>
      </CollapsibleSection>,
    )
    expect(html).toContain('My Section')
    expect(html).toContain('Content here')
  })

  it('renders closed (no open attribute) when defaultOpen is omitted', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection label="Closed">
        <span>body</span>
      </CollapsibleSection>,
    )
    // A closed <details> has no open attribute in static HTML
    expect(html).not.toContain('open=""')
  })

  it('renders open when defaultOpen is true', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection label="Open" defaultOpen>
        <span>body</span>
      </CollapsibleSection>,
    )
    expect(html).toContain('open=""')
  })

  it('forwards data-testid to the <details> element', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection label="Section" data-testid="my-section">
        <span />
      </CollapsibleSection>,
    )
    expect(html).toContain('data-testid="my-section"')
  })

  it('applies additional className to the root element', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection label="Section" className="extra-class">
        <span />
      </CollapsibleSection>,
    )
    expect(html).toContain('extra-class')
  })

  it('renders the chevron indicator in the summary', () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection label="Section">
        <span />
      </CollapsibleSection>,
    )
    // A real chevron icon is always present in the summary. This used to be a
    // "▸" text glyph; it is a Lucide <svg> now.
    expect(html).toContain('lucide-chevron-right')
    // Deliberately NOT asserting a class string. The previous version of this
    // test asserted `group-open:rotate-90` was present in the markup, and it
    // always was — while the variant compiled to no CSS at all, so the chevron
    // never rotated in any browser. A class name is not a behaviour.
    expect(html).not.toContain('rotate(90deg)')
  })
})
