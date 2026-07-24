import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  RELOAD_KEY,
  isDynamicImportError,
  installDynamicImportRecovery,
} from './dynamicImportRecovery'

// ---------------------------------------------------------------------------
// Helpers — fake browser environment
// ---------------------------------------------------------------------------

type Listener = (e: unknown) => void

const makeFakeStorage = () => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => { store.set(k, v) },
  }
}

const makeFakeWindow = () => {
  const listeners = new Map<string, Set<Listener>>()
  let reloads = 0

  return {
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener)
    },
    location: { reload: () => { reloads++ } },
    /** Dispatch a fake event to all registered listeners for `type`. */
    dispatch(type: string, event: object = {}) {
      listeners.get(type)?.forEach(l => l(event))
    },
    getReloads: () => reloads,
  }
}

// ---------------------------------------------------------------------------
// isDynamicImportError
// ---------------------------------------------------------------------------

describe('isDynamicImportError', () => {
  it('matches the Chrome/Firefox "Failed to fetch dynamically imported module" message', () => {
    expect(
      isDynamicImportError(
        'Failed to fetch dynamically imported module: http://127.0.0.1:5175/node_modules/.vite/deps/highlighted-body-OFNGDK62-RRF4N2RT.js',
      ),
    ).toBe(true)
  })

  it('matches the Safari "error loading dynamically imported module" message', () => {
    expect(
      isDynamicImportError('error loading dynamically imported module'),
    ).toBe(true)
  })

  it('does not match a generic network error', () => {
    expect(isDynamicImportError('NetworkError: Failed to fetch')).toBe(false)
  })

  it('does not match an empty string', () => {
    expect(isDynamicImportError('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// installDynamicImportRecovery — vite:preloadError
// ---------------------------------------------------------------------------

describe('installDynamicImportRecovery – vite:preloadError', () => {
  let win: ReturnType<typeof makeFakeWindow>
  let storage: ReturnType<typeof makeFakeStorage>
  let cleanup: () => void

  beforeEach(() => {
    win = makeFakeWindow()
    storage = makeFakeStorage()
    cleanup = installDynamicImportRecovery(win, storage)
  })

  afterEach(() => {
    cleanup()
  })

  it('reloads once when vite:preloadError fires', () => {
    win.dispatch('vite:preloadError')
    expect(win.getReloads()).toBe(1)
  })

  it('sets the sessionStorage reload key on first error', () => {
    win.dispatch('vite:preloadError')
    expect(storage.store.get(RELOAD_KEY)).toBe('1')
  })

  it('does NOT reload a second time — once-per-session guard', () => {
    win.dispatch('vite:preloadError')
    win.dispatch('vite:preloadError')
    expect(win.getReloads()).toBe(1)
  })

  it('does NOT reload when the sessionStorage key is pre-set (already reloaded)', () => {
    storage.store.set(RELOAD_KEY, '1')
    win.dispatch('vite:preloadError')
    expect(win.getReloads()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// installDynamicImportRecovery — unhandledrejection
// ---------------------------------------------------------------------------

describe('installDynamicImportRecovery – unhandledrejection', () => {
  let win: ReturnType<typeof makeFakeWindow>
  let storage: ReturnType<typeof makeFakeStorage>
  let cleanup: () => void

  beforeEach(() => {
    win = makeFakeWindow()
    storage = makeFakeStorage()
    cleanup = installDynamicImportRecovery(win, storage)
  })

  afterEach(() => {
    cleanup()
  })

  it('reloads when an unhandled rejection carries a dynamic-import error message', () => {
    win.dispatch('unhandledrejection', {
      reason: new Error('Failed to fetch dynamically imported module: http://127.0.0.1:5175/some-chunk.js'),
    })
    expect(win.getReloads()).toBe(1)
  })

  it('does NOT reload when an unhandled rejection has an unrelated message', () => {
    win.dispatch('unhandledrejection', {
      reason: new Error('Cannot read properties of undefined'),
    })
    expect(win.getReloads()).toBe(0)
  })

  it('does NOT reload when reason is a plain string (non-import error)', () => {
    win.dispatch('unhandledrejection', { reason: 'something went wrong' })
    expect(win.getReloads()).toBe(0)
  })

  it('does NOT reload a second time after the guard key is set', () => {
    win.dispatch('unhandledrejection', {
      reason: new Error('Failed to fetch dynamically imported module: /chunk.js'),
    })
    win.dispatch('unhandledrejection', {
      reason: new Error('Failed to fetch dynamically imported module: /chunk.js'),
    })
    expect(win.getReloads()).toBe(1)
  })

  it('does NOT reload when the sessionStorage key was set before listening', () => {
    storage.store.set(RELOAD_KEY, '1')
    win.dispatch('unhandledrejection', {
      reason: new Error('Failed to fetch dynamically imported module: /chunk.js'),
    })
    expect(win.getReloads()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// installDynamicImportRecovery — cleanup
// ---------------------------------------------------------------------------

describe('installDynamicImportRecovery – cleanup', () => {
  it('removing listeners stops further reloads', () => {
    const win = makeFakeWindow()
    const storage = makeFakeStorage()
    const cleanup = installDynamicImportRecovery(win, storage)

    cleanup()

    win.dispatch('vite:preloadError')
    expect(win.getReloads()).toBe(0)
  })
})
