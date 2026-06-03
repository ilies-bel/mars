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
// ---------------------------------------------------------------------------

describe('FrameworkUpdateBannerInner – version information', () => {
  it('shows the latest version', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl={null}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('1.2.0')
  })

  it('shows the installed version', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl={null}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('1.0.0')
  })
})

describe('FrameworkUpdateBannerInner – release notes link', () => {
  it('renders a release-notes link when releaseUrl is provided', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl="https://github.com/example/releases/tag/v1.2.0"
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('href="https://github.com/example/releases/tag/v1.2.0"')
  })

  it('opens the link in a new tab with noopener', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl="https://example.com"
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('noopener')
  })

  it('omits the release-notes link when releaseUrl is null', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl={null}
        onDismiss={() => {}}
      />,
    )
    expect(html).not.toContain('Release notes')
  })
})

describe('FrameworkUpdateBannerInner – Update now button', () => {
  it('renders the Update now button', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl={null}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('Update now')
  })

  it('the Update now button is disabled (self-update not yet wired)', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl={null}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('disabled')
  })
})

describe('FrameworkUpdateBannerInner – dismiss control', () => {
  it('renders a dismiss button', () => {
    const html = renderToStaticMarkup(
      <FrameworkUpdateBannerInner
        installed="1.0.0"
        latest="1.2.0"
        releaseUrl={null}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('Dismiss update banner')
  })
})
