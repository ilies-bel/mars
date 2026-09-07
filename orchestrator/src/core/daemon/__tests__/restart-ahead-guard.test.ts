/**
 * Regression test: coreRestartTask must never delete a branch whose tip is
 * ahead of integration without explicit `--force` confirmation. Commits ahead
 * are work product, so the refusal reports the destructive scope first.
 *
 * Covers the incident (2026-07-06 ~23:52Z, origin mars-50e3b511 /
 * recovery fix-a2b92b18) where `mars restart fix-a2b92b18` deleted
 * task/mars-50e3b511 because the fix task stored the origin's branch in its
 * own `branch` column, and the old cleanup path deleted it unconditionally.
 *
 * The invariant: NO cleanup path may delete a task branch whose tip is not an
 * ancestor of the integration branch. Delete the worktree if needed, but the
 * ref must survive.
 *
 * The deeper root cause (2026-07-27): even when `worktreePath` is set and the
 * worktree directory exists on disk, the guard was dead code. `removeWorktree`
 * was called WITHOUT `keepBranch=true`, so it ran `git branch -D` before the
 * commits-ahead guard had a chance to run. By the time the guard queried the
 * branch, it was already gone — `listUniqueCommitsAhead` returned empty and
 * control fell into the delete-else arm (a no-op). The fix: pass `keepBranch=true`
 * so the guard is the sole decision-maker on whether the ref is preserved or
 * removed. The regression tests below exercise the worktree-on-disk path that
 * previously caused silent data loss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { InMemoryStore } from '@mars/workflow'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface RestartModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
}

/** Create a minimal git repo with one commit on main so listUniqueCommitsAhead has a base. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-ahead-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repo })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; restart: RestartModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const restart = (await import('../restart-task')) as unknown as RestartModule
  return { q, restart }
}

const branchExists = (repo: string, branch: string): boolean =>
  execFileSync('git', ['branch', '--list', branch], { cwd: repo }).toString().trim() !== ''

describe('coreRestartTask — commits-ahead guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  it('refuses an ahead branch without force and reports the commits and files at risk', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Create the task branch and land a commit ahead of main
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'work.txt'), 'work product')
    execFileSync('git', ['add', 'work.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'work commit — must survive restart'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    // Mark the task as failed with the branch column populated
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/1 authored commit\(s\).*1 file\(s\) at risk[\s\S]*work commit — must survive restart[\s\S]*--force/)

    // The refusal happens before any worktree or branch cleanup.
    expect(branchExists(repo, branch)).toBe(true)

    await restart.coreRestartTask(
      task.id,
      new Set(['failed']),
      new InMemoryStore(),
      { force: true },
    )
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('simulates the incident: fix task storing origin branch, restart preserves the origin ref', async () => {
    // The real incident: fix-a2b92b18 stored task/mars-50e3b511 in its own
    // branch column because it took over the origin's worktree. When
    // `mars restart fix-a2b92b18` was called, it deleted task/mars-50e3b511.
    const { q, restart } = await loadModules(repo)

    // Simulate the origin task's branch with committed work
    const originTask = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const originBranch = `task/${originTask.id}`

    execFileSync('git', ['checkout', '-b', originBranch], { cwd: repo })
    writeFileSync(resolve(repo, 'origin-work.txt'), '4 commits worth of work')
    execFileSync('git', ['add', 'origin-work.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'origin: unmerged committed work'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    // Simulate the fix task that stored the origin's branch in its row
    const fixTask = await q.enqueueTask('fix for origin', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', fix_for_task_id = ?, branch = ? WHERE id = ?`,
      args: [originTask.id, originBranch, fixTask.id],
    })

    // `mars restart fix-a2b92b18` without --force must not delete the origin's
    // branch merely because the fix row inherited it.
    await expect(
      restart.coreRestartTask(fixTask.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/--force/)

    expect(branchExists(repo, originBranch)).toBe(true)
  })

  it('deletes the branch when it has no commits ahead of integration', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('task at integration tip', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Branch at the same tip as main — zero commits ahead, no work product
    execFileSync('git', ['branch', branch], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    await restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore())

    // No unmerged work — the branch should be cleaned up
    expect(branchExists(repo, branch)).toBe(false)
  })

  // ── Regression: worktree directory exists on disk ─────────────────────────
  // These tests exercise the code path that was broken: `task.worktreePath`
  // is set AND the directory is a live registered git worktree. Without the
  // fix, `removeWorktree` deleted the branch (keepBranch defaulted to false)
  // before the commits-ahead guard could see it, making the guard dead code.

  it('leaves an ahead branch and its worktree untouched without force', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('task with live worktree', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Create the branch with a commit ahead of main
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'live-work.txt'), 'live work product')
    execFileSync('git', ['add', 'live-work.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'live work — must survive restart via worktree path'], {
      cwd: repo,
    })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    // Register a real git worktree at a path inside the test repo
    // (so it's cleaned up automatically when the repo tmpdir is removed)
    const wtDir = resolve(repo, '.mars', 'worktrees')
    mkdirSync(wtDir, { recursive: true })
    const wtPath = resolve(wtDir, task.id)
    execFileSync('git', ['worktree', 'add', wtPath, branch], { cwd: repo })

    // Set worktreePath on the task — this is what triggers the removeWorktree call
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [branch, wtPath, task.id],
    })

    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/1 authored commit\(s\).*1 file\(s\) at risk[\s\S]*live work — must survive restart via worktree path[\s\S]*--force/)

    // Branch and worktree both survive because the destructive path never ran.
    expect(branchExists(repo, branch)).toBe(true)
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo }).toString())
      .toContain(wtPath)
  })

  it('deletes a branch when worktree exists on disk but branch has no commits ahead', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('task at tip with live worktree', undefined, {
      skipTriage: true,
    })
    const branch = `task/${task.id}`

    // Branch at the same commit as main — zero unique commits ahead
    execFileSync('git', ['branch', branch], { cwd: repo })

    // Register a real git worktree at a path inside the test repo
    const wtDir = resolve(repo, '.mars', 'worktrees')
    mkdirSync(wtDir, { recursive: true })
    const wtPath = resolve(wtDir, task.id)
    execFileSync('git', ['worktree', 'add', wtPath, branch], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [branch, wtPath, task.id],
    })

    await restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore())

    // Zero commits ahead — the branch carries no work product and must be deleted
    expect(branchExists(repo, branch)).toBe(false)
  })
})

/**
 * Regression: operator auto-commits must not count as authored work.
 *
 * The incident (mars-5bc47f92): a stale branch had 2 commits, both
 * `wip(operator): auto-committed to unblock merge of <task>`. The guard
 * reported 34 "files ahead" via a three-dot (merge-base) diff and refused
 * the restart, even though the branch held no real coder work. The fix:
 *
 * 1. Classify commits by subject prefix — operator auto-commits are excluded
 *    from the "authored" count that gates the refusal.
 * 2. Count at-risk files via content containment (two-dot + cat-file presence),
 *    not the merge-base diff that overcounts diverged-but-already-landed files.
 * 3. When authored commits DO exist, the message lists their subjects and notes
 *    any operator auto-commits separately.
 */
