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
  it('navigates to #/chat when pressed in a plain context', () => {
    pressKey('t')
    expect(window.location.hash).toBe('#/chat')
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
// 1-9 keys — focus task card by index
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — 1-9 keys', () => {
  it('focuses the task card with data-task-index="0" when pressing 1', () => {
    const card = document.createElement('div')
    card.setAttribute('data-task-index', '0')
    card.setAttribute('tabindex', '0')
    document.body.appendChild(card)

    pressKey('1')

    expect(document.activeElement).toBe(card)
    document.body.removeChild(card)
  })

  it('focuses the task card at index 2 when pressing 3', () => {
    const card = document.createElement('div')
    card.setAttribute('data-task-index', '2')
    card.setAttribute('tabindex', '0')
    document.body.appendChild(card)

    pressKey('3')

    expect(document.activeElement).toBe(card)
    document.body.removeChild(card)
  })

  it('does not throw when no card with the requested index exists', () => {
    // No [data-task-index="0"] in DOM — pressing '1' should be a no-op
    expect(() => pressKey('1')).not.toThrow()
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
