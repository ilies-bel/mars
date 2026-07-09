/**
 * Tests for the JVM crash-dump .gitignore scaffold (Slice 9 of PRD
 * e25aa5f1-harden-mars-orchestrator-against-transient).
 *
 * Acceptance criteria:
 *   - The bundled .gitignore template contains hs_err_pid*.log and
 *     replay_pid*.log under a '# JVM crash dumps' comment.
 *   - mergeGitignore applied to an empty string produces a .gitignore that
 *     contains both patterns.
 *   - mergeGitignore is idempotent: if both patterns are already present, the
 *     output is unchanged.
 *   - mergeGitignore only appends if NEITHER pattern is present; a file that
 *     already has one or both patterns is not modified (avoids duplicates in
 *     repos that added the rules manually).
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
})

// ---------------------------------------------------------------------------
// mergeGitignore behaviour
// ---------------------------------------------------------------------------

describe('mergeGitignore', () => {
  it('applied to an empty string produces output containing both patterns', () => {
    const result = mergeGitignore('')
    expect(result).toContain('hs_err_pid*.log')
    expect(result).toContain('replay_pid*.log')
  })

  it('applied to an empty string includes the # JVM crash dumps comment', () => {
    const result = mergeGitignore('')
    expect(result).toMatch(/# JVM crash dumps/)
  })

  it('is idempotent: re-applying to already-merged output returns identical content', () => {
    const once = mergeGitignore('')
    const twice = mergeGitignore(once)
    expect(twice).toBe(once)
  })

  it('does not append when hs_err_pid*.log is already present', () => {
    const existing = '# my stuff\nhs_err_pid*.log\nreplay_pid*.log\n'
    const result = mergeGitignore(existing)
    expect(result).toBe(existing)
  })

  it('does not append when only one pattern is already present', () => {
    const existing = 'hs_err_pid*.log\n'
    const result = mergeGitignore(existing)
    // Even with only hs_err_pid present, we don't add a partial duplicate block
    expect(result).toBe(existing)
  })

  it('preserves existing content and appends a blank-line separator', () => {
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
