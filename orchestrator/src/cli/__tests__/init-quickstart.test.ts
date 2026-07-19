/**
 * Unit tests for the probe + env-defaults logic exported from install.ts.
 *
 * These tests exercise pure/injectable functions only — no daemon, no TTY, no
 * real filesystem calls. The goal is to verify that:
 *   - detectMarsEnvOverrides correctly classifies known vs. unknown MARS_* vars
 *   - formatClaudeAuthNote produces the right message for each auth state
 *   - checkAlreadyInitialized delegates to the injected fileExists and checks
 *     the correct path
 */

import { describe, expect, it } from 'vitest'
import {
  checkAlreadyInitialized,
  detectMarsEnvOverrides,
  formatClaudeAuthNote,
} from '../commands/install'

// ---------------------------------------------------------------------------
// detectMarsEnvOverrides
// ---------------------------------------------------------------------------

describe('detectMarsEnvOverrides', () => {
  it('returns empty arrays when no MARS_* vars are in env', () => {
    const { active, ignored } = detectMarsEnvOverrides({})
    expect(active).toEqual([])
    expect(ignored).toEqual([])
  })

  it('skips non-MARS_* env vars', () => {
    const { active, ignored } = detectMarsEnvOverrides({
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/user',
      NODE_ENV: 'test',
    })
    expect(active).toEqual([])
    expect(ignored).toEqual([])
  })

  it('skips empty-value MARS_* vars', () => {
    const { active, ignored } = detectMarsEnvOverrides({ MARS_REPO: '' })
    expect(active).toEqual([])
    expect(ignored).toEqual([])
  })

  it('classifies MARS_REPO as an active override with a descriptive note', () => {
    const { active, ignored } = detectMarsEnvOverrides({ MARS_REPO: '/my/repo' })
    expect(active).toHaveLength(1)
    expect(active[0]?.key).toBe('MARS_REPO')
    expect(active[0]?.value).toBe('/my/repo')
    expect(active[0]?.note).toBeTruthy()
    expect(ignored).toEqual([])
  })

  it('classifies MARS_CLAUDE_BIN as an active override', () => {
    const { active } = detectMarsEnvOverrides({ MARS_CLAUDE_BIN: '/usr/local/bin/claude' })
    expect(active.some((e) => e.key === 'MARS_CLAUDE_BIN')).toBe(true)
  })

  it('classifies MARS_WORKER_MODEL as an active override', () => {
    const { active } = detectMarsEnvOverrides({ MARS_WORKER_MODEL: 'claude-opus-4-7' })
    expect(active.some((e) => e.key === 'MARS_WORKER_MODEL')).toBe(true)
  })

  it('classifies an unknown MARS_* var as ignored with a reason', () => {
    const { ignored } = detectMarsEnvOverrides({ MARS_COMPLETELY_UNKNOWN_THING: 'yes' })
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.key).toBe('MARS_COMPLETELY_UNKNOWN_THING')
    expect(ignored[0]?.reason).toBeTruthy()
    expect(ignored[0]?.reason.length).toBeGreaterThan(0)
  })

  it('handles a mix of known active, unknown ignored, and non-MARS vars', () => {
    const { active, ignored } = detectMarsEnvOverrides({
      MARS_REPO: '/some/path',
      MARS_WORKER_MODEL: 'claude-opus',
      MARS_SOME_INTERNAL_TIMER_MS: '5000',
      PATH: '/usr/bin',
    })
    expect(active.map((e) => e.key)).toEqual(
      expect.arrayContaining(['MARS_REPO', 'MARS_WORKER_MODEL']),
    )
    expect(ignored.some((e) => e.key === 'MARS_SOME_INTERNAL_TIMER_MS')).toBe(true)
    // PATH must not appear in either list
    expect([...active, ...ignored].some((e) => e.key === 'PATH')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// formatClaudeAuthNote
// ---------------------------------------------------------------------------

describe('formatClaudeAuthNote', () => {
  it('returns an empty string when claude is not available', () => {
    expect(formatClaudeAuthNote(false, false)).toBe('')
    expect(formatClaudeAuthNote(false, true)).toBe('')
  })

  it('returns the login-reuse message when claude is present and no API key is set', () => {
    const note = formatClaudeAuthNote(true, false)
    expect(note).toMatch(/Claude Code login/i)
    expect(note).toMatch(/no API key needed/i)
  })

  it('mentions the checkmark when claude is present and no API key', () => {
    const note = formatClaudeAuthNote(true, false)
    expect(note).toContain('✓')
  })

  it('returns the API-key message when ANTHROPIC_API_KEY is set', () => {
    const note = formatClaudeAuthNote(true, true)
    expect(note).toMatch(/ANTHROPIC_API_KEY/i)
  })

  it('the two present-claude messages are distinct', () => {
    const withKey = formatClaudeAuthNote(true, true)
    const withLogin = formatClaudeAuthNote(true, false)
    expect(withKey).not.toBe(withLogin)
  })
})

// ---------------------------------------------------------------------------
// checkAlreadyInitialized
// ---------------------------------------------------------------------------

describe('checkAlreadyInitialized', () => {
  it('returns false when the injected fileExists returns false', () => {
    const result = checkAlreadyInitialized('/some/repo', () => false)
    expect(result).toBe(false)
  })

  it('returns true when the injected fileExists returns true', () => {
    const result = checkAlreadyInitialized('/some/repo', () => true)
    expect(result).toBe(true)
  })

  it('passes the expected mars.db path to fileExists', () => {
    const seen: string[] = []
    checkAlreadyInitialized('/my/project', (p) => {
      seen.push(p)
      return false
    })
    expect(seen).toHaveLength(1)
    // The path must end with .mars/mars.db under the repo root
    expect(seen[0]).toMatch(/\.mars[/\\]mars\.db$/)
    expect(seen[0]).toContain('my')
    expect(seen[0]).toContain('project')
  })
})
