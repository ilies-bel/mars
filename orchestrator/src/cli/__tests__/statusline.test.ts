import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { buildStatusLine } from '../statusline.js'

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
})
