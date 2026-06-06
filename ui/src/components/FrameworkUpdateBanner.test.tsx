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

  it('is disabled with a dev-install hint when selfUpdatable is false', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} selfUpdatable={false} />,
    )
    expect(html).toContain('disabled')
    expect(html).toContain('git pull')
  })

  it('shows Updating… label and is disabled while isUpdating is true', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner {...defaultProps} isUpdating={true} />,
    )
    expect(html).toContain('Updating')
    expect(html).toContain('disabled')
  })

  it('shows an error message when updateError is set', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        {...defaultProps}
        updateError="self-update failed: permission denied"
      />,
    )
    expect(html).toContain('self-update failed: permission denied')
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
