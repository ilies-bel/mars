/**
 * Tests for the .gitignore scaffold (ADR-0099 — Postgres data loss on fresh
 * install caused by the scaffolded .gitignore not covering .mars/).
 *
 * Acceptance criteria:
 *   - The bundled .gitignore template contains the JVM block, .mars/, and
 *     node_modules/ under their respective comments.
 *   - mergeGitignore applied to an empty string gains all three blocks.
 *   - mergeGitignore applied to a file that has the JVM block but not .mars/
 *     gains .mars/ — the load-bearing regression guard: without this, every
 *     repo initialised before ADR-0099 ships would remain unprotected.
 *   - Each block is checked independently — a repo that has .mars/ but not
 *     node_modules/ gains only the missing block.
 *   - mergeGitignore is idempotent: if all sentinels are already present, the
 *     output string is the original unchanged (not even a trailing-newline
 *     diff).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mergeGitignore } from '../scaffold'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BUNDLED_GITIGNORE_PATH = resolve(__dirname, '..', 'templates', '.gitignore')

// ---------------------------------------------------------------------------
// Template content checks
// ---------------------------------------------------------------------------

describe('bundled .gitignore template', () => {
  it('contains hs_err_pid*.log', () => {
    const content = readFileSync(BUNDLED_GITIGNORE_PATH, 'utf8')
    expect(content).toContain('hs_err_pid*.log')
  })

  it('contains replay_pid*.log', () => {
    const content = readFileSync(BUNDLED_GITIGNORE_PATH, 'utf8')
    expect(content).toContain('replay_pid*.log')
  })

  it('groups patterns under a # JVM crash dumps comment', () => {
    const content = readFileSync(BUNDLED_GITIGNORE_PATH, 'utf8')
    expect(content).toMatch(/# JVM crash dumps/)
  })

  it('contains .mars/ so consumer repos ignore the live database directory', () => {
    const content = readFileSync(BUNDLED_GITIGNORE_PATH, 'utf8')
    expect(content).toContain('.mars/')
  })

  it('contains node_modules/ so consumer repos ignore dependency directories', () => {
    const content = readFileSync(BUNDLED_GITIGNORE_PATH, 'utf8')
    expect(content).toContain('node_modules/')
  })
})

// ---------------------------------------------------------------------------
// mergeGitignore behaviour
// ---------------------------------------------------------------------------

describe('mergeGitignore', () => {
  it('applied to an empty string produces output containing the JVM block', () => {
    const result = mergeGitignore('')
    expect(result).toContain('hs_err_pid*.log')
    expect(result).toContain('replay_pid*.log')
    expect(result).toMatch(/# JVM crash dumps/)
  })

  it('applied to an empty string produces output containing .mars/ and node_modules/', () => {
    const result = mergeGitignore('')
    expect(result).toContain('.mars/')
    expect(result).toContain('node_modules/')
  })

  it('is idempotent: re-applying to already-merged output returns the identical string', () => {
    const once = mergeGitignore('')
    const twice = mergeGitignore(once)
    // Strict reference equality — not even a trailing-newline diff.
    expect(twice).toBe(once)
  })

  // ------------------------------------------------------------------
  // Regression guard (ADR-0099 load-bearing case): repos initialised
  // before this fix already have the JVM block but lack .mars/ and
  // node_modules/. The old all-or-nothing check skipped such repos
  // entirely; the new per-block check must repair them.
  // ------------------------------------------------------------------

  it('appends .mars/ and node_modules/ even when the JVM block is already present', () => {
    const existing = '# my stuff\nhs_err_pid*.log\nreplay_pid*.log\n'
    const result = mergeGitignore(existing)
    // The JVM patterns must not be duplicated.
    expect(result.match(/hs_err_pid\*\.log/g)?.length).toBe(1)
    // The previously-missing blocks must now be present.
    expect(result).toContain('.mars/')
    expect(result).toContain('node_modules/')
  })

  it('appends .mars/ and node_modules/ even when only one JVM pattern is present', () => {
    // A repo that partially has the JVM sentinel still has the sentinel → the
    // JVM block is not re-added, but the other missing blocks are.
    const existing = 'hs_err_pid*.log\n'
    const result = mergeGitignore(existing)
    expect(result.match(/hs_err_pid\*\.log/g)?.length).toBe(1)
    expect(result).toContain('.mars/')
    expect(result).toContain('node_modules/')
  })

  it('does not duplicate .mars/ when it is already present', () => {
    const existing = '.mars/\nnode_modules/\n'
    const result = mergeGitignore(existing)
    expect(result.match(/^\.mars\/$/m)?.length).toBe(1)
  })

  it('appends only missing blocks — a file with .mars/ still gets node_modules/ if absent', () => {
    const existing = '# Per-repo state\n.mars/\n'
    const result = mergeGitignore(existing)
    expect(result).toContain('.mars/')
    expect(result).toContain('node_modules/')
    expect(result).toContain('hs_err_pid*.log')
    // .mars/ must appear exactly once.
    expect(result.match(/^\.mars\/$/m)?.length).toBe(1)
  })

  it('preserves existing content and separates each appended block with a blank line', () => {
    const existing = '# Node\nnode_modules/\n'
    const result = mergeGitignore(existing)
    expect(result).toContain('node_modules/')
    expect(result).toContain('hs_err_pid*.log')
    expect(result).toContain('replay_pid*.log')
    // Must not run the existing content into the new block without a separator
    const lines = result.split('\n')
    const jvmIdx = lines.findIndex((l) => l.includes('hs_err_pid'))
    expect(jvmIdx).toBeGreaterThan(0)
    // The line before the JVM block must be a comment or blank
    const preceding = lines[jvmIdx - 1]
    expect(preceding === '' || preceding.startsWith('#')).toBe(true)
  })
})
