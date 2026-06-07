import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/**
 * ADR-0052 any-ban arch-guard (LAYER 2). There is no ESLint in this repo
 * (gating is `tsc --noEmit` strict + vitest only), so the explicit-`any` ban is
 * two layers: LAYER 1 is `"noImplicitAny": true` in tsconfig.json (implied by
 * strict, made explicit + churn-proof); LAYER 2 is this vitest guard rejecting
 * EXPLICIT `any` annotations in the ADR-0052 surface — the Arc domain aggregate
 * (`core/arc.ts`) plus the whole `@mars/workflow` engine (`packages/workflow/src`).
 *
 * SCOPE is deliberately NARROW: the broader `src/` still carries legacy `any`,
 * and this is the ADR-0052 surface only. Both scoped areas are clean today
 * (arc.ts has 0 real `:any`/`as any`; packages/workflow/src has 0 `any` of any
 * kind), so the guard passes; if no real offenders existed the mechanism would
 * still be present and passing per the constraint.
 *
 * The pattern runs over source with comments AND string/template literals
 * blanked out, so an `as any` that appears inside a fix-recipe prompt STRING or
 * in prose is not flagged (scoping to arc.ts + engine already steers clear of
 * the fix-recipes.ts prompt strings, but the string-strip is belt-and-braces).
 */

const ORCH_ROOT = resolve(__dirname, '..', '..', '..')
const REPO_ROOT = resolve(ORCH_ROOT, '..')

// Scope: the Arc domain aggregate + the whole @mars/workflow engine source.
const ARC_FILE = resolve(ORCH_ROOT, 'src', 'core', 'arc.ts')
const ENGINE_SRC = resolve(REPO_ROOT, 'packages', 'workflow', 'src')

const EXPLICIT_ANY =
  /(:\s*any\b)|(\bas\s+any\b)|(<\s*any\s*>)|(\bany\s*\[\s*\])|(Array\s*<\s*any\s*>)/

/** Strip line and block comments. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * Blank out string and template literals (replace their bodies with empty
 * quotes) so an `as any` inside a literal is not flagged. Order matters: strip
 * comments first so a `//` inside a string is not treated as a comment edge,
 * then blank literals.
 */
const stripStrings = (src: string): string =>
  src
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'])*'/g, "''")
    .replace(/"(?:\\.|[^\\"])*"/g, '""')

const normalize = (raw: string): string => stripStrings(stripComments(raw))

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build') continue
    const full = resolve(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...walk(full))
    } else if (s.isFile() && /\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

/** First offending (1-based) line in the normalized source, or null. */
const firstAnyLine = (normalized: string): number | null => {
  const lines = normalized.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (EXPLICIT_ANY.test(lines[i])) return i + 1
  }
  return null
}

const scopedFiles = (): string[] => [ARC_FILE, ...walk(ENGINE_SRC)]

describe('ADR-0052: explicit `any` is banned in the Arc domain + @mars/workflow engine', () => {
  it('no scoped file uses an explicit any annotation', () => {
    const offenders: string[] = []
    for (const file of scopedFiles()) {
      const line = firstAnyLine(normalize(readFileSync(file, 'utf8')))
      if (line !== null) {
        offenders.push(
          `${relative(REPO_ROOT, file)}:${line} — explicit any is banned in the ` +
            'Arc domain aggregate and the @mars/workflow engine (ADR-0052); use ' +
            'unknown + narrowing or a generic',
        )
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('the scope resolves to real files (arc.ts + a non-empty engine src)', () => {
    // Guards against a path typo silently scanning nothing (vacuous pass).
    const files = scopedFiles()
    expect(files.some((f) => f.endsWith(`core${sep}arc.ts`))).toBe(true)
    expect(files.length).toBeGreaterThan(1)
  })
})

describe('ADR-0052 any-ban guard: meta-guard (catches real annotations, not prose/strings)', () => {
  it('EXPLICIT_ANY catches real any annotations', () => {
    expect(EXPLICIT_ANY.test('const x: any = 1')).toBe(true)
    expect(EXPLICIT_ANY.test('foo as any')).toBe(true)
    expect(EXPLICIT_ANY.test('Array<any>')).toBe(true)
    expect(EXPLICIT_ANY.test('const xs: any[] = []')).toBe(true)
    expect(EXPLICIT_ANY.test('Box<any>')).toBe(true)
  })

  it('EXPLICIT_ANY does NOT flag unknown, nor prose/strings after normalization', () => {
    expect(EXPLICIT_ANY.test('x: unknown')).toBe(false)
    // prose in a comment, after comment-strip → blanked → no match
    expect(EXPLICIT_ANY.test(normalize('// mentions any in a comment'))).toBe(false)
    // `as any` inside a template/string literal, after string-strip → no match
    expect(EXPLICIT_ANY.test(normalize('const s = `do not use as any`'))).toBe(false)
    expect(EXPLICIT_ANY.test(normalize(`const s = 'cast as any here'`))).toBe(false)
  })
})
