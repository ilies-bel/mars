/**
 * Unit tests for the probe + env-defaults logic exported from install.ts,
 * and for the fd-headroom enrichment helper (fd-headroom.ts).
 *
 * These tests exercise pure/injectable functions only — no daemon, no TTY, no
 * real filesystem calls, no shell-outs. The goal is to verify that:
 *   - detectMarsEnvOverrides correctly classifies known vs. unknown MARS_* vars
 *   - formatClaudeAuthNote produces the right message for each auth state
 *   - checkAlreadyInitialized uses readManifest to gate on the init manifest
 *     only (not on .mars/pg/data or the .mars directory itself)
 *   - enrichInitDbError names file descriptors when the probe reports high
 *     usage, returns the original message on healthy headroom or a throwing
 *     probe, and never propagates probe errors
 */

import { describe, expect, it } from 'vitest'
import {
  checkAlreadyInitialized,
  detectMarsEnvOverrides,
  formatClaudeAuthNote,
} from '../commands/install'
import {
  enrichInitDbError,
  probeFdHeadroom,
  type FdHeadroomDeps,
} from '../../core/lib/fd-headroom'

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

  it('describes MARS_CODEX_BIN as a Codex worker binary override', () => {
    const { active } = detectMarsEnvOverrides({ MARS_CODEX_BIN: '/usr/local/bin/codex' })
    expect(active).toContainEqual({
      key: 'MARS_CODEX_BIN',
      value: '/usr/local/bin/codex',
      note: 'codex worker binary path override',
    })
  })

  it('classifies MARS_WORKER_MODEL as an active override', () => {
    const { active } = detectMarsEnvOverrides({ MARS_WORKER_MODEL: 'claude-opus-5' })
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
  it('returns false when readManifest returns an empty array (no manifest or malformed)', () => {
    const result = checkAlreadyInitialized('/some/repo', () => [])
    expect(result).toBe(false)
  })

  it('returns true when readManifest returns a non-empty paths list', () => {
    const result = checkAlreadyInitialized('/some/repo', () => ['CLAUDE.md'])
    expect(result).toBe(true)
  })

  it('passes the .mars directory path (under repoRoot) to readManifest', () => {
    let calledWith = ''
    checkAlreadyInitialized('/my/project', (marsDir) => {
      calledWith = marsDir
      return []
    })
    // readManifest receives the .mars dir, not the individual file path.
    expect(calledWith).toMatch(/my[/\\]project[/\\]\.mars$/)
  })

  // New case 1: .mars present but no init-manifest.json (partial install) →
  // NOT already-initialized; a plain `mars init` must be able to finish the job.
  it('returns false when .mars exists but init-manifest.json is absent (partial install)', () => {
    // Simulate: readInitManifest returns [] because the file does not exist.
    const result = checkAlreadyInitialized('/partial/repo', () => [])
    expect(result).toBe(false)
  })

  // New case 2: valid init-manifest.json present → fully initialized; init
  // command must short-circuit with { code: 0 } without re-running scaffold.
  it('returns true when init-manifest.json is present and lists scaffold paths', () => {
    const paths = ['CLAUDE.md', 'CONTEXT.md', '.claude/settings.json']
    const result = checkAlreadyInitialized('/complete/repo', () => paths)
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fd-headroom: probeFdHeadroom
// ---------------------------------------------------------------------------

describe('probeFdHeadroom', () => {
  it('returns null on an unsupported platform without throwing', () => {
    const deps: FdHeadroomDeps = {
      platform: 'win32',
      readSysctlNum: () => { throw new Error('should not be called') },
      readFileNr: () => { throw new Error('should not be called') },
    }
    expect(probeFdHeadroom(deps)).toBeNull()
  })

  it('returns a snapshot on macOS-like platforms via sysctl', () => {
    const deps: FdHeadroomDeps = {
      platform: 'darwin',
      readSysctlNum: (key) => key === 'kern.num_files' ? 256841 : 491520,
      readFileNr: () => { throw new Error('should not be called') },
    }
    const result = probeFdHeadroom(deps)
    expect(result).not.toBeNull()
    expect(result?.used).toBe(256841)
    expect(result?.limit).toBe(491520)
    expect(result?.pct).toBeCloseTo(256841 / 491520)
  })

  it('returns a snapshot on Linux via /proc/sys/fs/file-nr', () => {
    const deps: FdHeadroomDeps = {
      platform: 'linux',
      readSysctlNum: () => { throw new Error('should not be called') },
      readFileNr: () => '256841\t0\t491520\n',
    }
    const result = probeFdHeadroom(deps)
    expect(result).not.toBeNull()
    expect(result?.used).toBe(256841)
    expect(result?.limit).toBe(491520)
    expect(result?.pct).toBeCloseTo(256841 / 491520)
  })

  it('returns null when the sysctl call throws (non-fatal)', () => {
    const deps: FdHeadroomDeps = {
      platform: 'darwin',
      readSysctlNum: () => { throw new Error('sysctl unavailable') },
      readFileNr: () => { throw new Error('should not be called') },
    }
    expect(probeFdHeadroom(deps)).toBeNull()
  })

  it('returns null when file-nr is malformed (non-fatal)', () => {
    const deps: FdHeadroomDeps = {
      platform: 'linux',
      readSysctlNum: () => { throw new Error('should not be called') },
      readFileNr: () => 'not a number at all',
    }
    expect(probeFdHeadroom(deps)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// fd-headroom: enrichInitDbError
// ---------------------------------------------------------------------------

describe('enrichInitDbError', () => {
  const RAW_DB_ERROR = 'Query read timeout'

  it('names file descriptors when probe reports the incident-level usage (256841/491520)', () => {
    // 256841/491520 ≈ 52% — above the FD_EXHAUSTION_THRESHOLD (0.5)
    const result = enrichInitDbError(RAW_DB_ERROR, () => ({
      used: 256841,
      limit: 491520,
      pct: 256841 / 491520,
    }))

    // Must mention file descriptors
    expect(result).toMatch(/file descriptor/i)
    // Must NOT lead with the database error — fd context comes first
    expect(result).not.toMatch(new RegExp(`^${RAW_DB_ERROR}`))
    // Must include the raw error as detail, not discard it
    expect(result).toContain(RAW_DB_ERROR)
    // Must include the actual counts
    expect(result).toContain('256841')
    expect(result).toContain('491520')
  })

  it('returns today\'s message verbatim when probe reports healthy headroom', () => {
    // 10000/491520 ≈ 2% — well below the FD_EXHAUSTION_THRESHOLD
    const result = enrichInitDbError(RAW_DB_ERROR, () => ({
      used: 10000,
      limit: 491520,
      pct: 10000 / 491520,
    }))
    expect(result).toBe(RAW_DB_ERROR)
  })

  it('returns today\'s message verbatim and does not propagate when probe throws', () => {
    const result = enrichInitDbError(RAW_DB_ERROR, () => {
      throw new Error('ENFILE: file table overflow')
    })
    expect(result).toBe(RAW_DB_ERROR)
  })

  it('returns today\'s message verbatim when probe returns null (unsupported platform)', () => {
    const result = enrichInitDbError(RAW_DB_ERROR, () => null)
    expect(result).toBe(RAW_DB_ERROR)
  })

  it('includes the lsof command suggestion in the fd-exhaustion message', () => {
    const result = enrichInitDbError(RAW_DB_ERROR, () => ({
      used: 450000,
      limit: 491520,
      pct: 450000 / 491520,
    }))
    expect(result).toContain('lsof')
  })
})
