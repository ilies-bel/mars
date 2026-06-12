/**
 * Lint-style test: every subprocess-spawning call site in the git library AND
 * the worker runtimes must either omit the `env` option (inheriting
 * process.env by default — safe for PATH) or demonstrably include PATH AND
 * use buildWorkerEnv() in the supplied env.
 *
 * Two regression classes this guards:
 *
 *  1. PATH drop — passing an explicit env object without spreading process.env
 *     causes git/claude/verify binaries to fail with ENOENT on systems where
 *     those binaries are only reachable via PATH.
 *
 *  2. Host-agent contamination — the pty path (run-pty-session.ts) spawns a
 *     nested `claude` and originally inherited the daemon's full process.env,
 *     including CLAUDE_*, AI_AGENT, and CMUX_* identity vars. Claude Code's
 *     recursion guard then suppressed the child, which wrote nothing → an
 *     empty diff merged as a false "success". Worker-spawning call sites that
 *     pass an explicit env must route it through buildWorkerEnv() (which
 *     strips those vars). This is why the scan covers `spawnPty` and the
 *     workers/ directory, not just `spawn`/`exec` in lib/git/.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// lib/ is the parent of __tests__/
const libDir = resolve(__dirname, '..')
// workers/ is a sibling of lib/ under core/. The pty worker runtime
// (run-pty-session.ts) spawns a nested `claude` via spawnPty and must be
// covered by the host-agent-contamination lint, not just lib/git/.
const workersDir = resolve(libDir, '..', 'workers')

// ---------------------------------------------------------------------------
// Source-file collection
// ---------------------------------------------------------------------------

/**
 * Non-test TypeScript source files directly inside lib/, PLUS the modules of
 * the `git/` subdirectory, PLUS the `workers/` runtimes. The git library was
 * split out of a single `git.ts` into `git/` (internal/worktree/claude/verify/
 * merge/lock) — the lone spawn() now lives in `git/claude.ts`. The pty worker
 * runtime (`workers/run-pty-session.ts`) spawns a nested `claude` via
 * spawnPty, so workers/ must be scanned too to keep both the
 * PATH-preservation and the host-agent-contamination lints honest.
 */
function collectSourceFiles(): string[] {
  const tsFilesIn = (dir: string): string[] =>
    readdirSync(dir)
      .filter(
        (name) =>
          name !== '__tests__' &&
          extname(name) === '.ts' &&
          !name.endsWith('.test.ts'),
      )
      .map((name) => join(dir, name))
      .filter((p) => statSync(p).isFile())

  return [
    ...tsFilesIn(libDir),
    ...tsFilesIn(join(libDir, 'git')),
    ...tsFilesIn(workersDir),
  ]
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
  // Matches standalone (not method) spawn/spawnPty/execFile/exec calls.
  // spawnPty is the node-pty wrapper used by the worker pty runtime; it takes
  // an options object with the same `env` shape, so the same lint applies.
  // The opening `(` is the last character captured so match.index +
  // match[0].length - 1 is the index of `(`.
  const callRe = /(?<![.\w])(spawnPty|spawn|execFile|exec)\s*\(/g

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

    // Sanity guard: the scan must cover the git library's subprocess module,
    // where the lone spawn() lives after the git.ts → git/ split, AND the pty
    // worker runtime, where the nested-`claude` spawnPty lives.
    const fileNames = sourceFiles.map((p) => p.split('/').at(-1))
    expect(fileNames, 'git/claude.ts must be in the scanned source set').toContain(
      'claude.ts',
    )
    expect(
      fileNames,
      'workers/run-pty-session.ts must be in the scanned source set',
    ).toContain('run-pty-session.ts')

    const allSites: CallSite[] = []
    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, 'utf-8')
      allSites.push(...scanCallSites(filePath, source))
    }

    // Must find at least the known spawn() call in git/claude.ts.
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

  it('spawnPty call sites must route env through buildWorkerEnv() (no bare process.env, no env-less default)', () => {
    // Host-agent contamination guard. A spawnPty that spawns a nested `claude`
    // must NOT inherit the daemon's process.env (which carries CLAUDE*/AI_AGENT/
    // CMUX_* identity vars that trip Claude Code's recursion guard). Unlike the
    // PATH lint, an absent env is a VIOLATION here: the spawnPty wrapper's
    // default is `opts.env ?? process.env`, so omitting env leaks the host
    // session's identity vars verbatim. The env must be present AND use
    // buildWorkerEnv().
    const sourceFiles = collectSourceFiles()
    const ptySites: CallSite[] = []
    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, 'utf-8')
      ptySites.push(
        ...scanCallSites(filePath, source).filter((s) => s.functionName === 'spawnPty'),
      )
    }

    // The pty worker's spawnPty must be discovered, else this lint is vacuous.
    expect(
      ptySites.length,
      'Expected at least one spawnPty() call site (workers/run-pty-session.ts)',
    ).toBeGreaterThan(0)

    const usesBuildWorkerEnv = (envValue: string | null): boolean =>
      envValue !== null && /\bbuildWorkerEnv\s*\(/.test(envValue)

    const leaks = ptySites.filter((s) => !usesBuildWorkerEnv(s.envValue))
    const report = leaks
      .map(
        (v) =>
          `  ${v.file}:${v.line} — spawnPty() env is ${
            v.envValue === null ? 'absent (defaults to process.env)' : `\`${v.envValue.slice(0, 80)}\``
          }`,
      )
      .join('\n')

    expect(
      leaks,
      leaks.length === 0
        ? ''
        : `spawnPty call sites that leak the host-agent env into a nested agent:\n${report}\n` +
            `Fix: pass { ..., env: buildWorkerEnv() } so CLAUDE*/AI_AGENT/CMUX_* are stripped before the nested claude spawns.`,
    ).toHaveLength(0)
  })
})
