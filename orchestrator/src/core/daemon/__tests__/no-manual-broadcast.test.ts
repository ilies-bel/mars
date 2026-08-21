/**
 * Guard: `registerViewInvalidation` is the daemon's ONLY SSE broadcaster.
 *
 * The daemon used to carry ~76 hand-placed `viewStreamHub.broadcast(<channel>)`
 * calls sitting next to the mutations they announced. That wiring was silently
 * incomplete by construction — a new code path only refreshed the UI if its
 * author remembered to add the call, and forgetting produced no failure of any
 * kind, just a stale tab.
 *
 * They are gone. Every refresh is now derived from an event via the
 * `VIEW_CHANNEL_FOR` table in `bus/view-invalidation.ts`; a mutation with no
 * domain event of its own emits a `view.*-invalidated` kind instead. This test
 * fails the moment someone reintroduces a hand-placed broadcast, which is the
 * only way the old drift can come back.
 *
 * Source files only — `stream-hub.ts` (which defines `broadcast`) and tests
 * that exercise the hub directly are legitimately exempt.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The subscriber that owns broadcasting, plus the hub that defines it. */
const EXEMPT = new Set([
  join('bus', 'view-invalidation.ts'),
  join('core', 'daemon', 'view', 'stream-hub.ts'),
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Tests may drive the hub directly; `init/templates` is inert scaffolding.
      if (entry === '__tests__' || entry === 'templates') continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!entry.endsWith('.ts')) continue
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue
    out.push(full)
  }
  return out
}

describe('no hand-placed view-stream broadcasts', () => {
  it('finds no `.broadcast(` call outside the derived-invalidation subscriber', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file)
      if (EXEMPT.has(rel)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const code = line.trim()
        // Prose about the old wiring is not the old wiring.
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        // `.broadcastData(` is a different method: it carries a payload and has
        // no event to derive from, so it is deliberately not covered here.
        if (/\.broadcast\(/.test(code)) offenders.push(`${rel}:${i + 1}: ${code}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('scans a plausible source tree (guards against the walker silently finding nothing)', () => {
    const files = sourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(100)
    expect(files.map((f) => relative(SRC_ROOT, f))).toContain(
      ['core', 'daemon', 'server.ts'].join(sep),
    )
  })
})
