import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FallbackBoundary } from './FallbackBoundary'

// `@testing-library/react` is not a project dependency, and
// `renderToStaticMarkup` does not run the error-boundary lifecycle
// (`getDerivedStateFromError` / `componentDidCatch`) the way a client render
// does. So we exercise the boundary two ways without adding a DOM dependency:
//   1. the static `getDerivedStateFromError` contract (the caught-error path
//      that flips the boundary into its FallbackSurface), and
//   2. the pass-through render path (a non-throwing child renders untouched).

describe('FallbackBoundary.getDerivedStateFromError', () => {
  it('maps a thrown error into the boundary error state', () => {
    const boom = new Error('schema drift')
    expect(FallbackBoundary.getDerivedStateFromError(boom)).toEqual({
      error: boom,
    })
  })

  it('preserves non-Error thrown values verbatim', () => {
    expect(FallbackBoundary.getDerivedStateFromError('string throw')).toEqual({
      error: 'string throw',
    })
  })
})

describe('FallbackBoundary pass-through (no error)', () => {
  it('renders its children unchanged when nothing throws', () => {
    const html = renderToStaticMarkup(
      <FallbackBoundary of="this view" variant="pane">
        <p>healthy content</p>
      </FallbackBoundary>,
    )
    expect(html).toContain('healthy content')
  })

  it('does not render the error panel on the happy path', () => {
    const html = renderToStaticMarkup(
      <FallbackBoundary of="this view" variant="pane">
        <span>all good</span>
      </FallbackBoundary>,
    )
    expect(html).not.toContain('data-testid="api-error-panel"')
  })
})
