/**
 * Tests for `mars cut verify <phase>`.
 *
 * DB-state phases run IN-PROCESS against the PGlite backend: the old
 * spawn-the-CLI pattern relied on seeding a shared `.mars/mars.db` file that
 * a subprocess could reopen, which has no equivalent under the in-memory
 * test backend (each process gets its own PGlite instance). Each describe
 * block seeds a fresh repo-keyed database via the seam, invokes
 * `runCutVerify`, and asserts on captured stdout/stderr lines and the
 * process.exit code (stubbed to throw).
 *
 * The DB-free argument-validation and --help cases still exercise the real
 * CLI binary via a subprocess.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type DbClient } from '../core/lib/db'
import { ensureSchema } from '../core/lib/pg-schema'
import { runCutVerify } from './cut-verify'

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

/**
 * Open the repo-keyed PGlite client (`resolveDbTarget` under
 * MARS_DB_BACKEND=pglite is the resolved `.mars` state dir) and apply the
 * canonical schema. The returned handle MUST stay open for the duration of
 * the tests — `close()` is reference-counted and tearing the last reference
 * down discards the in-memory instance along with the seeded rows.
 */
const openSeededDb = async (repo: string): Promise<DbClient> => {
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

const NOW_ISO = new Date().toISOString()

const insertTask = (c: DbClient, id: string, prompt: string, status: string) =>
  c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, prompt, status, NOW_ISO, NOW_ISO],
  })

const insertProposal = (c: DbClient, id: string, title: string) =>
  c.execute({
    sql: `INSERT INTO proposals (id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?)`,
    args: [id, title, 0, 0],
  })

// ── in-process harness: captured console output + throwing process.exit ─────

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

let stdoutLines: string[] = []
let stderrLines: string[] = []

beforeEach(() => {
  stdoutLines = []
  stderrLines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(' '))
  })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0)
  }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Run the gate check; returns the exit code (0 = returned normally). */
const runPhaseForExitCode = async (
  phase: 'drain' | 'reset' | 'recreate',
  repo: string,
): Promise<number> => {
  try {
    await runCutVerify(phase, repo)
    return 0
  } catch (err: unknown) {
    if (err instanceof ExitError) return err.code
    throw err
  }
}

// ---------------------------------------------------------------------------
// mars cut verify -- no phase (subprocess: DB-free argument validation)
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
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 and prints a ✓ message when no tasks exist', async () => {
    expect(await runPhaseForExitCode('drain', repo)).toBe(0)
    expect(stdoutLines.join('\n')).toContain('✓')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify drain — in-flight tasks present
// ---------------------------------------------------------------------------

describe('mars cut verify drain — queued task', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertTask(db, 'mars-aabbccdd', 'Some pending work', 'queued')
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and prints the in-flight task id + status to stderr', async () => {
    expect(await runPhaseForExitCode('drain', repo)).not.toBe(0)
    const err = stderrLines.join('\n')
    expect(err).toContain('mars-aabbccdd')
    expect(err).toContain('queued')
  })
})

describe('mars cut verify drain — blocked task', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertTask(db, 'mars-11223344', 'Blocked work', 'blocked')
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and lists the blocked task in stderr', async () => {
    expect(await runPhaseForExitCode('drain', repo)).not.toBe(0)
    expect(stderrLines.join('\n')).toContain('mars-11223344')
  })
})

describe('mars cut verify drain — running task', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertTask(db, 'mars-99887766', 'Active work', 'running')
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero when a running task exists', async () => {
    expect(await runPhaseForExitCode('drain', repo)).not.toBe(0)
  })
})

