/**
 * ShortcutsOverlay widget tests.
 *
 * Strategy: renderToStaticMarkup for markup verification (accessible
 * structure, shortcut content). Interactive behaviour (Escape-to-close,
 * scrim click) mirrors the identical pattern in ReleaseNotesModal and is
 * verified by the global keyboard shortcuts integration tests.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ShortcutsOverlay } from './ShortcutsOverlay'

const render = () => renderToStaticMarkup(<ShortcutsOverlay onClose={() => {}} />)

// ---------------------------------------------------------------------------
// Accessible structure
// ---------------------------------------------------------------------------

describe('ShortcutsOverlay – accessible structure', () => {
  it('has the dialog role and aria-modal for accessibility', () => {
    const html = render()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Keyboard shortcuts"')
  })

  it('renders the heading and a Close button', () => {
    const html = render()
    expect(html).toContain('>Keyboard Shortcuts<')
    expect(html).toContain('data-testid="shortcuts-close"')
    expect(html).toContain('>Close<')
  })

  it('renders the backdrop scrim', () => {
    const html = render()
    expect(html).toContain('data-testid="shortcuts-overlay-scrim"')
    expect(html).toContain('aria-hidden="true"')
  })
})

// ---------------------------------------------------------------------------
// Shortcut content
// ---------------------------------------------------------------------------

describe('ShortcutsOverlay – shortcut content', () => {
  it('shows the 1-9 jump shortcut', () => {
    const html = render()
    expect(html).toContain('>1-9<')
    expect(html).toContain('Jump to task')
  })

  it('shows the t triage shortcut', () => {
    const html = render()
    expect(html).toContain('>t<')
    expect(html).toContain('action queue')
  })

  it('shows the ? help shortcut', () => {
    const html = render()
    expect(html).toContain('>?<')
    expect(html).toContain('shortcuts overlay')
  })

  it('shows the Esc close shortcut', () => {
    const html = render()
    expect(html).toContain('>Esc<')
    expect(html).toContain('Close any open')
  })
})
