import { useState, useEffect } from 'react'

/**
 * Returns true when the given CSS media query matches the current viewport.
 *
 * Initialises synchronously from window.matchMedia().matches so there is no
 * flash of the wrong layout on first render.  Re-evaluates whenever the media
 * environment changes (e.g. the user resizes the window).
 *
 * @param query - A CSS media query string, e.g. "(min-width: 1280px)"
 */
export function useMediaQuery(query: string): boolean {
  // Default to `true` (desktop-first) when window is unavailable — SSR and
  // server-side test renders should assume a large screen so components that
  // condition on media queries (e.g. sidebar visibility) render their full
  // desktop layout rather than the collapsed mobile fallback.
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : true,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    // Re-sync on mount in case the viewport changed between the SSR render and
    // hydration (no-op in a pure SPA but keeps the hook correct in all setups).
    setMatches(mql.matches)
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])

  return matches
}
