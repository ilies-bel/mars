/**
 * One-shot auto-recovery guard for failed dynamic imports.
 *
 * Dev-server stale-chunk failures ("Failed to fetch dynamically imported
 * module: highlighted-body-<hash>.js") occur when Vite re-optimizes deps
 * mid-session and an already-open tab still references the old hashed URL,
 * which 404s → dynamic import rejects → FallbackBoundary shows
 * "Couldn't load the view." (mars-4ce23622).
 *
 * This module installs two listeners at app bootstrap:
 *   1. `vite:preloadError` — Vite fires this for stale preload/chunk 404s.
 *   2. `unhandledrejection` — catches the rejected dynamic-import promise.
 *
 * On the first match, it forces `window.location.reload()`. A sessionStorage
 * flag ensures the reload happens AT MOST ONCE per session so a genuine broken
 * import never causes an infinite reload loop.
 */

/** sessionStorage key used to prevent reload loops. */
export const RELOAD_KEY = 'mars:dynamic-import-reload'

/** Returns true when an error message indicates a stale-chunk dynamic import 404. */
export function isDynamicImportError(message: string): boolean {
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module')
  )
}

type MinimalWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  location: Pick<Location, 'reload'>
}
type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Installs the dynamic-import recovery guard.
 *
 * Accepts injectable `win` and `storage` dependencies so the guard can be
 * unit-tested without a real browser environment.
 *
 * Returns a cleanup function that removes both listeners.
 */
export function installDynamicImportRecovery(
  win: MinimalWindow = window,
  storage: MinimalStorage = sessionStorage,
): () => void {
  const tryReload = () => {
    if (storage.getItem(RELOAD_KEY) !== null) return // already reloaded once this session
    storage.setItem(RELOAD_KEY, '1')
    win.location.reload()
  }

  // Vite fires this custom event specifically for stale preload/chunk 404s.
  const onVitePreloadError = () => tryReload()

  // Fallback: unhandled promise rejections from dynamic imports carry the
  // "Failed to fetch dynamically imported module" message as reason.message.
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const msg = String(
      (event.reason as Error | undefined)?.message ?? event.reason ?? '',
    )
    if (isDynamicImportError(msg)) tryReload()
  }

  win.addEventListener('vite:preloadError', onVitePreloadError)
  win.addEventListener('unhandledrejection', onUnhandledRejection as EventListener)

  return () => {
    win.removeEventListener('vite:preloadError', onVitePreloadError)
    win.removeEventListener('unhandledrejection', onUnhandledRejection as EventListener)
  }
}
