import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { DEFAULT_TAB } from './tabs'
import { VIEW_PREFERENCE_KEY, readPersistedView, writePersistedView } from './viewPreference'
import { readExplicitViewFromUrl } from './progressUrlState'

// ---------------------------------------------------------------------------
// Helpers — fake browser environment
// ---------------------------------------------------------------------------

type FakeStorage = {
  store: Map<string, string>
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  clear(): void
}

const makeFakeStorage = (): FakeStorage => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// readPersistedView / writePersistedView — browser environment
// ---------------------------------------------------------------------------

describe('readPersistedView / writePersistedView – browser environment', () => {
  let fakeStorage: FakeStorage

  beforeEach(() => {
    fakeStorage = makeFakeStorage()
    ;(globalThis as Record<string, unknown>).window = { localStorage: fakeStorage }
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('returns null when nothing is stored yet', () => {
    expect(readPersistedView()).toBeNull()
  })

  it('write then read round-trips board', () => {
    writePersistedView('board')
    expect(readPersistedView()).toBe('board')
  })

  it('write then read round-trips topology', () => {
    writePersistedView('topology')
    expect(readPersistedView()).toBe('topology')
  })

  it('overwriting a previous value takes effect immediately', () => {
    writePersistedView('board')
    writePersistedView('topology')
    expect(readPersistedView()).toBe('topology')
  })

  it('returns null for an invalid stored value', () => {
    fakeStorage.store.set(VIEW_PREFERENCE_KEY, 'not-a-valid-tab')
    expect(readPersistedView()).toBeNull()
  })

  it('returns null for an empty stored value', () => {
    fakeStorage.store.set(VIEW_PREFERENCE_KEY, '')
    expect(readPersistedView()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// readPersistedView – SSR / no window
// ---------------------------------------------------------------------------

describe('readPersistedView – SSR (no window)', () => {
  it('returns null when window is unavailable — does not throw', () => {
    const orig = (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).window
    try {
      expect(() => readPersistedView()).not.toThrow()
      expect(readPersistedView()).toBeNull()
    } finally {
      if (orig !== undefined) {
        ;(globalThis as Record<string, unknown>).window = orig
      }
    }
  })
})

// ---------------------------------------------------------------------------
// writePersistedView – SSR / no window
// ---------------------------------------------------------------------------

describe('writePersistedView – SSR (no window)', () => {
  it('no-ops when window is unavailable — does not throw', () => {
    const orig = (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).window
    try {
      expect(() => writePersistedView('board')).not.toThrow()
    } finally {
      if (orig !== undefined) {
        ;(globalThis as Record<string, unknown>).window = orig
      }
    }
  })
})

// ---------------------------------------------------------------------------
// writePersistedView – storage errors (e.g. private mode quota exceeded)
// ---------------------------------------------------------------------------

describe('writePersistedView – storage errors', () => {
  it('swallows errors thrown by localStorage.setItem — does not throw', () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => {},
        clear: () => {},
      },
    }
    try {
      expect(() => writePersistedView('board')).not.toThrow()
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
  })

  it('swallows errors thrown by localStorage.getItem — does not throw', () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError')
        },
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      },
    }
    try {
      expect(() => readPersistedView()).not.toThrow()
      expect(readPersistedView()).toBeNull()
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
  })
})

// ---------------------------------------------------------------------------
// View precedence: URL explicit param > persisted > DEFAULT_TAB
//
// These tests mirror the resolution logic inside ProgressPage so that if the
// precedence ever regresses the failure points at the pure helper layer, not
// inside the React component.
// ---------------------------------------------------------------------------

describe('view precedence: URL explicit param > persisted > DEFAULT_TAB', () => {
  let fakeStorage: FakeStorage

  beforeEach(() => {
    fakeStorage = makeFakeStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('explicit URL ?view=topology beats localStorage=board', () => {
    fakeStorage.store.set(VIEW_PREFERENCE_KEY, 'board')
    ;(globalThis as Record<string, unknown>).window = {
      location: { hash: '#/progress?view=topology' },
      localStorage: fakeStorage,
    }
    const explicit = readExplicitViewFromUrl()
    const persisted = readPersistedView()
    expect(explicit ?? persisted ?? DEFAULT_TAB).toBe('topology')
  })

  it('explicit URL ?view=board beats localStorage=topology', () => {
    fakeStorage.store.set(VIEW_PREFERENCE_KEY, 'topology')
    ;(globalThis as Record<string, unknown>).window = {
      location: { hash: '#/progress?view=board' },
      localStorage: fakeStorage,
    }
    const explicit = readExplicitViewFromUrl()
    const persisted = readPersistedView()
    expect(explicit ?? persisted ?? DEFAULT_TAB).toBe('board')
  })

  it('bare #/progress with localStorage=board uses the persisted value', () => {
    fakeStorage.store.set(VIEW_PREFERENCE_KEY, 'board')
    ;(globalThis as Record<string, unknown>).window = {
      location: { hash: '#/progress' },
      localStorage: fakeStorage,
    }
    const explicit = readExplicitViewFromUrl()
    const persisted = readPersistedView()
    expect(explicit ?? persisted ?? DEFAULT_TAB).toBe('board')
  })

  it('bare #/progress with empty storage falls back to DEFAULT_TAB (topology)', () => {
    ;(globalThis as Record<string, unknown>).window = {
      location: { hash: '#/progress' },
      localStorage: fakeStorage,
    }
    const explicit = readExplicitViewFromUrl()
    const persisted = readPersistedView()
    expect(explicit ?? persisted ?? DEFAULT_TAB).toBe(DEFAULT_TAB)
    expect(explicit ?? persisted ?? DEFAULT_TAB).toBe('topology')
  })

  it('bare #/progress with invalid localStorage value falls back to DEFAULT_TAB', () => {
    fakeStorage.store.set(VIEW_PREFERENCE_KEY, 'invalid')
    ;(globalThis as Record<string, unknown>).window = {
      location: { hash: '#/progress' },
      localStorage: fakeStorage,
    }
    const explicit = readExplicitViewFromUrl()
    const persisted = readPersistedView()
    expect(explicit ?? persisted ?? DEFAULT_TAB).toBe('topology')
  })
})
