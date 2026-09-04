import { useEffect } from 'react'
import { useHashRoute } from './useHashRoute'
import { resolvePageRoute, pageTitle } from './routing'

/**
 * Sets the browser tab title to `(count) <PageName> — mars` when the SSE
 * stream is connected and there are items needing the operator's attention,
 * and to `<PageName> — mars` otherwise.
 *
 * Dropping the prefix while disconnected prevents showing a stale, confident
 * count in the tab bar during a network outage.
 *
 * This is the single source of truth for `document.title` across all pages.
 * No page should set `document.title` independently.
 */
export const useTabTitleBadge = (count: number, connected: boolean): void => {
  const hash = useHashRoute()
  const route = resolvePageRoute(hash)
  const base = pageTitle(route)

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = connected && count > 0 ? `(${count}) ${base}` : base
  }, [count, connected, base])
}
