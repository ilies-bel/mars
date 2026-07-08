/**
 * Tests for the step-aware lease segment in the statusline.
 *
 * Covers three branches:
 *   - parked-manual: task is leased at a manual step → `step <name> · manual`
 *   - running-auto:  task is at a step but not leased → `step <name> · auto`
 *   - no-step:       task has no current_step_name → falls back to today's rendering
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
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

  it('parked-manual: renders "step <name> · manual" when task is leased at a named step', () => {
    const sqlite3Available = spawnSync('sqlite3', ['--version']).status === 0
    if (!sqlite3Available) return

    const tmpRepo = makeRepo()
    const taskId = 'mars-stepman1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    const marsDbPath = resolve(tmpRepo, '.mars', 'mars.db')
    spawnSync('sqlite3', [
      marsDbPath,
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, intent TEXT NOT NULL DEFAULT '', leased_at TEXT, lease_note TEXT, current_step_name TEXT);` +
      `INSERT INTO tasks VALUES ('${taskId}', 'Implement feature X', '2024-01-01T10:00:00Z', 'Do the thing', 'code');`,
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
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('running-auto: renders "step <name> · auto" when current_step_name is set but task is not leased', () => {
    const sqlite3Available = spawnSync('sqlite3', ['--version']).status === 0
    if (!sqlite3Available) return

    const tmpRepo = makeRepo()
    const taskId = 'mars-stepauto1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    const marsDbPath = resolve(tmpRepo, '.mars', 'mars.db')
    // leased_at is NULL → auto mode; current_step_name is 'verify'
    spawnSync('sqlite3', [
      marsDbPath,
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, intent TEXT NOT NULL DEFAULT '', leased_at TEXT, lease_note TEXT, current_step_name TEXT);` +
      `INSERT INTO tasks VALUES ('${taskId}', 'Implement feature Y', NULL, NULL, 'verify');`,
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
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('no-step: falls back to today\'s rendering when current_step_name is null and task is not leased', () => {
    const sqlite3Available = spawnSync('sqlite3', ['--version']).status === 0
    if (!sqlite3Available) return

    const tmpRepo = makeRepo()
    const taskId = 'mars-stepnone1'
    const worktreeDir = resolve(tmpRepo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })

    const marsDbPath = resolve(tmpRepo, '.mars', 'mars.db')
    // Neither leased nor has a current step → no lease segment
    spawnSync('sqlite3', [
      marsDbPath,
      `CREATE TABLE tasks (id TEXT PRIMARY KEY, intent TEXT NOT NULL DEFAULT '', leased_at TEXT, lease_note TEXT, current_step_name TEXT);` +
      `INSERT INTO tasks VALUES ('${taskId}', 'Queued task', NULL, NULL, NULL);`,
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
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })
})
