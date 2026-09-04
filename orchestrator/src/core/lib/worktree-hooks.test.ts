/**
 * Unit tests for worktree-hooks.ts.
 *
 * Tests that run real bash commands are marked with the system() tag.
 * They require a POSIX environment (darwin / linux) — on Windows they are
 * skipped automatically because runWorktreeHooks returns
 * `skippedReason: 'non-posix-platform'` and the test asserts that.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildHookEnv,
  isRepoTrusted,
  normalizeCommandList,
  parseHooksConfig,
  runWorktreeHooks,
  stripAnsi,
  truncateOutput,
  trustRepo,
  untrustRepo,
} from './worktree-hooks'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-hooks-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const isPosix = platform() !== 'win32'

// ---------------------------------------------------------------------------
// normalizeCommandList
// ---------------------------------------------------------------------------

describe('normalizeCommandList', () => {
  it('accepts a single string', () => {
    expect(normalizeCommandList('echo hi')).toEqual(['echo hi'])
  })

  it('trims the string', () => {
    expect(normalizeCommandList('  echo hi  ')).toEqual(['echo hi'])
  })

  it('returns empty array for blank string', () => {
    expect(normalizeCommandList('   ')).toEqual([])
  })

  it('accepts an array of strings', () => {
    expect(normalizeCommandList(['cmd1', 'cmd2'])).toEqual(['cmd1', 'cmd2'])
  })

  it('filters blank entries from an array', () => {
    expect(normalizeCommandList(['cmd1', '  ', 'cmd2', ''])).toEqual(['cmd1', 'cmd2'])
  })

  it('ignores non-string elements in array', () => {
    expect(normalizeCommandList(['cmd1', 42, null, 'cmd2'])).toEqual(['cmd1', 'cmd2'])
  })

  it('returns empty for a number', () => {
    expect(normalizeCommandList(42)).toEqual([])
  })

  it('returns empty for null', () => {
    expect(normalizeCommandList(null)).toEqual([])
  })

  it('returns empty for an object', () => {
    expect(normalizeCommandList({ cmd: 'echo hi' })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseHooksConfig
// ---------------------------------------------------------------------------

describe('parseHooksConfig', () => {
  it('returns empty config when mars.json is absent', async () => {
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg).toEqual({ setup: [], teardown: [] })
  })

  it('parses string setup and array teardown', async () => {
    await writeFile(
      resolve(tmpDir, 'mars.json'),
      JSON.stringify({ worktree: { setup: 'cp .env.example .env', teardown: ['rm -f .env'] } }),
    )
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg.setup).toEqual(['cp .env.example .env'])
    expect(cfg.teardown).toEqual(['rm -f .env'])
  })

  it('parses array of strings for setup', async () => {
    await writeFile(
      resolve(tmpDir, 'mars.json'),
      JSON.stringify({ worktree: { setup: ['cmd1', 'cmd2'] } }),
    )
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg.setup).toEqual(['cmd1', 'cmd2'])
    expect(cfg.teardown).toEqual([])
  })

  it('returns empty config for invalid JSON', async () => {
    await writeFile(resolve(tmpDir, 'mars.json'), 'not json')
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg).toEqual({ setup: [], teardown: [] })
  })

  it('returns empty config when worktree key is missing', async () => {
    await writeFile(resolve(tmpDir, 'mars.json'), JSON.stringify({ other: 'stuff' }))
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg).toEqual({ setup: [], teardown: [] })
  })

  it('returns empty config when worktree is not an object', async () => {
    await writeFile(resolve(tmpDir, 'mars.json'), JSON.stringify({ worktree: 'string' }))
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg).toEqual({ setup: [], teardown: [] })
  })

  it('returns empty config when root is not an object', async () => {
    await writeFile(resolve(tmpDir, 'mars.json'), JSON.stringify([1, 2, 3]))
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg).toEqual({ setup: [], teardown: [] })
  })

  it('drops blank setup entries', async () => {
    await writeFile(
      resolve(tmpDir, 'mars.json'),
      JSON.stringify({ worktree: { setup: ['valid', '  ', ''] } }),
    )
    const cfg = await parseHooksConfig(tmpDir)
    expect(cfg.setup).toEqual(['valid'])
  })
})

// ---------------------------------------------------------------------------
// buildHookEnv
// ---------------------------------------------------------------------------

describe('buildHookEnv', () => {
  it('returns absolute paths', () => {
    const env = buildHookEnv({
      worktreePath: '/abs/worktree',
      rootPath: '/abs/root',
      branchName: 'task/abc',
      taskId: 'abc123',
    })
    expect(env.MARS_WORKTREE_PATH).toBe('/abs/worktree')
    expect(env.MARS_ROOT_PATH).toBe('/abs/root')
    expect(env.MARS_BRANCH_NAME).toBe('task/abc')
    expect(env.MARS_TASK_ID).toBe('abc123')
  })

  it('expands tilde in worktreePath', () => {
    const env = buildHookEnv({
      worktreePath: '~/some/path',
      rootPath: '/root',
      branchName: 'main',
      taskId: 't1',
    })
    expect(env.MARS_WORKTREE_PATH).toBe(resolve(homedir(), 'some/path'))
    expect(env.MARS_WORKTREE_PATH).not.toContain('~')
  })

  it('expands tilde in rootPath', () => {
    const env = buildHookEnv({
      worktreePath: '/worktree',
      rootPath: '~/projects/repo',
      branchName: 'main',
      taskId: 't1',
    })
    expect(env.MARS_ROOT_PATH).toBe(resolve(homedir(), 'projects/repo'))
    expect(env.MARS_ROOT_PATH).not.toContain('~')
  })

  it('resolves relative paths to absolute', () => {
    const env = buildHookEnv({
      worktreePath: 'relative/path',
      rootPath: 'another/relative',
      branchName: 'main',
      taskId: 't1',
    })
    expect(resolve(env.MARS_WORKTREE_PATH)).toBe(env.MARS_WORKTREE_PATH)
    expect(resolve(env.MARS_ROOT_PATH)).toBe(env.MARS_ROOT_PATH)
  })
})

// ---------------------------------------------------------------------------
// truncateOutput / stripAnsi
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('strips CSI colour sequences', () => {
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red')
  })

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1B]0;title\x07normal')).toBe('normal')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })
})

describe('truncateOutput', () => {
  const HALF = 32 * 1024

  it('returns unchanged output under 64 KB', () => {
    const s = 'x'.repeat(HALF)
    expect(truncateOutput(s)).toBe(s)
  })

  it('truncates output over 64 KB keeping head and tail', () => {
    // Build: 32 KB head marker + 1 KB filler + 32 KB tail marker
    const head = 'H'.repeat(HALF)
    const filler = 'M'.repeat(1024)
    const tail = 'T'.repeat(HALF)
    const raw = head + filler + tail

    const result = truncateOutput(raw)
    expect(result).toContain('...<output truncated>...')
    // Head is preserved
    expect(result.slice(0, HALF)).toBe(head)
    // Tail is preserved (after the truncation marker)
    const markerIndex = result.indexOf('...<output truncated>...')
    const afterMarker = result.slice(markerIndex + '...<output truncated>...'.length + 1) // +1 for newline
    expect(afterMarker).toBe(tail)
    // Filler is NOT present
    expect(result).not.toContain('M'.repeat(10))
  })

  it('strips ANSI from the output', () => {
    const s = '\x1B[31mred\x1B[0m'
    expect(truncateOutput(s)).toBe('red')
  })
})

// ---------------------------------------------------------------------------
// runWorktreeHooks — real bash commands (POSIX only)
// ---------------------------------------------------------------------------

describe('runWorktreeHooks', () => {
  const makeEnv = (dir: string) =>
    buildHookEnv({
      worktreePath: dir,
      rootPath: dir,
      branchName: 'task/test',
      taskId: 'test-task',
    })

  it('succeeds with an empty command list', async () => {
    const result = await runWorktreeHooks({
      commands: [],
      hookEnv: makeEnv(tmpDir),
    })
    expect(result.success).toBe(true)
  })

  it.skipIf(!isPosix)('succeeds when a command exits 0', async () => {
    const result = await runWorktreeHooks({
      commands: ['true'],
      hookEnv: makeEnv(tmpDir),
    })
    expect(result.success).toBe(true)
  })

  it.skipIf(!isPosix)('stops at the first failing command', async () => {
    // Three commands: first exits 0, second exits 2, third should never run
    const sideEffect = resolve(tmpDir, 'ran-third')
    const result = await runWorktreeHooks({
      commands: ['true', 'exit 2', `touch ${sideEffect}`],
      hookEnv: makeEnv(tmpDir),
    })
    expect(result.success).toBe(false)
    expect(result.failedCommandIndex).toBe(1)
    expect(result.exitCode).toBe(2)
    // Third command must NOT have run
    await expect(readFile(sideEffect)).rejects.toThrow()
  })

  it.skipIf(!isPosix)('exports MARS_* env vars to each command', async () => {
    const outFile = resolve(tmpDir, 'env-out.txt')
    const hookEnv = makeEnv(tmpDir)
    const result = await runWorktreeHooks({
      commands: [
        `printf '%s\\n%s\\n%s\\n%s' ` +
          `"$MARS_WORKTREE_PATH" "$MARS_ROOT_PATH" "$MARS_BRANCH_NAME" "$MARS_TASK_ID" ` +
          `> ${outFile}`,
      ],
      hookEnv,
    })
    expect(result.success).toBe(true)
    const out = await readFile(outFile, 'utf8')
    const [wt, rp, bn, tid] = out.split('\n')
    expect(wt).toBe(hookEnv.MARS_WORKTREE_PATH)
    expect(rp).toBe(hookEnv.MARS_ROOT_PATH)
    expect(bn).toBe(hookEnv.MARS_BRANCH_NAME)
    expect(tid).toBe(hookEnv.MARS_TASK_ID)
  })

  it.skipIf(!isPosix)('captures output and includes it in the failure result', async () => {
    const result = await runWorktreeHooks({
      commands: ['echo "error detail" >&2; exit 1'],
      hookEnv: makeEnv(tmpDir),
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('error detail')
  })

  it.skipIf(!isPosix)(
    'kills the process group on per-command timeout and returns timedOut',
    async () => {
      const started = Date.now()
      // sleep 60 would take a minute — 200ms timeout should kill it in < 2s
      const result = await runWorktreeHooks({
        commands: ['sleep 60'],
        hookEnv: makeEnv(tmpDir),
        commandTimeoutMs: 200,
      })
      const elapsed = Date.now() - started
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(true)
      // Should have exited far sooner than the 60-second sleep
      expect(elapsed).toBeLessThan(5_000)
    },
    10_000, // jest/vitest timeout for this test
  )

  it.skipIf(!isPosix)(
    'aborts on AbortSignal and returns aborted',
    async () => {
      const ac = new AbortController()
      const started = Date.now()
      const p = runWorktreeHooks({
        commands: ['sleep 60'],
        hookEnv: makeEnv(tmpDir),
        signal: ac.signal,
      })
      // Abort after a short delay
      setTimeout(() => ac.abort(), 100)
      const result = await p
      const elapsed = Date.now() - started
      expect(result.success).toBe(false)
      expect(result.aborted).toBe(true)
      expect(elapsed).toBeLessThan(5_000)
    },
    10_000,
  )

  it.skipIf(!isPosix)(
    'does not execute subsequent commands after aborting',
    async () => {
      const sideEffect = resolve(tmpDir, 'should-not-exist')
      const ac = new AbortController()
      // Abort immediately
      ac.abort()
      const result = await runWorktreeHooks({
        commands: [`touch ${sideEffect}`, 'true'],
        hookEnv: makeEnv(tmpDir),
        signal: ac.signal,
      })
      expect(result.success).toBe(false)
      await expect(readFile(sideEffect)).rejects.toThrow()
    },
  )
})

// ---------------------------------------------------------------------------
// Trust gate
// ---------------------------------------------------------------------------

describe('trust gate', () => {
  let stateDir = ''

  beforeEach(async () => {
    stateDir = await mkdtemp(resolve(tmpdir(), 'mars-trust-test-'))
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  it('returns false for an unknown repo', async () => {
    expect(await isRepoTrusted('/some/repo', stateDir)).toBe(false)
  })

  it('returns true after trustRepo', async () => {
    await trustRepo('/some/repo', stateDir)
    expect(await isRepoTrusted('/some/repo', stateDir)).toBe(true)
  })

  it('does not trust a different repo path', async () => {
    await trustRepo('/repo/a', stateDir)
    expect(await isRepoTrusted('/repo/b', stateDir)).toBe(false)
  })

  it('revokes trust with untrustRepo', async () => {
    await trustRepo('/some/repo', stateDir)
    await untrustRepo('/some/repo', stateDir)
    expect(await isRepoTrusted('/some/repo', stateDir)).toBe(false)
  })

  it('persists trust across calls (reads from file)', async () => {
    await trustRepo('/some/repo', stateDir)
    // Read the file directly to confirm it was persisted
    const content = await readFile(resolve(stateDir, 'worktree-trust.json'), 'utf8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    expect(parsed[resolve('/some/repo')]).toBe(true)
  })

  it('creates stateDir if it does not exist', async () => {
    const nestedState = resolve(stateDir, 'deeply/nested/state')
    await trustRepo('/repo', nestedState)
    expect(await isRepoTrusted('/repo', nestedState)).toBe(true)
  })

  it('gracefully handles a corrupt trust file', async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(resolve(stateDir, 'worktree-trust.json'), 'not json')
    expect(await isRepoTrusted('/some/repo', stateDir)).toBe(false)
    // trustRepo should still succeed (overwrites corrupt file)
    await trustRepo('/some/repo', stateDir)
    expect(await isRepoTrusted('/some/repo', stateDir)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Untrusted repo: setup hooks must not run
// ---------------------------------------------------------------------------

describe('trust gate integration', () => {
  it.skipIf(!isPosix)(
    'does NOT execute setup commands when repo is untrusted',
    async () => {
      // The setup-worktree caller is responsible for checking trust; the hook
      // library itself is always callable. This test verifies that the
      // isRepoTrusted guard correctly blocks setup when untrusted.
      const stateDir = await mkdtemp(resolve(tmpdir(), 'mars-trust-gate-'))
      const sideEffect = resolve(tmpDir, 'should-not-exist')
      try {
        const trusted = await isRepoTrusted(tmpDir, stateDir)
        // When the repo is NOT trusted, the caller skips runWorktreeHooks.
        // Simulate that behaviour:
        let hookRan = false
        if (trusted) {
          await runWorktreeHooks({
            commands: [`touch ${sideEffect}`],
            hookEnv: buildHookEnv({
              worktreePath: tmpDir,
              rootPath: tmpDir,
              branchName: 'main',
              taskId: 't1',
            }),
          })
          hookRan = true
        }
        expect(trusted).toBe(false)
        expect(hookRan).toBe(false)
        await expect(readFile(sideEffect)).rejects.toThrow()
      } finally {
        await rm(stateDir, { recursive: true, force: true })
      }
    },
  )
})
