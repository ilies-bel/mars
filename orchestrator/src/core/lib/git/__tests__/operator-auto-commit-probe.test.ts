/**
 * The post-auto-commit typecheck probe (ADR-0100 slice 7).
 *
 * Right after Mars auto-commits the operator's work-in-progress onto the
 * integration branch, it typechecks what it just committed. The probe is a
 * DETECTOR, not a gate: the merge lands either way. Its whole reason to exist
 * is that an operator who learns within seconds that their half-finished edit
 * is now a broken baseline can amend it before a dozen tasks branch off it.
 *
 * Two layers, both exercised here:
 *
 *   1. `probeMainTypecheck` against REAL projects in a temp dir, spawning a
 *      real package manager. The interesting cases are all about a child
 *      process's actual behaviour — a non-zero exit, a hang killed by the
 *      timeout, a repo that declares no typecheck at all — and a stubbed
 *      spawn proves none of them.
 *
 *   2. `mergeBranch`'s wiring against a real temp repo: that the probe runs
 *      only on the auto-commit path, that a failure raises exactly one Alert,
 *      and that `merged: true` survives every probe outcome including a throw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, type MergeGateOutcome } from '../merge'
import { probeMainTypecheck } from '../operator-auto-commit'
import { raiseBrokenAutoCommitAlert } from '../../notices/operator-auto-commit'
import { nullTraceStore } from '../../run-tool'
import { __resetContextCacheForTests } from '../../../context'

const TASK_ID = 'mars-pr0b3id'

// ── Layer 1: probeMainTypecheck against real projects ────────────────────────

describe('probeMainTypecheck', () => {
  let projectDir: string

  const writePackage = (dir: string, typecheck?: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify({
        name: 'probe-fixture',
        private: true,
        ...(typecheck === undefined ? {} : { scripts: { typecheck } }),
      }),
    )
  }

  beforeEach(() => {
    projectDir = mkdtempSync(resolve(tmpdir(), 'mars-probe-typecheck-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('reports ok when the project declares no typecheck script', async () => {
    writePackage(projectDir)

    await expect(probeMainTypecheck({ repoRoot: projectDir })).resolves.toEqual({ ok: true })
  }, 30_000)

  it('reports ok when the typecheck exits 0', async () => {
    writePackage(projectDir, 'node -e "process.exit(0)"')

    await expect(probeMainTypecheck({ repoRoot: projectDir })).resolves.toEqual({ ok: true })
  }, 30_000)

  it('reports the failure output when the typecheck exits non-zero', async () => {
    writePackage(
      projectDir,
      'node -e "console.log(\'src/a.ts(1,1): error TS2304: Cannot find name x.\'); process.exit(2)"',
    )

    const result = await probeMainTypecheck({ repoRoot: projectDir })

    expect(result.ok).toBe(false)
    // The operator has to be able to read what broke straight off the Alert.
    expect(result.ok === false ? result.output : '').toContain('error TS2304')
  }, 30_000)

  it('finds a typecheck declared in a subdirectory package, not just at the root', async () => {
    // The shape of this very repo: the root manifest carries workspace glue,
    // the typecheck script lives one level down.
    writePackage(projectDir)
    writePackage(
      resolve(projectDir, 'orchestrator'),
      'node -e "console.log(\'nested typecheck ran\'); process.exit(3)"',
    )

    const result = await probeMainTypecheck({ repoRoot: projectDir })

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.output : '').toContain('nested typecheck ran')
  }, 30_000)

  it('reports timeout — not failure — when the typecheck outruns its budget', async () => {
    writePackage(projectDir, 'node -e "setTimeout(() => {}, 120000)"')

    const result = await probeMainTypecheck({ repoRoot: projectDir, timeoutMs: 3_000 })

    // A killed probe is NO SIGNAL. Reporting it as `ok: false` would raise an
    // Alert accusing the operator of breaking a baseline that may be fine.
    expect(result).toEqual({ ok: 'timeout' })
  }, 30_000)
})

// ── Layer 2: mergeBranch wiring against a real repo ──────────────────────────

describe('mergeBranch — post-auto-commit probe wiring', () => {
  let repoDir: string
  let worktreeDir: string
  let prevMarsRepo: string | undefined

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

  const commitFile = (name: string, contents: string, message: string): void => {
    writeFileSync(resolve(repoDir, name), contents)
    git('add', name)
    git('commit', '-m', message)
  }

  /** Raised rows, captured through `raiseBrokenAutoCommitAlert`'s raise seam. */
  let raised: Array<{ title: string; body: string; signature: string }>

  /**
   * The production `onOperatorAutoCommit` handler in `merge-worker.ts`, minus
   * the conversation Notice (which needs a chat store): raise the Alert iff
   * the probe positively failed.
   */
  const alertOnFailedProbe = async (info: {
    commitSha: string
    probe: MergeGateOutcome | null
  }): Promise<void> => {
    if (!info.probe || info.probe.passed) return
    await raiseBrokenAutoCommitAlert(
      {
        taskId: TASK_ID,
        branch: 'main',
        commitSha: info.commitSha,
        output: info.probe.output,
      },
      async (item) => {
        raised.push({ title: item.title, body: item.body, signature: item.signature })
        return 'aq-test-id'
      },
    )
  }

  beforeEach(() => {
    raised = []
    repoDir = mkdtempSync(resolve(tmpdir(), 'mars-auto-commit-probe-'))
    prevMarsRepo = process.env.MARS_REPO
    process.env.MARS_REPO = repoDir
    __resetContextCacheForTests()

    git('init', '-b', 'main')
    git('config', 'user.email', 'test@mars.local')
    git('config', 'user.name', 'Mars Test')
    git('config', 'commit.gpgsign', 'false')

    commitFile('a.txt', 'a', 'c1')
    commitFile('operator.txt', 'original', 'c1b')

    git('branch', 'task/feat')
    worktreeDir = resolve(repoDir, '..', `${repoDir.split('/').pop()}-wt`)
    git('worktree', 'add', worktreeDir, 'task/feat')
    execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: worktreeDir })
    writeFileSync(resolve(worktreeDir, 'b.txt'), 'merged content')
    execFileSync('git', ['add', 'b.txt'], { cwd: worktreeDir })
    execFileSync('git', ['commit', '-m', 'c2'], { cwd: worktreeDir })
  })

  afterEach(() => {
    if (prevMarsRepo === undefined) delete process.env.MARS_REPO
    else process.env.MARS_REPO = prevMarsRepo
    __resetContextCacheForTests()
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(worktreeDir, { recursive: true, force: true })
  })

  it('raises exactly one Alert on a failing probe and still merges', async () => {
    writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')

    const probedShas: string[] = []
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      autoCommitOperatorDirt: true,
      onProbeIntegrationAfterAutoCommit: async ({ commitSha }) => {
        probedShas.push(commitSha)
        return {
          passed: false,
          output: 'operator.txt(1,1): error TS2304: Cannot find name PRECIOUS.',
        }
      },
      onOperatorAutoCommit: alertOnFailedProbe,
      traceCtx: { taskId: TASK_ID, store: nullTraceStore },
    })

    // The probe is a detector: a broken baseline does NOT roll the merge back.
    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)

    const autoCommitSha = git('rev-parse', 'main')
    expect(result.operatorAutoCommitSha).toBe(autoCommitSha)
    // It probed the auto-commit itself, once.
    expect(probedShas).toEqual([autoCommitSha])

    // Exactly one Alert, naming the sha and carrying the typecheck output.
    expect(raised).toHaveLength(1)
    expect(raised[0]?.title).toContain(autoCommitSha.slice(0, 9))
    expect(raised[0]?.body).toContain('error TS2304')
    // Signed on the sha so a re-probe of the same commit bumps this row rather
    // than stacking a second one.
    expect(raised[0]?.signature).toBe(`operator-auto-commit-typecheck:${autoCommitSha}`)
  }, 60_000)

  it('raises no Alert when the probe passes', async () => {
    writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      autoCommitOperatorDirt: true,
      onProbeIntegrationAfterAutoCommit: async (): Promise<MergeGateOutcome> => ({ passed: true }),
      onOperatorAutoCommit: alertOnFailedProbe,
      traceCtx: { taskId: TASK_ID, store: nullTraceStore },
    })

    expect(result.merged).toBe(true)
    expect(result.operatorAutoCommitSha).toBe(git('rev-parse', 'main'))
    expect(raised).toEqual([])
  }, 60_000)

  it('merges without probing when there is no operator dirt to auto-commit', async () => {
    // Clean integration checkout: nothing is auto-committed, so there is
    // nothing to probe — the probe must not run on the clean path.
    let probeCalls = 0
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      autoCommitOperatorDirt: true,
      onProbeIntegrationAfterAutoCommit: async (): Promise<MergeGateOutcome> => {
        probeCalls += 1
        return { passed: true }
      },
      onOperatorAutoCommit: alertOnFailedProbe,
      traceCtx: { taskId: TASK_ID, store: nullTraceStore },
    })

    expect(result.merged).toBe(true)
    expect(result.operatorAutoCommitSha).toBeUndefined()
    expect(probeCalls).toBe(0)
    expect(raised).toEqual([])
  }, 60_000)

  it('still merges when the probe itself throws', async () => {
    writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      autoCommitOperatorDirt: true,
      onProbeIntegrationAfterAutoCommit: async (): Promise<MergeGateOutcome> => {
        throw new Error('probe exploded')
      },
      onOperatorAutoCommit: alertOnFailedProbe,
      traceCtx: { taskId: TASK_ID, store: nullTraceStore },
    })

    // A reporting-layer failure can never undo a commit that already landed.
    expect(result.merged).toBe(true)
    expect(result.operatorAutoCommitSha).toBe(git('rev-parse', 'main'))
    expect(raised).toEqual([])
  }, 60_000)
})
