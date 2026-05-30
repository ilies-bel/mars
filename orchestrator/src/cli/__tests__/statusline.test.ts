import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { buildStatusLine, buildContextSegment } from '../statusline.js'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (
  args: readonly string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    input: opts.input ?? '',
    env: { ...process.env, ...opts.env },
  })

// ── Unit tests for the pure buildStatusLine function ──────────────────────────

describe('buildStatusLine', () => {
  it('returns "mars" with no branch and no cache', () => {
    expect(buildStatusLine(null, null)).toBe('mars')
  })

  it('includes branch when provided', () => {
    expect(buildStatusLine('main', null)).toBe('mars · main')
  })

  it('does NOT append nudge when cache is null', () => {
    const line = buildStatusLine('main', null)
    expect(line).not.toContain('available')
  })

  it('does NOT append nudge when available is false', () => {
    const line = buildStatusLine('main', { available: false, latest: '9.9.9' })
    expect(line).not.toContain('available')
  })

  it('does NOT append nudge when available is true but latest is absent', () => {
    const line = buildStatusLine('main', { available: true })
    expect(line).not.toContain('available')
  })

  it('appends nudge when available is true and latest is set', () => {
    const line = buildStatusLine('main', { available: true, latest: '9.9.9' })
    expect(line).toContain('⚡ v9.9.9 available')
  })

  it('nudge appears at the end of the line', () => {
    const line = buildStatusLine('main', { available: true, latest: '2.0.0' })
    expect(line).toBe('mars · main  ⚡ v2.0.0 available')
  })
})

// ── Unit tests for the pure buildContextSegment function ─────────────────────

describe('buildContextSegment', () => {
  it('returns empty string for null', () => {
    expect(buildContextSegment(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(buildContextSegment(undefined)).toBe('')
  })

  it('returns empty string for NaN', () => {
    expect(buildContextSegment(NaN)).toBe('')
  })

  it('high remaining (95) yields a green segment with bar and % left label', () => {
    const seg = buildContextSegment(95)
    // Should contain the green ANSI code
    expect(seg).toContain('\x1b[32m')
    // Should contain at least one bar character
    expect(seg.includes('█') || seg.includes('░')).toBe(true)
    // Should contain "% left"
    expect(seg).toContain('% left')
    // Should end with ANSI reset
    expect(seg).toContain('\x1b[0m')
    // Should start with a space
    expect(seg.startsWith(' ')).toBe(true)
  })

  it('low remaining (20) yields a red segment', () => {
    const seg = buildContextSegment(20)
    expect(seg).toContain('\x1b[31m')
    expect(seg).toContain('% left')
  })

  it('boundary: remaining 16.5 => used is 100 (fully into buffer, 0% left)', () => {
    const seg = buildContextSegment(16.5)
    // used = 100, remainingToCompact = 0
    expect(seg).toContain('0% left')
    // used >= 80 => red
    expect(seg).toContain('\x1b[31m')
    // All 10 segments filled
    expect(seg).toContain('██████████')
  })

  it('boundary: remaining 100 => used is 0 (100% left)', () => {
    const seg = buildContextSegment(100)
    // used = 0, remainingToCompact = 100
    expect(seg).toContain('100% left')
    // used < 50 => green
    expect(seg).toContain('\x1b[32m')
    // All 10 segments empty
    expect(seg).toContain('░░░░░░░░░░')
  })
})

// ── CLI integration tests ──────────────────────────────────────────────────────

describe('mars statusline CLI', () => {
  const makeRepo = (): string => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-statusline-test-'))
    mkdirSync(resolve(dir, '.mars'))
    return dir
  }

  it('exits 0 and prints a non-empty line with empty stdin', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: '',
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim().length).toBeGreaterThan(0)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('exits 0 with valid JSON stdin', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ model: { display_name: 'claude-sonnet' } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim().length).toBeGreaterThan(0)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('exits 0 with malformed JSON stdin and still prints a line', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: '{ not valid json !!!',
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim().length).toBeGreaterThan(0)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('does NOT include update nudge when update.json is absent', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: '',
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('available')
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('does NOT include update nudge when available is false', () => {
    const tmpRepo = makeRepo()
    try {
      writeFileSync(
        resolve(tmpRepo, '.mars', 'update.json'),
        JSON.stringify({
          installed: '1.0.0',
          latest: '9.9.9',
          available: false,
          checkedAt: new Date().toISOString(),
          releaseUrl: 'https://example.com',
        }),
      )
      const result = runCli(['statusline'], {
        input: '',
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('available')
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('includes update nudge when available is true', () => {
    const tmpRepo = makeRepo()
    try {
      writeFileSync(
        resolve(tmpRepo, '.mars', 'update.json'),
        JSON.stringify({
          installed: '1.0.0',
          latest: '9.9.9',
          available: true,
          checkedAt: new Date().toISOString(),
          releaseUrl: 'https://example.com',
        }),
      )
      const result = runCli(['statusline'], {
        input: '',
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('⚡ v9.9.9 available')
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('appends context bar when context_window.remaining_percentage is in stdin', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({
          workspace: { current_dir: '.' },
          context_window: { remaining_percentage: 42 },
        }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      // Output is a single line containing "mars"
      const line = result.stdout.trimEnd()
      expect(line).toContain('mars')
      // Context bar characters must appear
      expect(line.includes('█') || line.includes('░')).toBe(true)
      // Single line only (trimEnd removes the trailing newline; no internal newlines)
      expect(line.includes('\n')).toBe(false)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('does not append context bar when context_window is absent from stdin', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: '.' } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      // No bar characters in output
      const line = result.stdout.trimEnd()
      expect(line.includes('█') || line.includes('░')).toBe(false)
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })
})
