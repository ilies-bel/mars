import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FrameworkUpdateBannerInner,
  shouldShowBanner,
} from './FrameworkUpdateBanner'

// ---------------------------------------------------------------------------
// shouldShowBanner — covers the four acceptance-criterion cases
// ---------------------------------------------------------------------------

describe('shouldShowBanner', () => {
  it('returns false when available is false (no banner for up-to-date installs)', () => {
    expect(shouldShowBanner(false, '1.2.0', null)).toBe(false)
  })

  it('returns true when available is true and nothing has been dismissed', () => {
    expect(shouldShowBanner(true, '1.2.0', null)).toBe(true)
  })

  it('returns false when this exact version has been dismissed (persist for that version)', () => {
    expect(shouldShowBanner(true, '1.2.0', '1.2.0')).toBe(false)
  })

  it('returns true when a newer version arrives after an older dismissal (re-show)', () => {
    expect(shouldShowBanner(true, '1.3.0', '1.2.0')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FrameworkUpdateBannerInner — pure display component
// Shared props helper to avoid repeating boilerplate in every test.
// ---------------------------------------------------------------------------

const defaultProps = {
  installed: '1.0.0',
  latest: '1.2.0',
  releaseUrl: null as string | null,
  selfUpdatable: true,
  onUpdate: () => {},
  isUpdating: false,
  updateError: null as string | null,
  onDismiss: () => {},
}

describe('FrameworkUpdateBannerInner – version information', () => {
  it('shows the latest version', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} />,
    )
    expect(html).toContain('1.2.0')
  })

  it('shows the installed version', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} />,
    )
    expect(html).toContain('1.0.0')
  })
})

describe('FrameworkUpdateBannerInner – release notes link', () => {
  it('renders a release-notes link when releaseUrl is provided', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        {...defaultProps}
        releaseUrl="https://github.com/example/releases/tag/v1.2.0"
      />,
    )
    expect(html).toContain('href="https://github.com/example/releases/tag/v1.2.0"')
  })

  it('opens the link in a new tab with noopener', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        {...defaultProps}
        releaseUrl="https://example.com"
      />,
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('noopener')
  })

  it('omits the release-notes link when releaseUrl is null', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} releaseUrl={null} />,
    )
    expect(html).not.toContain('Release notes')
  })
})

describe('FrameworkUpdateBannerInner – Update now button', () => {
  it('renders the Update now button', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} />,
    )
    expect(html).toContain('Update now')
  })

  it('is enabled and has no disabled hint when selfUpdatable is true', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} selfUpdatable={true} />,
    )
    expect(html).not.toContain('git pull')
    // The button must NOT carry the disabled attribute
    expect(html).not.toContain('disabled')
  })

  it('shows visible inline text and no disabled button when selfUpdatable is false (dev install)', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} selfUpdatable={false} />,
    )
    // The explanation must be visible text, not a title-attribute tooltip on a disabled control
    expect(html).toContain('git pull')
    // No disabled button — the button is replaced entirely by inline text
    expect(html).not.toContain('Update now')
    expect(html).not.toContain('disabled')
  })

  it('shows Updating… label and is disabled while isUpdating is true', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} isUpdating={true} />,
    )
    expect(html).toContain('Updating')
    expect(html).toContain('disabled')
  })

  it('shows a natural-language error message when update fails', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        {...defaultProps}
        updateError="self-update failed: permission denied"
      />,
    )
    // User-facing message is always calm natural language, not the raw thrown string
    expect(html).toContain('try again, or update manually')
  })

  it('shows no error message when updateError is null', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} updateError={null} />,
    )
    // No extra error content beyond the normal banner text
    expect(html).not.toContain('failed')
  })
})

describe('FrameworkUpdateBannerInner – dismiss control', () => {
  it('renders a dismiss button', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} />,
    )
    expect(html).toContain('Dismiss update banner')
  })
})

describe('FrameworkUpdateBannerInner – landmark role', () => {
  it('uses role=region so it does not create a second page-level banner landmark', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} />,
    )
    expect(html).toContain('role="region"')
    expect(html).not.toContain('role="banner"')
  })

  it('carries an accessible label that identifies the region to screen readers', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} />,
    )
    expect(html).toContain('aria-label="Framework update notification"')
  })
})