describe('mars cut verify drain — only done/failed tasks', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertTask(db, 'mars-aaa00001', 'Finished work', 'done')
    await insertTask(db, 'mars-aaa00002', 'Failed work', 'failed')
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 when only done/failed tasks exist', async () => {
    expect(await runPhaseForExitCode('drain', repo)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// mars cut verify reset — happy path (all tables empty)
// ---------------------------------------------------------------------------

describe('mars cut verify reset — empty DB', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 and prints a ✓ message when all tables are empty', async () => {
    expect(await runPhaseForExitCode('reset', repo)).toBe(0)
    expect(stdoutLines.join('\n')).toContain('✓')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify reset — tables have rows
// ---------------------------------------------------------------------------

describe('mars cut verify reset — tasks table non-empty', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertTask(db, 'mars-deadbeef', 'Leftover task', 'done')
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and names the non-empty table in stderr', async () => {
    expect(await runPhaseForExitCode('reset', repo)).not.toBe(0)
    expect(stderrLines.join('\n')).toContain('tasks')
  })
})

describe('mars cut verify reset — proposals table non-empty', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertProposal(db, 'prop-12345678', 'Old proposal')
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and names proposals in the stderr output', async () => {
    expect(await runPhaseForExitCode('reset', repo)).not.toBe(0)
    expect(stderrLines.join('\n')).toContain('proposals')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify recreate — happy path (no forbidden ids)
// ---------------------------------------------------------------------------

describe('mars cut verify recreate — no forbidden ids', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0, prints the carry-forward checklist and a ✓ success line', async () => {
    expect(await runPhaseForExitCode('recreate', repo)).toBe(0)
    const out = stdoutLines.join('\n')
    expect(out).toContain('Carry-forward proposals:')
    expect(out).toContain('[✗]')
    expect(out).toContain('✓')
    expect(out).toContain('no forbidden ids')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify recreate — forbidden ids present
// ---------------------------------------------------------------------------

describe('mars cut verify recreate — forbidden id 04830c8e in tasks', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    // Seed a task whose id ends with the forbidden hex 04830c8e.
    await insertTask(
      db,
      'mars-04830c8e',
      'Superseded centralise-id-generation PRD task',
      'failed',
    )
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and reports the forbidden id in stderr', async () => {
    expect(await runPhaseForExitCode('recreate', repo)).not.toBe(0)
    expect(stderrLines.join('\n')).toContain('04830c8e')
  })
})

describe('mars cut verify recreate — forbidden id 07201a16 in proposals', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertProposal(
      db,
      '07201a16-fix-pre-existing-tests',
      'Fix pre-existing failing tests',
    )
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and names the forbidden proposal in stderr', async () => {
    expect(await runPhaseForExitCode('recreate', repo)).not.toBe(0)
    expect(stderrLines.join('\n')).toContain('07201a16')
  })
})

describe('mars cut verify recreate — forbidden id 26471262 in proposals', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    await insertProposal(
      db,
      '26471262-typescript-errors',
      'Pre-existing TypeScript errors',
    )
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits non-zero and names the forbidden proposal in stderr', async () => {
    expect(await runPhaseForExitCode('recreate', repo)).not.toBe(0)
    expect(stderrLines.join('\n')).toContain('26471262')
  })
})

// ---------------------------------------------------------------------------
// mars cut verify recreate — carry-forward proposals re-entered
// ---------------------------------------------------------------------------

describe('mars cut verify recreate — one carry-forward proposal re-entered', () => {
  let repo: string
  let db: DbClient
  beforeAll(async () => {
    repo = makeRepo()
    db = await openSeededDb(repo)
    // Seed the KPI drift proposal (5f10ed5f) as re-entered.
    await insertProposal(
      db,
      '5f10ed5f-kpi-drift-self-evolve',
      'Opt-in self-evolve trigger: KPI drift raises a draft proposal, off by default',
    )
  })
  afterAll(async () => {
    await db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('exits 0 and marks the re-entered proposal with ✓ (others ✗)', async () => {
    expect(await runPhaseForExitCode('recreate', repo)).toBe(0)
    const out = stdoutLines.join('\n')
    expect(out).toContain('[✓]')
    // Six proposals not yet re-entered — expect at least one ✗
    expect(out).toContain('[✗]')
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