describe('coreRestartTask — operator auto-commit classification', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  it('does not refuse when all commits are operator auto-commits (no authored work)', async () => {
    const { q, restart } = await loadModules(repo)
    const task = await q.enqueueTask('stale task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Create the task branch with only operator auto-commits.
    // These are the machine-generated salvage commits that the merge step
    // creates when it sweeps operator dirt on the integration checkout.
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'operator-dirt.txt'), 'some operator dirt\n')
    execFileSync('git', ['add', 'operator-dirt.txt'], { cwd: repo })
    execFileSync('git', [
      'commit',
      '-m',
      `wip(operator): auto-committed to unblock merge of mars-other-task`,
    ], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    // Must NOT refuse — all commits ahead are operator auto-commits, not
    // authored coder work.
    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).resolves.toBeDefined()

    // Branch cleaned up (no authored work to protect).
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('refuses when authored commits exist and names their subjects', async () => {
    const { q, restart } = await loadModules(repo)
    const task = await q.enqueueTask('task with real work', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })

    // One operator auto-commit (should not count as authored work).
    writeFileSync(resolve(repo, 'operator-dirt.txt'), 'operator dirt\n')
    execFileSync('git', ['add', 'operator-dirt.txt'], { cwd: repo })
    execFileSync('git', [
      'commit',
      '-m',
      `wip(operator): auto-committed to unblock merge of mars-other-task`,
    ], { cwd: repo })

    // One real authored commit (should trigger the refusal).
    writeFileSync(resolve(repo, 'real-work.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'real-work.ts'], { cwd: repo })
    execFileSync('git', [
      'commit',
      '-m',
      'feat(core): implement the critical algorithm',
    ], { cwd: repo })

    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    // Must refuse AND name the authored commit's subject.
    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/feat\(core\): implement the critical algorithm/)

    // Must also note the operator auto-commit separately.
    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/1 operator auto-commit/)

    // Counts only authored commits — 1, not 2.
    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/1 authored commit/)

    // Branch preserved.
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('files-at-risk count uses content containment, not merge-base diff', async () => {
    // Reproduce the exact overcounting scenario from the incident:
    //   - task branch has 1 authored commit adding a file already present on main
    //   - main has since added many other files independently
    //   - three-dot (merge-base) diff would report 6 files changed as "at risk"
    //   - content containment correctly reports 0 files at risk because the
    //     authored file's blob is identical to what's already on main
    const { q, restart } = await loadModules(repo)
    const task = await q.enqueueTask('stale task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Remember the initial commit sha (this will be the task's branch point).
    const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      .toString()
      .trim()

    // Advance main with a shared file and 4 independent files.
    writeFileSync(resolve(repo, 'shared.txt'), 'shared content\n')
    for (let i = 0; i < 4; i++) {
      writeFileSync(resolve(repo, `main-work-${i}.ts`), `export const v${i} = ${i}\n`)
    }
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'chore: advance main independently'], { cwd: repo })

    // Create the task branch from BEFORE main advanced (simulating a stale branch).
    execFileSync('git', ['branch', branch, initialSha], { cwd: repo })
    execFileSync('git', ['checkout', branch], { cwd: repo })

    // Add one authored commit that introduces shared.txt with the SAME blob as main.
    // The merge-base diff (three-dot) would include ALL 5 files that diverged from
    // the initial commit (shared.txt + 4 main-work-*.ts). Content containment
    // checks each path against the integration tip: shared.txt exists on main
    // with the same blob → 0 files at risk.
    writeFileSync(resolve(repo, 'shared.txt'), 'shared content\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', [
      'commit',
      '-m',
      'docs: add shared.txt (same blob already present on main)',
    ], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    // Must refuse (authored commit present) but report 0 files at risk:
    // shared.txt's blob is already on main, so content containment finds nothing
    // unique. A three-dot diff would wrongly have reported 5 files.
    await expect(
      restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/0 file\(s\) at risk/)
  })
})

