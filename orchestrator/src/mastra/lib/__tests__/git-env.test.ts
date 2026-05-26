/**
 * Lint-style test: every spawn/exec/execFile call site in the git library
 * must either omit the `env` option (inheriting process.env by default) or
 * demonstrably include PATH in the supplied env.
 *
 * A future regression that passes an explicit env object without spreading
 * process.env will cause git/claude/verify binaries to fail with ENOENT on
 * systems where those binaries are only reachable via PATH.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// lib/ is the parent of __tests__/
const libDir = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Source-file collection
// ---------------------------------------------------------------------------

/** All non-test TypeScript source files directly inside lib/ (not recursive). */
function collectSourceFiles(): string[] {
  return readdirSync(libDir)
    .filter(
      (name) =>
        name !== '__tests__' &&
        extname(name) === '.ts' &&
        !name.endsWith('.test.ts'),
    )
    .map((name) => join(libDir, name))
    .filter((p) => statSync(p).isFile())
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Given a string and the index of an opening `(`, return the text between
 * that `(` and its matching `)` (the outer parens are excluded).
 * Respects nested `()`, `{}`, and `[]`.
 */
function extractArgText(source: string, openParen: number): string {
  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (--depth === 0) return source.slice(openParen + 1, i)
    }
  }
  // Unclosed — return rest of file (will surface as a lint warning, not a crash)
  return source.slice(openParen + 1)
}

/**
 * Given text starting immediately after `env:`, extract the env value up to
 * the first top-level `,` or closing delimiter.  Bracket-aware so nested
 * `{ ...process.env, FOO: 'bar' }` is returned in full.
 */
function extractEnvValue(text: string): string {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++
    } else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return text.slice(0, i)
      depth--
    } else if (ch === ',' && depth === 0) {
      return text.slice(0, i)
    }
  }
  return text
}

/** 1-based line number for a character offset inside `source`. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

// ---------------------------------------------------------------------------
// Safety predicate
// ---------------------------------------------------------------------------

/**
 * Returns true when an env value expression demonstrably includes PATH:
 *
 *  - references `process.env` (spread, direct assignment, or ?? fallback)
 *  - calls `buildWorkerEnv()` which always starts with `{ ...process.env }`
 *  - sets an explicit `PATH:` key in an object literal
 */
function envPreservesPath(envValue: string): boolean {
  if (envValue.includes('process.env')) return true
  if (/\bbuildWorkerEnv\s*\(/.test(envValue)) return true
  if (/['"]?PATH['"]?\s*:/.test(envValue)) return true
  return false
}

// ---------------------------------------------------------------------------
// Call-site scanner
// ---------------------------------------------------------------------------

interface CallSite {
  file: string
  line: number
  functionName: string
  /** The env value expression, or null when env is absent. */
  envValue: string | null
}

/**
 * Scan a TypeScript source file and return every spawn / execFile / exec
 * call site, together with the env value expression if one is present in
 * the options argument.
 *
 * The regex uses a negative lookbehind so that method calls such as
 * `re.exec(...)` or `obj.spawn(...)` are excluded.
 */
function scanCallSites(filePath: string, source: string): CallSite[] {
  // Matches standalone (not method) spawn/execFile/exec calls.
  // The opening `(` is the last character captured so match.index +
  // match[0].length - 1 is the index of `(`.
  const callRe = /(?<![.\w])(spawn|execFile|exec)\s*\(/g

  const sites: CallSite[] = []
  let match: RegExpExecArray | null

  while ((match = callRe.exec(source)) !== null) {
    const openParen = match.index + match[0].length - 1
    const argText = extractArgText(source, openParen)

    // Look for `env:` in the argument text.
    // Use `\benv\b` to avoid matching e.g. `environment:`.
    const envKeyMatch = /\benv\s*:/.exec(argText)
    if (!envKeyMatch) {
      // No env option — safe by Node.js default (inherits process.env).
      sites.push({
        file: filePath,
        line: lineOf(source, match.index),
        functionName: match[1],
        envValue: null,
      })
      continue
    }

    const afterEnvKey = argText.slice(envKeyMatch.index + envKeyMatch[0].length).trimStart()
    const envValue = extractEnvValue(afterEnvKey).trim()

    sites.push({
      file: filePath,
      line: lineOf(source, match.index),
      functionName: match[1],
      envValue,
    })
  }

  return sites
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subprocess PATH preservation — lint', () => {
  it('enumerates every spawn/exec/execFile call site and fails if any passes env without PATH', () => {
    const sourceFiles = collectSourceFiles()

    // Sanity guard: the scan must cover at least the main git library file.
    const fileNames = sourceFiles.map((p) => p.split('/').at(-1))
    expect(fileNames, 'git.ts must be in the scanned source set').toContain('git.ts')

    const allSites: CallSite[] = []
    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, 'utf-8')
      allSites.push(...scanCallSites(filePath, source))
    }

    // Must find at least the known spawn() call in git.ts.
    const spawnSites = allSites.filter((s) => s.functionName === 'spawn')
    expect(
      spawnSites.length,
      'Expected at least one spawn() call site to be found in the lib sources',
    ).toBeGreaterThan(0)

    // Collect violations: call sites where env is explicitly set but does NOT
    // demonstrably include PATH.
    const violations = allSites.filter(
      (s) => s.envValue !== null && !envPreservesPath(s.envValue),
    )

    const report = violations
      .map(
        (v) =>
          `  ${v.file}:${v.line} — ${v.functionName}() sets env without PATH: ${v.envValue?.slice(0, 120)}`,
      )
      .join('\n')

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Call sites that drop PATH from the subprocess environment:\n${report}\n` +
            `Fix: spread process.env or use buildWorkerEnv() so PATH-resolved binaries remain reachable.`,
    ).toHaveLength(0)
  })
})
