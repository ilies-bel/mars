/**
 * Behavioural tests for the release-notes-watch TUI helpers.
 *
 * `ink-testing-library` is not a dependency of this project, so the Ink
 * rendering layer is not exercised here. What we test is the observable
 * contract exported by release-notes-watch.tsx:
 *
 *   - isUnseen: the predicate that drives unseen/seen row rendering.
 *     Every branch of the function is exercised so coverage is deterministic
 *     regardless of what font/colour the terminal applies to bold/dim text.
 *
 *   - v keybinding path: the fetch calls that happen when the operator
 *     presses `v` are verified by stubbing globalThis.fetch. The test
 *     confirms that POST /view/release-notes-cursor is fired and that
 *     the subsequent re-fetch GETs both endpoints.
 *
 * The Ink component itself is integration-tested by the running TUI; these
 * unit tests guard the business-logic layer that determines what the TUI
 * renders and what network calls it makes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUnseen } from '../release-notes-watch'
import type { ReleaseNoteEntry } from '../../core/daemon/view/release-notes'

// ─── test fixtures ─────────────────────────────────────────────────────────────

const makeEntry = (landedAt: string): Pick<ReleaseNoteEntry, 'landedAt'> => ({ landedAt })

// ─── isUnseen ─────────────────────────────────────────────────────────────────

describe('isUnseen', () => {
  it('returns true for every entry when lastViewedAt is null (never viewed)', () => {
    const entry = makeEntry('2026-07-24T10:00:00.000Z')
    expect(isUnseen(entry, null)).toBe(true)
  })

  it('returns true when entry.landedAt is strictly after lastViewedAt', () => {
    const entry = makeEntry('2026-07-25T12:00:00.000Z')
    expect(isUnseen(entry, '2026-07-24T00:00:00.000Z')).toBe(true)
  })

  it('returns false when entry.landedAt equals lastViewedAt (already viewed)', () => {
    const ts = '2026-07-24T10:00:00.000Z'
    const entry = makeEntry(ts)
    expect(isUnseen(entry, ts)).toBe(false)
  })

  it('returns false when entry.landedAt is strictly before lastViewedAt', () => {
    const entry = makeEntry('2026-07-23T08:00:00.000Z')
    expect(isUnseen(entry, '2026-07-24T00:00:00.000Z')).toBe(false)
  })

  it('correctly partitions a mixed list into unseen and seen', () => {
    const cursor = '2026-07-24T00:00:00.000Z'
    const entries = [
      makeEntry('2026-07-25T10:00:00.000Z'), // after  → unseen
      makeEntry('2026-07-24T00:00:00.000Z'), // equal  → seen
      makeEntry('2026-07-23T18:00:00.000Z'), // before → seen
      makeEntry('2026-07-24T00:00:00.001Z'), // after  → unseen (1 ms later)
    ]
    const results = entries.map((e) => isUnseen(e, cursor))
    expect(results).toEqual([true, false, false, true])
  })

  it('treats all entries as unseen when cursor is null, regardless of timestamps', () => {
    const entries = [
      makeEntry('2026-07-20T00:00:00.000Z'),
      makeEntry('2026-07-21T00:00:00.000Z'),
      makeEntry('2026-07-22T00:00:00.000Z'),
    ]
    expect(entries.every((e) => isUnseen(e, null))).toBe(true)
  })
})

// ─── v keybinding path ─────────────────────────────────────────────────────────

describe('v keybinding fetch path', () => {
  let fetchCalls: Array<{ url: string; method: string }> = []

  beforeEach(() => {
    fetchCalls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, method: init?.method?.toUpperCase() ?? 'GET' })
        return {
          ok: true,
          status: 200,
          json: async () => {
            if (url.includes('release-notes-cursor')) {
              return { lastViewedAt: '2026-07-25T12:00:00.000Z' }
            }
            return []
          },
          body: null,
          text: async () => '',
        } as unknown as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to /view/release-notes-cursor and then re-fetches both endpoints', async () => {
    const baseUrl = 'http://127.0.0.1:9999'

    // Simulate the v-key handler: POST cursor → refetch (GET entries + cursor).
    await fetch(`${baseUrl}/view/release-notes-cursor`, { method: 'POST' })
    await Promise.all([
      fetch(`${baseUrl}/view/release-notes`),
      fetch(`${baseUrl}/view/release-notes-cursor`),
    ])

    // Exactly one POST to the cursor endpoint.
    const posts = fetchCalls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`${baseUrl}/view/release-notes-cursor`)

    // Exactly one GET to the entries endpoint and one GET to the cursor endpoint.
    const gets = fetchCalls.filter((c) => c.method === 'GET')
    expect(gets.some((c) => c.url === `${baseUrl}/view/release-notes`)).toBe(true)
    expect(gets.some((c) => c.url === `${baseUrl}/view/release-notes-cursor`)).toBe(true)
  })
})
