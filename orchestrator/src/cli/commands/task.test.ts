/**
 * Tests for the `--intent` flag on `mars task add` (slice mars-855b3e1a).
 *
 * Covers two paths:
 *   1. Explicit `--intent <text>` — forwarded verbatim (trimmed, capped at 200).
 *   2. No `--intent` — first sentence of the prompt is derived by the CLI and
 *      forwarded to the daemon (no LLM involvement).
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon so
 * the test asserts on the value the CLI sends to the daemon, not on DB state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePromptSource, hasUnbalancedQuotes, parseTaskSpec } from '../args'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Helpers shared with command-seam tests
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/commands -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (args: readonly string[], env?: Record<string, string>): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-task-intent-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{ store: DomainTaskStore; ctx: OrchestratorContext }> => {
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
  daemonResponder?: Parameters<typeof makeFakeDaemon>[0],
): Promise<InProcessOptions> => {
  const fake = makeFakeDaemon(daemonResponder)
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: fake }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// --help surface
// ---------------------------------------------------------------------------

describe('mars task add --help', () => {
  it('lists the --intent flag', () => {
    const r = runCli(['task', 'add', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--intent')
  })
})

// ---------------------------------------------------------------------------
// Explicit --intent flag
// ---------------------------------------------------------------------------

describe('task add --intent (explicit)', () => {
  it('forwards the supplied intent to the daemon verbatim', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-abcd', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', '--intent', 'rename foo to bar', 'long prompt body that is irrelevant to intent'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    const req = fake.calls[0]
    expect(req).toMatchObject({ op: 'add', intent: 'rename foo to bar' })
  })

  it('trims leading/trailing whitespace from an explicit --intent', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-abcd', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(
      ['task', 'add', '--intent', '  trimmed  ', 'some prompt'],
      { store, ctx, daemon: fake },
    )
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe('trimmed')
  })
})

// ---------------------------------------------------------------------------
// Default derivation — first sentence of prompt
// ---------------------------------------------------------------------------

describe('task add intent derivation (no --intent flag)', () => {
  it('derives intent from the first sentence (dot terminator)', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-1234', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'Fix the slicer. Then verify it.'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe('Fix the slicer.')
  })

  it('derives intent from the first sentence (exclamation terminator)', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-5678', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(
      ['task', 'add', 'Do the thing! Then clean up.'],
      { store, ctx, daemon: fake },
    )
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe('Do the thing!')
  })

  it('falls back to the full prompt when no sentence boundary is found', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-9999', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(
      ['task', 'add', 'No terminator here so take the whole thing'],
      { store, ctx, daemon: fake },
    )
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe(
      'No terminator here so take the whole thing',
    )
  })
})

// ---------------------------------------------------------------------------
// Prompt input channels: @file / --prompt-file / stdin / conflicts
// ---------------------------------------------------------------------------

describe('task add prompt input channels', () => {
  // (a) positional @file reads file contents into prompt
  it('@file reads file contents verbatim into prompt', async () => {
    const filePath = join(repo, 'prompt.txt')
    writeFileSync(filePath, 'prompt from file\n')
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-file', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { prompt?: string }).prompt).toBe('prompt from file')
  })

  // (b) missing @file exits non-zero and enqueues nothing
  it('missing @file exits non-zero and enqueues nothing', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-x', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', '@/nonexistent/mars-test-path.txt'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(2)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join('\n')).toContain('/nonexistent/mars-test-path.txt')
  })

  // (c) --prompt-file reads file contents
  it('--prompt-file reads file contents verbatim into prompt', async () => {
    const filePath = join(repo, 'prompt-flag.txt')
    writeFileSync(filePath, 'from prompt-file flag\n')
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-pf', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', '--prompt-file', filePath],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { prompt?: string }).prompt).toBe('from prompt-file flag')
  })

  // (d) stdin - reads from the provided reader (injectable, avoids blocking on real fd 0)
  it('stdin - reads from the injected reader and trims trailing newline', () => {
    const result = resolvePromptSource(['-'], {}, () => 'stdin content\n')
    expect(result).toEqual({ ok: true, value: 'stdin content' })
  })

  it('stdin - preserves internal whitespace and only strips one trailing newline', () => {
    const result = resolvePromptSource(['-'], {}, () => 'line one\nline two\n')
    expect(result).toEqual({ ok: true, value: 'line one\nline two' })
  })

  // (e) supplying two channels at once is a hard error
  it('@file and --prompt-file together is a hard error', async () => {
    const filePath = join(repo, 'prompt.txt')
    writeFileSync(filePath, 'content\n')
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-x', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', `@${filePath}`, '--prompt-file', filePath],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(2)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join('\n')).toContain('multiple prompt sources')
  })

  it('--prompt-file and a literal positional together is a hard error', async () => {
    const filePath = join(repo, 'prompt.txt')
    writeFileSync(filePath, 'content\n')
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-x', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'literal prompt', '--prompt-file', filePath],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(2)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join('\n')).toContain('multiple prompt sources')
  })

  // (f) ${FOO} and backtick content round-trips byte-for-byte through @file
  it('${FOO} and backtick content round-trips through @file without shell expansion', async () => {
    const shellSpecial = 'Fix the ${FOO} and `backtick` and $(cmd) parsing'
    const filePath = join(repo, 'special.txt')
    writeFileSync(filePath, shellSpecial + '\n')
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-sp', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { prompt?: string }).prompt).toBe(shellSpecial)
  })

  // (g) inline literal positional still works unchanged
  it('inline literal positional still works unchanged', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-lit', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'inline literal prompt here'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { prompt?: string }).prompt).toBe('inline literal prompt here')
  })
})

// ---------------------------------------------------------------------------
// Guard 1 — resolvePromptSource rejects inline literal containing newline
// ---------------------------------------------------------------------------

describe('resolvePromptSource — inline newline guard', () => {
  it('rejects an inline literal containing a newline, mentioning @file/--prompt-file/stdin', () => {
    const result = resolvePromptSource(['line one\nline two'], {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('@')
      expect(result.message).toContain('--prompt-file')
    }
  })

  it('accepts a single-line inline literal', () => {
    const result = resolvePromptSource(['single line prompt'], {})
    expect(result).toEqual({ ok: true, value: 'single line prompt' })
  })

  it('stdin - multi-line content is still accepted (not blocked by inline guard)', () => {
    const result = resolvePromptSource(['-'], {}, () => 'line one\nline two\n')
    expect(result).toEqual({ ok: true, value: 'line one\nline two' })
  })
})

// ---------------------------------------------------------------------------
// Guard 2a — hasUnbalancedQuotes helper
// ---------------------------------------------------------------------------

describe('hasUnbalancedQuotes', () => {
  it('"cd ui → true (unbalanced leading double quote)', () => {
    expect(hasUnbalancedQuotes('"cd ui')).toBe(true)
  })

  it('cd ui && npx tsc → false (no quotes at all)', () => {
    expect(hasUnbalancedQuotes('cd ui && npx tsc')).toBe(false)
  })

  it("echo 'hi' → false (balanced single quotes)", () => {
    expect(hasUnbalancedQuotes("echo 'hi'")).toBe(false)
  })

  it("it's → true (documents why --done is excluded: apostrophe = unbalanced single quote)", () => {
    expect(hasUnbalancedQuotes("it's")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Guard 2b — parseTaskSpec rejects --verify/--preview with unbalanced quotes
// ---------------------------------------------------------------------------

describe('parseTaskSpec — unbalanced quote guard', () => {
  it('rejects --verify with an unbalanced double quote', () => {
    const result = parseTaskSpec({ flags: { '--verify': '"cd ui' }, multiFlags: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('--verify')
    }
  })

  it('accepts --verify with a balanced command (no quotes)', () => {
    const result = parseTaskSpec({ flags: { '--verify': 'cd ui && npx tsc --noEmit' }, multiFlags: {} })
    expect(result.ok).toBe(true)
  })

  it('does not reject --done containing an apostrophe', () => {
    const result = parseTaskSpec({ flags: {}, multiFlags: { '--done': ["don't break things"] } })
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// --files greedy multi-path (foot-gun fix, mars-3891672f)
// ---------------------------------------------------------------------------

describe('task add --files greedy multi-path', () => {
  it('--prompt-file + --files a b c does not error with "multiple prompt sources"', async () => {
    const filePath = join(repo, 'prompt.txt')
    writeFileSync(filePath, 'task prompt text\n')
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-gp', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', '--prompt-file', filePath, '--files', 'a', 'b', 'c'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(r.err.join('\n')).not.toContain('multiple prompt sources')
    // all three file paths are captured in the spec
    const req = fake.calls[0] as { spec?: { files?: string[] } }
    expect(req?.spec?.files).toEqual(['a', 'b', 'c'])
  })

  it('--files a b c with inline prompt captures all files and does not bleed into positional', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-gp2', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'the actual prompt', '--files', 'x', 'y', 'z'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    const req = fake.calls[0] as { prompt?: string; spec?: { files?: string[] } }
    expect(req?.prompt).toBe('the actual prompt')
    expect(req?.spec?.files).toEqual(['x', 'y', 'z'])
  })
})

// ---------------------------------------------------------------------------
// Output verb matches landing status
// ---------------------------------------------------------------------------

describe('task add output verb matches landing status', () => {
  it('prints "queued" when daemon returns status=queued', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-q', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'some prompt'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(r.out[0]).toMatch(/^queued mars-task-q/)
  })

  it('prints "blocked" when daemon returns status=blocked (--blocked-by with unfinished blocker)', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-blk', status: 'blocked' }))
    const { store, ctx } = await loadStoreAndCtx()
    // NOTE: prompt must come BEFORE --blocked-by because greedy parsing
    // consumes all non-flag tokens after a REPEATABLE_FLAG as values for
    // that flag (a trailing inline prompt after a greedy flag is unsupported).
    const r = await runCommandInProcess(
      ['task', 'add', 'some prompt', '--blocked-by', 'mars-4da0cfba'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(r.out[0]).toMatch(/^blocked mars-task-blk/)
  })
})
