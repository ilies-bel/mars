import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { buildStatusLine, buildContextSegment, buildLeaseSegment } from '../statusline.js'

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

// ── Unit tests for the pure buildLeaseSegment function ───────────────────────

describe('buildLeaseSegment', () => {
  it('returns empty string when taskId is null', () => {
    expect(buildLeaseSegment(null, null)).toBe('')
  })

  it('returns empty string when taskId is null even if title is provided', () => {
    expect(buildLeaseSegment(null, 'some title')).toBe('')
  })

  it('contains the pickaxe emoji when taskId is provided', () => {
    const seg = buildLeaseSegment('mars-abc12345', null)
    expect(seg).toContain('⛏')
  })

  it('contains a short form of the task ID', () => {
    const seg = buildLeaseSegment('mars-abc12345', null)
    expect(seg).toContain('mars-abc12')
  })

  it('contains the title when provided', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Fix the statusline bug')
    expect(seg).toContain('Fix the statusline bug')
  })

  it('truncates titles longer than 30 chars and adds ellipsis', () => {
    const longTitle = 'This is a very long title that should definitely be truncated here'
    const seg = buildLeaseSegment('mars-abc12345', longTitle)
    expect(seg).not.toContain(longTitle)
    expect(seg).toContain('…')
  })

  it('does not truncate titles of exactly 30 chars', () => {
    const exactTitle = '123456789012345678901234567890' // 30 chars
    const seg = buildLeaseSegment('mars-abc12345', exactTitle)
    expect(seg).toContain(exactTitle)
    expect(seg).not.toContain('…')
  })

  it('ends with a separator so the rest of the status line follows cleanly', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Fix bug')
    expect(seg).toMatch(/·\s*$/)
  })

  it('works without a title (just shows the short ID)', () => {
    const seg = buildLeaseSegment('mars-abc12345', null)
    expect(seg).toContain('mars-abc12')
    // Should still have the separator
    expect(seg).toMatch(/·\s*$/)
  })

  it('shows the Step guide instead of the title when stepGuide is provided', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall task intent', 'QA the hero section')
    expect(seg).toContain('QA the hero section')
    expect(seg).not.toContain('Overall task intent')
  })

  it('falls back to title when stepGuide is null', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall task intent', null)
    expect(seg).toContain('Overall task intent')
  })

  it('falls back to title when stepGuide is empty string', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall task intent', '')
    expect(seg).toContain('Overall task intent')
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

  it('does NOT prepend lease segment when CWD is not inside a Mars worktree', () => {
    const tmpRepo = makeRepo()
    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: tmpRepo } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain('⛏')
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  // The lease segment is read from the daemon's HTTP API (`/view/tasks`,
  // port published to `.mars/http.port`). Stand up a stub daemon that serves
  // the given task rows and publish its port the way the real daemon does.
  const startStubDaemon = (repo: string, tasks: unknown[]): Promise<Server> =>
    new Promise((resolveStart) => {
      const server = createServer((req, res) => {
        if (req.url === '/view/tasks') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ tasks }))
          return
        }
        res.statusCode = 404
        res.end()
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        writeFileSync(resolve(repo, '.mars', 'http.port'), String(port))
        resolveStart(server)
      })
    })

  const stopStubDaemon = (server: Server): Promise<void> =>
    new Promise((resolveStop) => {
      server.close(() => resolveStop())
    })

  it('prepends lease segment when CWD is inside a leased Mars worktree', async () => {
    const tmpRepo = makeRepo()
    const taskId = 'mars-testlease1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    const server = await startStubDaemon(tmpRepo, [
      {
        id: taskId,
        intent: 'Fix the statusline lease',
        leasedAt: '2024-01-01T10:00:00Z',
        leaseNote: null,
        currentStepName: null,
      },
    ])

    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: worktreeDir } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      const line = result.stdout.trimEnd()
      // Lease segment must be prepended
      expect(line).toContain('⛏')
      expect(line).toContain('mars-testl') // short ID (first 12 chars)
      // Base "mars" label must still appear
      expect(line).toContain('mars')
    } finally {
      await stopStubDaemon(server)
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('shows Step guide (leaseNote) instead of intent when leaseNote is set', async () => {
    const tmpRepo = makeRepo()
    const taskId = 'mars-steple1234'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    const server = await startStubDaemon(tmpRepo, [
      {
        id: taskId,
        intent: 'Overall task intent',
        leasedAt: '2024-01-01T10:00:00Z',
        leaseNote: 'QA the hero section',
        currentStepName: null,
      },
    ])

    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: worktreeDir } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      const line = result.stdout.trimEnd()
      // Step guide takes precedence over intent in the lease segment
      expect(line).toContain('⛏')
      expect(line).toContain('QA the hero')
      // Intent should NOT appear — leaseNote replaces it
      expect(line).not.toContain('Overall task intent')
    } finally {
      await stopStubDaemon(server)
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('exits 0 and emits "mars" when the daemon is not running (no http.port)', () => {
    const tmpRepo = makeRepo()
    const taskId = 'mars-nodb1234'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })
    // No http.port published — lease detection should fail gracefully

    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: worktreeDir } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toContain('mars')
      expect(result.stdout).not.toContain('⛏')
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })
})