/**
 * The commits-ahead guard above only sees work the coder committed. A worktree
 * can sit at ahead=0 and still hold the whole substance of the task: that is
 * the normal shape of a `context-exhausted` failure, where the coder was
 * killed mid-task rather than bailing. On 2026-08-20 two tasks showed ahead=0
 * while holding 8 and 4 uncommitted files, and `mars restart` would have
 * deleted both worktrees without a word.
 */
describe('coreRestartTask — uncommitted-worktree guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  /** Register a real worktree at ahead=0 and leave `dirtyFiles` uncommitted in it. */
  const setupDirtyWorktree = async (
    q: QueueModule,
    dirtyFiles: string[],
  ): Promise<{ taskId: string; branch: string; wtPath: string }> => {
    const task = await q.enqueueTask('task killed mid-edit', undefined, { skipTriage: true })
    const branch = `task/${task.id}`
    execFileSync('git', ['branch', branch], { cwd: repo })

    const wtDir = resolve(repo, '.mars', 'worktrees')
    mkdirSync(wtDir, { recursive: true })
    const wtPath = resolve(wtDir, task.id)
    execFileSync('git', ['worktree', 'add', wtPath, branch], { cwd: repo })

    for (const name of dirtyFiles) {
      writeFileSync(resolve(wtPath, name), 'work the coder never got to commit\n')
    }

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ?, worktree_path = ? WHERE id = ?`,
      args: [branch, wtPath, task.id],
    })
    return { taskId: task.id, branch, wtPath }
  }

  it('refuses a dirty worktree at ahead=0 without force, naming every path at risk', async () => {
    const { q, restart } = await loadModules(repo)
    const { taskId, branch, wtPath } = await setupDirtyWorktree(q, [
      'checkpoint.ts',
      'coder-exit.ts',
      'merge.ts',
    ])

    await expect(
      restart.coreRestartTask(taskId, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/3 uncommitted path\(s\)/)

    // The refusal must precede all cleanup — nothing is destroyed.
    expect(branchExists(repo, branch)).toBe(true)
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: wtPath }).toString().trim(),
    ).not.toBe('')
  })

  it('names --force and mars continue as the two ways forward', async () => {
    const { q, restart } = await loadModules(repo)
    const { taskId } = await setupDirtyWorktree(q, ['work.ts'])

    await expect(
      restart.coreRestartTask(taskId, new Set(['failed']), new InMemoryStore()),
    ).rejects.toThrow(/work\.ts[\s\S]*mars continue[\s\S]*--force/)
  })

  it('proceeds with force, discarding the dirty worktree', async () => {
    const { q, restart } = await loadModules(repo)
    const { taskId, branch } = await setupDirtyWorktree(q, ['work.ts'])

    await restart.coreRestartTask(taskId, new Set(['failed']), new InMemoryStore(), {
      force: true,
    })

    expect(branchExists(repo, branch)).toBe(false)
  })

  it('still restarts a clean worktree at ahead=0 without force', async () => {
    const { q, restart } = await loadModules(repo)
    const { taskId, branch } = await setupDirtyWorktree(q, [])

    await restart.coreRestartTask(taskId, new Set(['failed']), new InMemoryStore())

    expect(branchExists(repo, branch)).toBe(false)
  })
})
