/**
 * CopyButton tests — static rendering only (node environment, no DOM).
 *
 * We verify the initial render contract: the button shows the label, carries
 * the right aria-label, and accepts a custom className. The transient
 * "Copied ✓" state is driven by navigator.clipboard which is unavailable in
 * the test environment, so interactive state is not tested here.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CopyButton } from './CopyButton'

describe('CopyButton – initial render', () => {
  it('shows "Copy" as the default label', () => {
    const html = renderToStaticMarkup(<CopyButton text="abc-123" />)
    expect(html).toContain('>Copy<')
  })

  it('shows a custom label when supplied', () => {
    const html = renderToStaticMarkup(<CopyButton text="abc-123" label="abc-123" />)
    expect(html).toContain('>abc-123<')
  })

  it('sets aria-label to "Copy: <text>" by default', () => {
    const html = renderToStaticMarkup(<CopyButton text="abc-123" />)
    expect(html).toContain('aria-label="Copy: abc-123"')
  })

  it('accepts a custom aria-label', () => {
    const html = renderToStaticMarkup(
      <CopyButton text="abc-123" aria-label="Copy task id" />,
    )
    expect(html).toContain('aria-label="Copy task id"')
  })

  it('applies a custom className', () => {
    const html = renderToStaticMarkup(
      <CopyButton text="abc-123" className="my-custom-class" />,
    )
    expect(html).toContain('my-custom-class')
  })

  it('applies the data-testid attribute', () => {
    const html = renderToStaticMarkup(
      <CopyButton text="abc-123" data-testid="copy-task-id" />,
    )
    expect(html).toContain('data-testid="copy-task-id"')
  })

  it('renders a button element of type="button"', () => {
    const html = renderToStaticMarkup(<CopyButton text="abc-123" />)
    expect(html).toContain('type="button"')
    expect(html.startsWith('<button')).toBe(true)
  })
})
