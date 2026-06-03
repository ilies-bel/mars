/**
 * Lint-style regression test: every exec() / execProbe() call in git.ts must
 * pass resolveGitBin() (or another absolute-path expression) as its first
 * argument, never the bare string literal 'git'.
 *
 * Background: a stripped PATH (e.g. a launchd/daemon context on macOS) causes
 * `spawn 'git'` to throw ENOENT even when /usr/bin/git exists. resolveGitBin()
 * checks PATH *plus* FALLBACK_CLAUDE_PATH_DIRS (/usr/bin, /opt/homebrew/bin,
 * etc.), so it finds git even with a stripped PATH.
 *
 * The fix landed in mars-694e1466. This test ensures the regression never
 * silently reappears.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The git library was split from a single `git.ts` into the `git/` directory
// (internal/worktree/claude/verify/merge/lock). The exec/execProbe shims live
// in `git/internal.ts` and their callers in the sibling modules — scan the
// whole concatenated module so the lint covers every call site.
const GIT_DIR = resolve(join(__dirname, '..', 'git'))
const GIT_SOURCE = readdirSync(GIT_DIR)
  .filter((name) => extname(name) === '.ts' && !name.endsWith('.test.ts'))
  .sort()
  .map((name) => readFileSync(join(GIT_DIR, name), 'utf-8'))
  .join('\n')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a source string and the index of an opening `(`, extract all text
 * between that `(` and its matching `)`, bracket-aware.
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
  return source.slice(openParen + 1)
}

/**
 * Extract the first argument from an argument list string.
 * Handles leading whitespace and newlines inside the call.
 */
function extractFirstArg(argText: string): string {
  // Skip leading whitespace / newlines
  const trimmed = argText.trimStart()
  // Bare string literal: 'git' or "git"
  const litMatch = /^(['"])([^'"]*)\1/.exec(trimmed)
  if (litMatch) return litMatch[0]
  // Function call or identifier: grab until the first top-level comma
  let depth = 0
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 0) return trimmed.slice(0, i).trim()
  }
  return trimmed.trim()
}

/** 1-based line number for a character offset in `source`. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('git/ exec/execProbe command-position arg — lint', () => {
  it('passes resolveGitBin() (not bare "git") as the command to every exec/execProbe call', () => {
    const source = GIT_SOURCE

    // Match standalone exec( and execProbe( — exclude method calls like re.exec(
    const callRe = /(?<![.\w])(exec|execProbe)\s*\(/g

    const violations: string[] = []
    let match: RegExpExecArray | null

    while ((match = callRe.exec(source)) !== null) {
      const openParen = match.index + match[0].length - 1
      const argText = extractArgText(source, openParen)
      const firstArg = extractFirstArg(argText)

      // A bare string literal 'git' or "git" is a violation.
      if (firstArg === "'git'" || firstArg === '"git"') {
        const line = lineOf(source, match.index)
        violations.push(`  git/:${line} — ${match[1]}() first arg is bare ${firstArg}`)
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ''
        : [
            'exec/execProbe call sites that use bare "git" instead of resolveGitBin():',
            ...violations,
            '',
            'Fix: replace bare \'git\' with resolveGitBin() so a stripped PATH',
            '(e.g. launchd/daemon context) does not cause spawn ENOENT.',
          ].join('\n'),
    ).toHaveLength(0)
  })

  it('finds at least one exec/execProbe call to confirm the scan is working', () => {
    const source = GIT_SOURCE
    // Sanity: the module must have exec/execProbe calls; if the scan found
    // zero, the regex is wrong or the files were gutted.
    const callRe = /(?<![.\w])(exec|execProbe)\s*\(/g
    let count = 0
    while (callRe.exec(source)) count++
    expect(count, 'git/ must contain at least one exec/execProbe call').toBeGreaterThan(0)
  })
})
