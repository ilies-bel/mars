import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommandInProcess, makeFakeDaemon, type InProcessOptions } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (args: readonly string[], env?: Record<string, string>): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

describe('mars --help — continue verb', () => {
  it('lists continue alongside restart in top-level help', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^\s*continue\s+<id>/m)
  })

  it('continue description contrasts with restart (mentions restart as the alternative)', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    // The continue entry should reference restart as the alternative for full re-run
    expect(result.stdout).toMatch(/continue[\s\S]*?restart/m)
  })

  it('restart is still present alongside continue', () => {
    const result = runCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^\s*restart\s+<id>/m)
  })
})

describe('mars continue --help', () => {
  it('prints command-specific usage and exits 0', () => {
    const result = runCli(['continue', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('mars continue')
  })

  it('mentions that there are no flags in v1', () => {
    const result = runCli(['continue', '--help'])
    expect(result.status).toBe(0)
    // The help must note that v1 has no flags
    expect(result.stdout).toMatch(/no flags?|v1|flags? in v1/i)
  })

  it('contrasts with restart as the full re-run alternative', () => {
    const result = runCli(['continue', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('restart')
  })

  it('explains which failures resume work and which ones restart instead', () => {
    const result = runCli(['continue', '--help'])

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/code-phase failure[\s\S]*salvage checkpoint/i)
    expect(result.stdout).toMatch(/Degraded-to-restart[\s\S]*degradedToRestart: true/i)
    expect(result.stdout).toMatch(/Refuses \(non-zero exit\)[\s\S]*in-flight recovery/i)
    expect(result.stdout).not.toMatch(/failed in the 'code' phase.*no verifiable artefact/i)
  })
})

describe('mars continue — no task id', () => {
  it('exits non-zero when no task id is provided', () => {
    const result = runCli(['continue'])
    expect(result.status).not.toBe(0)
  })

  it('prints a usage message to stderr when no task id is provided', () => {
    const result = runCli(['continue'])
    expect(result.stderr).toContain('usage')
    expect(result.stderr).toContain('continue')
  })
})

// ---------------------------------------------------------------------------
// Exit-within-timeout regression: asserts the process exits rather than hangs.
// If the CLI hangs (e.g. emitCliInvocationTrace blocking on a stalled pg.Pool
// connection), spawnSync returns status=null after the timeout and the
// `not.toBeNull()` assertion fails — which is the correct signal.
// Root fix: connectionTimeoutMillis: 5_000 in makeEmbeddedBackend (db.ts).
// Sibling verbs (restart, drop, purge, block, unblock) share the same
// emitCliInvocationTrace path and are fixed by the same change.
// ---------------------------------------------------------------------------

describe('mars continue — exits promptly (no-hang regression)', () => {
  it('exits within the timeout when the daemon socket is absent', () => {
    // Run with a temp repo that has no watch.sock. The CLI should fail fast
    // (ENOENT on the socket) and exit non-zero — never hang.
    // `repo` is set up by the module-level beforeEach.
    const result = runCli(['continue', 'mars-abc'], { MARS_REPO: repo })
    // status is null only when spawnSync's timeout fired — the process hung.
    expect(result.status).not.toBeNull()
    // Non-zero: daemon unavailable → sendRequest throws → CLI exits 1.
    expect(result.status).not.toBe(0)
  })

  it('exits within the timeout even when emitCliInvocationTrace faces a stalled DB', async () => {
    // Root-cause regression test: before connectionTimeoutMillis: 5_000 was added
    // to makeEmbeddedBackend (db.ts), pool.connect() waited indefinitely when
    // PostgreSQL was at max connections. This is exactly what the fake server below
    // simulates — it accepts the TCP connection but never sends the Postgres auth
    // response. Without the fix, the CLI hangs past spawnSync's 15 s timeout and
    // spawnSync returns { status: null }, failing the assertion.
    //
    // The test only exercises emitCliInvocationTrace (the daemon is absent, so
    // sendRequest fails fast). The stalled server is reachable because both the
    // test process (server) and the CLI child process run on the same host.
    const server = createServer((conn) => { conn.on('error', () => {}) })
    await new Promise<void>((onListen) => server.listen(0, '127.0.0.1', onListen))
    const { port } = server.address() as AddressInfo

    // Write a fake pg.dsn pointing to the stalled server so emitCliInvocationTrace
    // actually tries to connect instead of returning early for a missing pg.dsn.
    writeFileSync(resolve(repo, '.mars', 'pg.dsn'), `postgresql://127.0.0.1:${port}/mars`)

    const result = runCli(['continue', 'mars-abc'], { MARS_REPO: repo })
    server.close()

    // status is null only when spawnSync's timeout fired — the process hung.
    expect(result.status).not.toBeNull()
    // Non-zero: daemon unavailable → sendRequest throws → CLI exits 1.
    // emitCliInvocationTrace's timeout is swallowed by .catch(() => {}).
    expect(result.status).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// In-process tests (runCommandInProcess + makeFakeDaemon).
// These test the command's output shape and multi-id dispatch without
// spawning a real process or touching the Unix socket.
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-continue-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const baseOpts = async (
  responder?: (req: { op: string; id?: string }) => unknown,
): Promise<InProcessOptions> => {
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: makeFakeDaemon(responder as Parameters<typeof makeFakeDaemon>[0]) }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('mars continue — stdout names task, phase, and degradedToRestart', () => {
  it('names the task id and reports it was continued from the code phase', async () => {
    const opts = await baseOpts(() => ({ degradedToRestart: false, coderResume: true }))
    const r = await runCommandInProcess(['continue', 'mars-code1'], opts)
    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    // task id
    expect(out).toContain('mars-code1')
    // resumed phase: code
    expect(out).toContain('continue from code')
    // not degraded
    expect(out).not.toContain('restart from setup')
  })

  it('names the task id and phase when continuing from the generic failed phase', async () => {
    const opts = await baseOpts(() => ({ degradedToRestart: false }))
    const r = await runCommandInProcess(['continue', 'mars-verify1'], opts)
    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('mars-verify1')
    expect(out).toContain('continue from the failed phase')
  })

  it('reports degradedToRestart and includes the task id', async () => {
    const opts = await baseOpts(() => ({
      degradedToRestart: true,
      note: 'worktree not found on disk',
    }))
    const r = await runCommandInProcess(['continue', 'mars-deg1'], opts)
    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('mars-deg1')
    // CLI surfaces the degraded path
    expect(out).toContain('restart from setup')
    // and the note
    expect(out).toContain('worktree not found on disk')
  })
})

describe('mars continue — multi-id form (two ids end-to-end)', () => {
  it('sends one daemon request per id and emits a per-task result line for each', async () => {
    const ids = ['mars-m1', 'mars-m2']
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'continue') return { degradedToRestart: false, coderResume: true }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['continue', ...ids], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    // Exactly one continue call per id
    const continueCalls = fake.calls.filter((c) => c.op === 'continue')
    expect(continueCalls).toHaveLength(2)
    expect(continueCalls.map((c) => (c as { id: string }).id)).toEqual(ids)
    // Per-task output line for each
    const out = r.out.join('\n')
    expect(out).toContain('mars-m1')
    expect(out).toContain('mars-m2')
  })

  it('stops at the first failure and exits non-zero when a daemon call throws', async () => {
    const ids = ['mars-ok', 'mars-bad']
    const fake = makeFakeDaemon((req) => {
      if ((req as { id: string }).id === 'mars-bad') throw new Error('task not failed')
      return { degradedToRestart: false }
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['continue', ...ids], { store, ctx, daemon: fake })

    expect(r.code).not.toBe(0)
    // First id output appeared
    expect(r.out.join('\n')).toContain('mars-ok')
    // Error surfaces the failing id
    expect(r.err.join('\n')).toContain('mars-bad')
  })
})
