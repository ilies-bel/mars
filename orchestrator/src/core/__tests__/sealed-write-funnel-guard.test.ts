import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * ADR-0052 write-funnel guard (SOURCE LAYER).
 *
 * The seal itself is enforced at runtime by cordis: `store` and `traceStore`
 * are context ACCESSORS, so `provide`/`accessor`/`set`/assignment all throw,
 * inside an isolate scope or not (see `packages/workflow/src/ctx/sealed.ts` and
 * `packages/workflow/test/ctx/sealed.test.ts`). This file is the second layer:
 * it stops the seal being ROUTED AROUND rather than attacked.
 *
 * WHY NOT dependency-cruiser. `npm run arch` sets
 * `includeOnly: '^(orchestrator|packages|scripts)/'`, so npm packages are not
 * in the cruised graph at all and a rule targeting `@deepseek-ai/cordis` would
 * be silently vacuous. dependency-cruiser also reasons about IMPORTS, never
 * about call expressions, so "no `ctx.provide('store', …)`" is not expressible
 * there in any form. A source guard in the suite that already hosts the
 * ADR-0052 any-ban is the mechanism that actually works.
 */

const ORCH_ROOT = resolve(__dirname, '..', '..', '..')
const REPO_ROOT = resolve(ORCH_ROOT, '..')

/** Every first-party source tree the guard walks (tests excluded — see `walk`). */
const SCANNED_ROOTS = [
  resolve(ORCH_ROOT, 'src'),
  resolve(REPO_ROOT, 'packages', 'workflow', 'src'),
]

/**
 * The container seam. These are the only modules allowed to name
 * `@deepseek-ai/cordis` directly; everything else reaches it through the
 * `@mars/workflow` barrel, so exactly one copy of cordis exists in a process
 * (service-class identity is not shared across copies) and exactly one module
 * decides what a run container looks like.
 */
const CORDIS_SEAM = [
  'packages/workflow/src/ctx/',
  // Declares the engine's own `Events` entry next to the code that emits it.
  'packages/workflow/src/workflow.ts',
]

/** Attempts to install, replace or overwrite a sealed service by name. */
const SEALED_WRITE =
  /\.\s*(provide|accessor|set)\s*\(\s*['"`](store|traceStore)['"`]/

/** A real import of cordis, as opposed to a mention of it in prose. */
const CORDIS_IMPORT = /(?:from|import|require)\s*\(?\s*['"`]@deepseek-ai\/cordis['"`]/

/** A VALUE import of FiberState — erased at build time, so `undefined` at runtime. */
const FIBER_STATE_VALUE_IMPORT =
  /import\s+(?!type\b)[^;]*\bFiberState\b[^;]*from\s*['"`]@deepseek-ai\/cordis['"`]/

/** Strip line and block comments so prose about the rule is not an offender. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build') continue
    if (name === '__tests__') continue
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
      continue
    }
    if (!/\.ts$/.test(name)) continue
    if (/\.(test|spec)\.ts$/.test(name)) continue
    out.push(full)
  }
  return out
}

const scannedFiles = (): string[] => SCANNED_ROOTS.flatMap(walk)

/** First offending 1-based line of `pattern` in the comment-stripped source. */
const firstMatch = (src: string, pattern: RegExp): number | null => {
  const lines = stripComments(src).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1
  }
  return null
}

const isUnder = (relPath: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => relPath === prefix || relPath.startsWith(prefix))

describe('ADR-0052: the Arc write funnel cannot be routed around', () => {
  it('the scope resolves to real files (guards against a vacuous pass)', () => {
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.includes(`packages${'/'}workflow`))).toBe(true)
  })

  it('nothing provides, re-declares or overwrites a sealed service by name', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const line = firstMatch(readFileSync(file, 'utf8'), SEALED_WRITE)
      if (line === null) continue
      offenders.push(
        `${relative(REPO_ROOT, file)}:${line} — "store" and "traceStore" are SEALED ` +
          'services (ADR-0052). The framework installs them as context accessors in ' +
          'packages/workflow/src/ctx/run-container.ts; a tool returns a result and the ' +
          'framework-owned shell writes. Inject what you need instead.',
      )
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('only the container seam imports @deepseek-ai/cordis directly', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const relPath = relative(REPO_ROOT, file)
      if (isUnder(relPath, CORDIS_SEAM)) continue
      const line = firstMatch(readFileSync(file, 'utf8'), CORDIS_IMPORT)
      if (line === null) continue
      offenders.push(
        `${relPath}:${line} — import the container surface from '@mars/workflow', not from ` +
          '@deepseek-ai/cordis. Two copies of cordis in one process do not share ' +
          'service-class identity, and the run container is composed in exactly one place ' +
          '(packages/workflow/src/ctx/run-container.ts).',
      )
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('FiberState is never imported as a value', () => {
    // It is a `const enum`: erased from cordis's shipped JavaScript, and NOT
    // inlined by tsx/esbuild either. A value import compiles green and throws
    // at the first property read. Compare against the mirror in
    // packages/workflow/src/ctx/fiber-state.ts.
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const line = firstMatch(readFileSync(file, 'utf8'), FIBER_STATE_VALUE_IMPORT)
      if (line === null) continue
      offenders.push(
        `${relative(REPO_ROOT, file)}:${line} — FiberState is a const enum with no runtime ` +
          "export. Use `import type`, and compare against @mars/workflow's FiberState mirror.",
      )
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('ADR-0052 write-funnel guard: meta-guard (the patterns actually match)', () => {
  it('SEALED_WRITE catches every route at a sealed name', () => {
    expect(SEALED_WRITE.test("ctx.provide('store', fake)")).toBe(true)
    expect(SEALED_WRITE.test('ctx.accessor("traceStore", { get })')).toBe(true)
    expect(SEALED_WRITE.test("ctx.set('store', fake)")).toBe(true)
    expect(SEALED_WRITE.test("ctx.isolate('store').provide('store', fake)")).toBe(true)
    // Not a sealed name, and not a sealed-name method.
    expect(SEALED_WRITE.test("ctx.provide('agent', impl)")).toBe(false)
    expect(SEALED_WRITE.test("ctx.get('store')")).toBe(false)
  })

  it('CORDIS_IMPORT catches imports but not prose', () => {
    expect(CORDIS_IMPORT.test("import { Context } from '@deepseek-ai/cordis'")).toBe(true)
    expect(CORDIS_IMPORT.test("await import('@deepseek-ai/cordis')")).toBe(true)
    expect(CORDIS_IMPORT.test(stripComments('// we vendor @deepseek-ai/cordis here'))).toBe(false)
  })

  it('FIBER_STATE_VALUE_IMPORT catches value imports but not type imports', () => {
    expect(
      FIBER_STATE_VALUE_IMPORT.test("import { FiberState } from '@deepseek-ai/cordis'"),
    ).toBe(true)
    expect(
      FIBER_STATE_VALUE_IMPORT.test("import type { FiberState } from '@deepseek-ai/cordis'"),
    ).toBe(false)
  })
})
