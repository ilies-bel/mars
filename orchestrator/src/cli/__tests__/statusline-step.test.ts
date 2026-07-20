/**
 * Tests for the step-aware lease segment in the statusline.
 *
 * Covers three branches:
 *   - parked-manual: task is leased at a manual step → `step <name> · manual`
 *   - running-auto:  task is at a step but not leased → `step <name> · auto`
 *   - no-step:       task has no currentStepName → falls back to today's rendering
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { buildLeaseSegment } from '../statusline.js'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
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

// ── Unit tests for buildLeaseSegment step branches ────────────────────────────

describe('buildLeaseSegment — step-aware rendering', () => {
  it('parked-manual: shows "step <name> · manual" when stepName and mode=manual', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', 'Step guide', 'code', 'manual')
    expect(seg).toContain('step code · manual')
  })

  it('parked-manual: still includes the task ID short form', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', null, 'code', 'manual')
    expect(seg).toContain('mars-abc12')
  })

  it('parked-manual: does not include the task intent or step guide text', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', 'Some guide text', 'code', 'manual')
    expect(seg).not.toContain('Overall intent')
    expect(seg).not.toContain('Some guide text')
  })

  it('running-auto: shows "step <name> · auto" when stepName and mode=auto', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', null, 'verify', 'auto')
    expect(seg).toContain('step verify · auto')
  })

  it('running-auto: defaults to auto when stepMode is null but stepName is set', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', null, 'merge', null)
    expect(seg).toContain('step merge · auto')
  })

  it('running-auto: defaults to auto when stepMode is undefined but stepName is set', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', null, 'setup', undefined)
    expect(seg).toContain('step setup · auto')
  })

  it('no-step: falls back to intent when stepName is null', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', null, null, null)
    expect(seg).toContain('Overall intent')
    expect(seg).not.toContain('step ')
  })

  it('no-step: falls back to step guide when stepName is null but guide is present', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', 'QA the hero section', null, null)
    expect(seg).toContain('QA the hero')
    expect(seg).not.toContain('step ')
  })

  it('no-step: falls back when stepName is empty string', () => {
    const seg = buildLeaseSegment('mars-abc12345', 'Overall intent', null, '', null)
    expect(seg).toContain('Overall intent')
    expect(seg).not.toContain('step ')
  })

  it('returns empty string when taskId is null regardless of step params', () => {
    expect(buildLeaseSegment(null, 'intent', null, 'code', 'manual')).toBe('')
  })

  it('ends with separator regardless of step mode', () => {
    const manual = buildLeaseSegment('mars-abc12345', null, null, 'code', 'manual')
    const auto = buildLeaseSegment('mars-abc12345', null, null, 'verify', 'auto')
    expect(manual).toMatch(/·\s*$/)
    expect(auto).toMatch(/·\s*$/)
  })

  it('shows pickaxe emoji in all active-step cases', () => {
    const manual = buildLeaseSegment('mars-abc12345', null, null, 'code', 'manual')
    const auto = buildLeaseSegment('mars-abc12345', null, null, 'verify', 'auto')
    expect(manual).toContain('⛏')
    expect(auto).toContain('⛏')
  })
})

// ── CLI integration: parked-manual (leased + current_step_name set) ───────────

describe('mars statusline CLI — step rendering', () => {
  const makeRepo = (): string => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-statusline-step-'))
    mkdirSync(resolve(dir, '.mars'))
    return dir
  }

  // The lease segment is read from the daemon's HTTP API (`/view/tasks`, port
  // published to `.mars/http.port`). Stand up a stub daemon serving the given
  // task rows and publish its port the way the real daemon does.
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

  it('parked-manual: renders "step <name> · manual" when task is leased at a named step', async () => {
    const tmpRepo = makeRepo()
    const taskId = 'mars-stepman1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    const server = await startStubDaemon(tmpRepo, [
      {
        id: taskId,
        intent: 'Implement feature X',
        leasedAt: '2024-01-01T10:00:00Z',
        leaseNote: 'Do the thing',
        currentStepName: 'code',
      },
    ])

    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: worktreeDir } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      const line = result.stdout.trimEnd()
      expect(line).toContain('⛏')
      expect(line).toContain('step code · manual')
    } finally {
      await stopStubDaemon(server)
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('running-auto: renders "step <name> · auto" when currentStepName is set but task is not leased', async () => {
    const tmpRepo = makeRepo()
    const taskId = 'mars-stepauto1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    // leasedAt is null → auto mode; currentStepName is 'verify'
    const server = await startStubDaemon(tmpRepo, [
      {
        id: taskId,
        intent: 'Implement feature Y',
        leasedAt: null,
        leaseNote: null,
        currentStepName: 'verify',
      },
    ])

    try {
      const result = runCli(['statusline'], {
        input: JSON.stringify({ workspace: { current_dir: worktreeDir } }),
        env: { MARS_REPO: tmpRepo },
      })
      expect(result.status).toBe(0)
      const line = result.stdout.trimEnd()
      expect(line).toContain('⛏')
      expect(line).toContain('step verify · auto')
    } finally {
      await stopStubDaemon(server)
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('no-step: falls back to today\'s rendering when currentStepName is null and task is not leased', async () => {
    const tmpRepo = makeRepo()
    const taskId = 'mars-stepnone1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    // Neither leased nor has a current step → no lease segment
    const server = await startStubDaemon(tmpRepo, [
      {
        id: taskId,
        intent: 'Queued task',
        leasedAt: null,
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
      // No lease segment — base "mars" rendering
      expect(line).toContain('mars')
      expect(line).not.toContain('⛏')
      expect(line).not.toContain('step ')
    } finally {
      await stopStubDaemon(server)
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })
})
