import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logFallbackError } from '@/shared/uiFallback'
import { FallbackSurface } from './FallbackSurface'

interface FallbackBoundaryProps {
  /** What this boundary guards, woven into the fallback headline. */
  of: string
  /** `pane` (route outlet) or `inline` (a drawer / sub-region). */
  variant?: 'pane' | 'inline'
  children: ReactNode
}

interface FallbackBoundaryState {
  error: unknown
}

/**
 * Render-time error boundary. Catches throws the fetch-error path can't see —
 * a schema drift, a `.map` on an unexpected null, any render bug — and renders
 * the same {@link FallbackSurface} a fetch failure would, so caught render
 * errors and thrown API errors converge on one error UI.
 *
 * Wrap the route outlet (a route crash degrades to a panel, not a white screen)
 * and each drawer (a drawer crash doesn't take the page with it).
 *
 * Must be a class component — React exposes the render-error lifecycle
 * (`getDerivedStateFromError` / `componentDidCatch`) only to class components.
 */
export class FallbackBoundary extends Component<FallbackBoundaryProps, FallbackBoundaryState> {
  state: FallbackBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): FallbackBoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    logFallbackError(error)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <FallbackSurface
          error={this.state.error}
          of={this.props.of}
          variant={this.props.variant ?? 'pane'}
        />
      )
    }
    return this.props.children
  }
}
