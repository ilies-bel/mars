// @vitest-environment happy-dom
/**
 * Behaviour tests for useGlobalKeyboardShortcuts.
 *
 * Strategy: mount a minimal component that calls the hook, dispatch keyboard
 * events on the document, and assert on observable effects (window.location.hash
 * for navigation, document.activeElement for focus).
 *
 * Tests verify BEHAVIOUR through the public interface — no assertions on
 * internal state, internal functions, or implementation details.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { useGlobalKeyboardShortcuts } from '@/shared/useGlobalKeyboardShortcuts'

// ---------------------------------------------------------------------------
// Minimal test component — just calls the hook
// ---------------------------------------------------------------------------

const TestApp = () => {
  useGlobalKeyboardShortcuts()
  return null
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(TestApp))
  })
  // Ensure a known, non-overlay starting hash for each test
  window.location.hash = '#/progress'
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  window.location.hash = '#/'
})

/** Dispatch a keydown event on a target (defaults to document). */
const pressKey = (key: string, target: EventTarget = document, extra?: KeyboardEventInit) => {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }),
  )
}

// ---------------------------------------------------------------------------
// 't' key — navigate to chat
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — t key', () => {
  it('navigates to #/triage when pressed in a plain context', () => {
    pressKey('t')
    expect(window.location.hash).toBe('#/triage')
  })
})

// ---------------------------------------------------------------------------
// '?' key — open shortcuts overlay
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — ? key', () => {
  it('navigates to #/shortcuts when pressed', () => {
    pressKey('?')
    expect(window.location.hash).toBe('#/shortcuts')
  })
})

// ---------------------------------------------------------------------------
// 1-9 keys — removed
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — digits are not bound', () => {
  it('leaves the digits alone', () => {
    // The old handler focused `[data-task-index="<n>"]`. That attribute is
    // rendered by no component in the app — it existed only in this file,
    // which set it by hand and then proved the hook could find it. The tests
    // passed for the whole life of a shortcut that had never worked.
    for (const k of ['1', '5', '9']) {
      expect(() => pressKey(k)).not.toThrow()
      expect(window.location.hash).toBe('#/progress')
    }
  })
})

// ---------------------------------------------------------------------------
// Guards — inert in editable contexts
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — editable target guard', () => {
  it('does not navigate when t is pressed with an input as event target', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)

    pressKey('t', input)

    expect(window.location.hash).toBe('#/progress')
    document.body.removeChild(input)
  })

  it('does not navigate when t is pressed with a textarea as event target', () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    pressKey('t', textarea)

    expect(window.location.hash).toBe('#/progress')
    document.body.removeChild(textarea)
  })

  it('does not navigate when t is pressed with a select as event target', () => {
    const select = document.createElement('select')
    document.body.appendChild(select)

    pressKey('t', select)

    expect(window.location.hash).toBe('#/progress')
    document.body.removeChild(select)
  })
})

// ---------------------------------------------------------------------------
// Guards — inert when overlay is open
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — overlay guard', () => {
  it('does not navigate when t is pressed while a task drawer is open', () => {
    window.location.hash = '#/task/mars-abc1'
    pressKey('t')
    expect(window.location.hash).toBe('#/task/mars-abc1')
  })

  it('does not navigate when t is pressed while release-notes overlay is open', () => {
    window.location.hash = '#/release-notes'
    pressKey('t')
    expect(window.location.hash).toBe('#/release-notes')
  })

  it('does not navigate when t is pressed while shortcuts overlay is open', () => {
    window.location.hash = '#/shortcuts'
    pressKey('t')
    expect(window.location.hash).toBe('#/shortcuts')
  })

  it('does not navigate when ? is pressed while a proposal drawer is open', () => {
    window.location.hash = '#/proposal/prop-id'
    pressKey('?')
    expect(window.location.hash).toBe('#/proposal/prop-id')
  })
})

// ---------------------------------------------------------------------------
// Guards — inert when modifier keys are held
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — modifier key guard', () => {
  it('does not navigate when Ctrl+t is pressed', () => {
    pressKey('t', document, { ctrlKey: true })
    expect(window.location.hash).toBe('#/progress')
  })

  it('does not navigate when Meta+t is pressed', () => {
    pressKey('t', document, { metaKey: true })
    expect(window.location.hash).toBe('#/progress')
  })

  it('does not navigate when Alt+t is pressed', () => {
    pressKey('t', document, { altKey: true })
    expect(window.location.hash).toBe('#/progress')
  })
})

// ---------------------------------------------------------------------------
// Guards — inert during IME composition (isComposing)
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — isComposing guard', () => {
  it('does not navigate when t is pressed during IME composition', () => {
    pressKey('t', document, { isComposing: true })
    expect(window.location.hash).toBe('#/progress')
  })

  it('does not navigate when ? is pressed during IME composition', () => {
    pressKey('?', document, { isComposing: true })
    expect(window.location.hash).toBe('#/progress')
  })


})
