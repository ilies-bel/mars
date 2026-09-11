/**
 * App routing behaviour tests.
 *
 * Asserts:
 *   1. Closing a drawer opened from any route returns to THAT route —
 *      table-driven over every RouteName so a new page cannot slip through
 *      without a test.  The close logic in App.tsx calls routeBase(origin),
 *      so testing routeBase is equivalent to testing the close behaviour.
 *
 *   2. The base for every route is DERIVED from the route name, not hand-
 *      maintained — `routeBase(r) === '#/' + r` for all routes except arc-qa.
 *
 *   3. An unrecognised hash does not silently render a different page.
 *      isKnownRoute returns false for unknown paths; the App displays the
 *      not-found state when isUnknownRoute is true.
 *
 *   4. Legacy #/studio hashes redirect to #/scores rather than reaching the
 *      not-found state.
 *
 * These tests run in the 'node' project (no DOM) — they rely only on the
 * routing module's pure functions.
 */
import { describe, expect, it } from 'vitest'
import {
  isKnownRoute,
  resolvePageRoute,
  routeBase,
  ROUTE_NAMES,
} from '@/shared/routing'
import type { RouteName } from '@/shared/routing'

// ---------------------------------------------------------------------------
// 1.  Closing a drawer returns to the origin route
// ---------------------------------------------------------------------------

describe('routeBase — closing a drawer returns to its origin page', () => {
  // arc-qa has no stable index URL (every visit embeds an origin id), so
  // Progress is the declared fallback.
  const EXPLICIT_EXCEPTIONS: Partial<Record<RouteName, string>> = {
    'arc-qa': '#/progress',
  }

  // Table-driven: every route must be listed.  If a new RouteName is added
  // without an entry here, TypeScript will complain because ROUTE_NAMES is
  // exhaustive and the loop will run against it.
  it.each(ROUTE_NAMES.map((r) => [r]))(
    'closing from %s returns to #/%s (or its declared exception)',
    (route) => {
      const expected = EXPLICIT_EXCEPTIONS[route] ?? `#/${route}`
      expect(routeBase(route)).toBe(expected)
    },
  )
})

// ---------------------------------------------------------------------------
// 2.  The base is derived, not hand-maintained
// ---------------------------------------------------------------------------

describe('routeBase derivation', () => {
  it('returns #/<route> for every route without an explicit exception', () => {
    const exceptions = new Set<RouteName>(['arc-qa'])
    for (const route of ROUTE_NAMES) {
      if (!exceptions.has(route)) {
        expect(routeBase(route), `routeBase('${route}')`).toBe(`#/${route}`)
      }
    }
  })

  it('arc-qa returns #/progress (the one explicit exception)', () => {
    expect(routeBase('arc-qa')).toBe('#/progress')
  })
})

// ---------------------------------------------------------------------------
// 3.  Unknown hashes are not silently treated as known pages
// ---------------------------------------------------------------------------

describe('isKnownRoute — unknown hashes are not silently accepted', () => {
  const unknownCases = [
    '#/typo',
    '#/control-room',  // natural guess at sidebar label — must NOT silently render a page
    '#/scores/',       // trailing slash with no id — always unknown
    '#/notaroute',
    '#/studio/',       // trailing slash — not a valid legacy redirect target
    '#/primitive',     // bare primitive without a name segment
  ]

  it.each(unknownCases.map((h) => [h]))(
    '%s is not a known route',
    (hash) => {
      expect(isKnownRoute(hash), `isKnownRoute('${hash}')`).toBe(false)
    },
  )
})

describe('isKnownRoute — all canonical routes are accepted', () => {
  // Bare canonical route hashes (index forms)
  const knownIndexHashes: string[] = ROUTE_NAMES.filter((r) => r !== 'arc-qa').map(
    (r) => `#/${r}`,
  )

  it.each(knownIndexHashes.map((h) => [h]))(
    '%s is a known route',
    (hash) => {
      expect(isKnownRoute(hash), `isKnownRoute('${hash}')`).toBe(true)
    },
  )

  it('task overlay hashes are known', () => {
    expect(isKnownRoute('#/task/mars-abc123')).toBe(true)
    expect(isKnownRoute('#/task/mars-abc123?from=triage')).toBe(true)
  })

  it('proposal overlay hashes are known', () => {
    expect(isKnownRoute('#/proposal/some-id')).toBe(true)
    expect(isKnownRoute('#/proposal-node/some-id')).toBe(true)
  })

  it('detail-sub-route hashes are known', () => {
    expect(isKnownRoute('#/scores/mars-abc123')).toBe(true)
    expect(isKnownRoute('#/kpi/failure_rate')).toBe(true)
    expect(isKnownRoute('#/arc/mars-abc123/qa')).toBe(true)
  })

  it('release-notes and shortcuts overlays are known', () => {
    expect(isKnownRoute('#/release-notes')).toBe(true)
    expect(isKnownRoute('#/shortcuts')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4.  Legacy #/studio hashes are recognised (redirected, not not-found)
// ---------------------------------------------------------------------------

describe('legacy #/studio redirect — isKnownRoute marks them as known', () => {
  it('#/studio (bare) is known so the App can redirect without a not-found flash', () => {
    expect(isKnownRoute('#/studio')).toBe(true)
  })

  it('#/studio/<id> is known for the same reason', () => {
    expect(isKnownRoute('#/studio/mars-abc123')).toBe(true)
  })

  it('#/studio/ (trailing slash, no id) is NOT known — same as #/scores/', () => {
    expect(isKnownRoute('#/studio/')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5.  resolvePageRoute returns the correct page for each top-level route
// ---------------------------------------------------------------------------

describe('resolvePageRoute — maps canonical hashes to their page route', () => {
  it.each(
    ROUTE_NAMES
      .filter((r) => r !== 'arc-qa' && r !== 'kpi' && r !== 'scores')
      .map((r) => [r, `#/${r}`] as [RouteName, string]),
  )(
    'resolvePageRoute("#/%s") === "%s"',
    (route, hash) => {
      expect(resolvePageRoute(hash)).toBe(route)
    },
  )

  it('resolvePageRoute("#/scores") === "scores"', () => {
    expect(resolvePageRoute('#/scores')).toBe('scores')
  })

  it('resolvePageRoute("#/scores/<id>") === "scores"', () => {
    expect(resolvePageRoute('#/scores/mars-abc123')).toBe('scores')
  })

  it('resolvePageRoute("#/kpi/<key>") === "kpi"', () => {
    expect(resolvePageRoute('#/kpi/failure_rate')).toBe('kpi')
  })
})
