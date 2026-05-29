/**
 * Integration tests for `mars cut verify <phase>`.
 *
 * Each describe block seeds a specific DB state, runs the CLI command,
 * and asserts the exit code and human-readable output. Tests use a
 * fresh git-init'd temp directory for each describe block so there is no
 * cross-contamination.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createClient } from '@libsql/client'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (
  args: readonly string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20_000,
  })

/** Create a throwaway git repo with a .mars dir. */
const makeRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-cut-verify-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Open a libsql client against <repo>/.mars/mars.db. */
const openDb = (repo: string) =>
  createClient({ url: `file:${resolve(repo, '.mars', 'mars.db')}` })

/** Minimal tasks table init (subset of initQueue). */
const initTables = async (repo: string): Promise<void> => {
  const c = openDb(repo)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      problem TEXT NOT NULL DEFAULT '',
      solution TEXT NOT NULL DEFAULT '',
      out_of_scope TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      author TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_blockers (
      task_id TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, blocker_task_id)
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_signals (
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, step_id)
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_proposal_blockers (
      task_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, proposal_id)
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_acceptance (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_transcripts (
      task_id TEXT PRIMARY KEY,
      conversation_json TEXT NOT NULL,
      verify_output TEXT,
      bytes INTEGER NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS self_heal_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_task_id TEXT NOT NULL,
      failure_signature TEXT NOT NULL,
      fix_task_id TEXT,
      created_at TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS kpi_snapshots (
      id TEXT PRIMARY KEY,
      taken_at TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS inbox_history (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      at TEXT NOT NULL,
      action TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposal_user_stories (
      proposal_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (proposal_id, position)
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposal_dependencies (
      proposal_id TEXT NOT NULL,
      blocker_proposal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (proposal_id, blocker_proposal_id)
    )
  `)
  c.close()
}

// ---------------------------------------------------------------------------
// mars cut verify -- no phase
// ---------------------------------------------------------------------------

describe('mars cut verify — missing phase argument', () => {
  let repo: string
  beforeAll(() => {
    repo = makeRepo()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero with usage hint when phase is omitted', () => {
    const r = runCli(['cut', 'verify'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/usage|drain|reset|recreate/i)
  })
})

describe('mars cut verify — unknown phase', () => {
  let repo: string
  beforeAll(() => {
    repo = makeRepo()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero with usage hint for an unknown phase', () => {
    const r = runCli(['cut', 'verify', 'bogus'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/usage|drain|reset|recreate/i)
  })
})

// ---------------------------------------------------------------------------
// mars cut verify drain — happy path
// ---------------------------------------------------------------------------

describe('mars cut verify drain — empty DB', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 when no tasks exist', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.status).toBe(0)
  })

  it('prints a ✓ message on success', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.stdout).toContain('✓')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify drain — in-flight tasks present
// ---------------------------------------------------------------------------

describe('mars cut verify drain — queued task', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-aabbccdd', 'Some pending work', 'queued'],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a queued task exists', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('prints the in-flight task id to stderr', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.stderr).toContain('mars-aabbccdd')
  })

  it('stderr mentions the status', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.stderr).toContain('queued')
  })
})

describe('mars cut verify drain — blocked task', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-11223344', 'Blocked work', 'blocked'],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a blocked task exists', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('lists the blocked task in stderr', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.stderr).toContain('mars-11223344')
  })
})

describe('mars cut verify drain — running task', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-99887766', 'Active work', 'running'],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a running task exists', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })
})

describe('mars cut verify drain — only done/failed tasks', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-aaa00001', 'Finished work', 'done'],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-aaa00002', 'Failed work', 'failed'],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 when only done/failed tasks exist', () => {
    const r = runCli(['cut', 'verify', 'drain'], { MARS_REPO: repo })
    expect(r.status).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// mars cut verify reset — happy path (all tables empty)
// ---------------------------------------------------------------------------

describe('mars cut verify reset — empty DB', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 when all tables are empty', () => {
    const r = runCli(['cut', 'verify', 'reset'], { MARS_REPO: repo })
    expect(r.status).toBe(0)
  })

  it('prints a ✓ message on success', () => {
    const r = runCli(['cut', 'verify', 'reset'], { MARS_REPO: repo })
    expect(r.stdout).toContain('✓')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify reset — tables have rows
// ---------------------------------------------------------------------------

describe('mars cut verify reset — tasks table non-empty', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-deadbeef', 'Leftover task', 'done'],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when the tasks table has rows', () => {
    const r = runCli(['cut', 'verify', 'reset'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('names the non-empty table in stderr', () => {
    const r = runCli(['cut', 'verify', 'reset'], { MARS_REPO: repo })
    expect(r.stderr).toContain('tasks')
  })
})

describe('mars cut verify reset — proposals table non-empty', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    await c.execute({
      sql: `INSERT INTO proposals (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ['prop-12345678', 'Old proposal', 0, 0],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when the proposals table has rows', () => {
    const r = runCli(['cut', 'verify', 'reset'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('names proposals in the stderr output', () => {
    const r = runCli(['cut', 'verify', 'reset'], { MARS_REPO: repo })
    expect(r.stderr).toContain('proposals')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify recreate — happy path (no forbidden ids)
// ---------------------------------------------------------------------------

describe('mars cut verify recreate — no forbidden ids', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 when there are no forbidden ids', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.status).toBe(0)
  })

  it('prints the carry-forward checklist to stdout', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stdout).toContain('Carry-forward proposals:')
  })

  it('prints ✗ for proposals not yet re-entered', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stdout).toContain('[✗]')
  })

  it('prints a ✓ success line at the end', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stdout).toContain('✓')
    expect(r.stdout).toContain('no forbidden ids')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify recreate — forbidden ids present
// ---------------------------------------------------------------------------

describe('mars cut verify recreate — forbidden id 04830c8e in tasks', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    // Seed a task whose id ends with the forbidden hex 04830c8e.
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status) VALUES (?, ?, ?)`,
      args: ['mars-04830c8e', 'Superseded centralise-id-generation PRD task', 'failed'],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a task id contains the forbidden suffix 04830c8e', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('reports the forbidden id in stderr', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stderr).toContain('04830c8e')
  })
})

describe('mars cut verify recreate — forbidden id 07201a16 in proposals', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    // Seed a proposal whose id ends with the forbidden hex 07201a16.
    await c.execute({
      sql: `INSERT INTO proposals (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: [
        '07201a16-fix-pre-existing-tests',
        'Fix pre-existing failing tests',
        0,
        0,
      ],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a proposal id contains the forbidden suffix 07201a16', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('names the forbidden proposal in stderr', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stderr).toContain('07201a16')
  })
})

describe('mars cut verify recreate — forbidden id 26471262 in proposals', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    // Seed a proposal whose id ends with the forbidden hex 26471262.
    await c.execute({
      sql: `INSERT INTO proposals (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ['26471262-typescript-errors', 'Pre-existing TypeScript errors', 0, 0],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a proposal id contains the forbidden suffix 26471262', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.status).not.toBe(0)
  })

  it('names the forbidden proposal in stderr', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stderr).toContain('26471262')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify recreate — carry-forward proposals re-entered
// ---------------------------------------------------------------------------

describe('mars cut verify recreate — one carry-forward proposal re-entered', () => {
  let repo: string
  beforeAll(async () => {
    repo = makeRepo()
    await initTables(repo)
    const c = openDb(repo)
    // Seed the KPI drift proposal (5f10ed5f) as re-entered.
    await c.execute({
      sql: `INSERT INTO proposals (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: [
        '5f10ed5f-kpi-drift-self-evolve',
        'Opt-in self-evolve trigger: KPI drift raises a draft proposal, off by default',
        0,
        0,
      ],
    })
    c.close()
  })
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 (no forbidden ids)', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.status).toBe(0)
  })

  it('marks the re-entered proposal with ✓ in the checklist', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    expect(r.stdout).toContain('[✓]')
  })

  it('still marks the other six proposals as ✗', () => {
    const r = runCli(['cut', 'verify', 'recreate'], { MARS_REPO: repo })
    // Six proposals not yet re-entered — expect at least one ✗
    expect(r.stdout).toContain('[✗]')
  })
})

// ---------------------------------------------------------------------------
// mars --help includes cut verify
// ---------------------------------------------------------------------------

describe('mars --help — cut verb', () => {
  it('lists the cut verb in top-level help', () => {
    const r = runCli(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/cut/i)
  })
})
