/**
 * Integration tests for commitMain and autoCommitWorktreeIfDeterministic
 * against a real git repo.
 *
 * Covers three incidents:
 *
 * 1. 2026-07-20 data-loss: the main-committer used `git commit -am`, which
 *    silently drops new untracked files. commitMain uses `git add -A` so every
 *    file — modified tracked AND newly created untracked — ends up in the commit.
 *
 * 2. 2026-08-05 branch-safety: a checkpoint/recovery agent committed directly
 *    to `main` (commit 93addc75) because the worktree happened to have HEAD on
 *    `main`. The helpers now enforce that commits only land on the invoking
 *    task's own `task/<id>` branch.
 *
 * 3. 2026-08-17 untracked build artifacts: an operator built `app/dist-demo/`
 *    as an untracked directory and the salvage path committed it to main.
 *    committer-salvage now uses `git add -u` (tracked-only) and checkSecretPath
 *    refuses generated-output directory paths outright.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  autoCommitWorktreeIfDeterministic,
  commitMain,
  CommitToMainError,
  CommitToWrongBranchError,
} from '../commit-main'

/** Create a temp git repo on `main` with a single tracked file and initial commit. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-commit-main-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  writeFileSync(resolve(repo, 'tracked.txt'), 'initial content\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

/**
 * Switch the repo to a `task/<name>` branch (creates it if absent).
 * Returns the full branch name.
 */
const checkoutTaskBranch = (repo: string, taskId: string): string => {
  const branch = `task/${taskId}`
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: repo })
  return branch
}

/** Return all file names tracked by the HEAD commit tree (committed files, not working tree). */
const headCommitTree = (repo: string): string[] =>
  execSync('git ls-tree --name-only -r HEAD', { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)

/** Return the file names recorded in the HEAD commit (excluding empty lines). */
const headCommitFiles = (repo: string): string[] =>
  execSync('git show --name-only --format= HEAD', { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)

// ---------------------------------------------------------------------------
// commitMain
// ---------------------------------------------------------------------------

describe('commitMain', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('stages and commits a new untracked file alongside a tracked modification', async () => {
    // Modify the tracked file — git commit -am would stage this.
    writeFileSync(resolve(repo, 'tracked.txt'), 'modified content\n')

    // Create a brand-new file that has never been added — git commit -am
    // would silently skip this, which was the root cause of the incident.
    writeFileSync(resolve(repo, 'new-module.ts'), 'export const x = 1\n')

    await commitMain({ cwd: repo, message: 'chore: both files must land' })

    const files = headCommitFiles(repo)
    expect(files).toContain('tracked.txt')
    expect(files).toContain('new-module.ts')
  })

  it('returns the SHA of the new commit', async () => {
    writeFileSync(resolve(repo, 'another.txt'), 'content\n')

    const { sha } = await commitMain({ cwd: repo, message: 'test: sha verification' })

    const headSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
    expect(sha).toBe(headSha)
  })

  it('throws when there is nothing to commit', async () => {
    // The tree is clean after setupRepo — git commit exits non-zero.
    await expect(commitMain({ cwd: repo, message: 'empty' })).rejects.toThrow()
  })

  it('does NOT stage files listed in .gitignore', async () => {
    // The task brief calls out .gitignore as the safety valve: git add -A
    // respects .gitignore, so scratch files / secrets / build artefacts
    // covered by .gitignore entries are never accidentally committed.
    writeFileSync(resolve(repo, '.gitignore'), 'secret.env\n')
    writeFileSync(resolve(repo, 'secret.env'), 'API_KEY=do-not-commit\n')
    // Add a legitimate new file so the commit is non-empty.
    writeFileSync(resolve(repo, 'legit.ts'), 'export const x = 1\n')

    await commitMain({ cwd: repo, message: 'chore: .gitignore boundary test' })

    const tree = headCommitTree(repo)
    expect(tree).toContain('.gitignore')
    expect(tree).toContain('legit.ts')
    expect(tree).not.toContain('secret.env')
  })

  // ── Branch-safety guard (2026-08-05 incident) ───────────────────────────

  it('throws CommitToMainError — distinct error — when taskId provided and HEAD is main', async () => {
    // Repo is already on `main`. This is the exact scenario that produced
    // commit 93addc75: a recovery agent committed to `main` because its
    // worktree had HEAD on the integration branch.
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    const err = await commitMain({
      cwd: repo,
      message: 'wip: should be blocked',
      taskId: 'task-abc',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(CommitToMainError)
    expect((err as CommitToMainError).currentBranch).toBe('main')
    // Nothing was staged — HEAD still has no `work.ts`.
    expect(headCommitTree(repo)).not.toContain('work.ts')
  })

  it('throws CommitToWrongBranchError when taskId provided and HEAD is a non-task branch', async () => {
    execFileSync('git', ['checkout', '-q', '-b', 'preserve/some-orphan'], { cwd: repo })
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    const err = await commitMain({
      cwd: repo,
      message: 'wip: should be blocked',
      taskId: 'task-abc',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(CommitToWrongBranchError)
    expect((err as CommitToWrongBranchError).currentBranch).toBe('preserve/some-orphan')
    expect((err as CommitToWrongBranchError).expectedBranch).toBe('task/task-abc')
    expect(headCommitTree(repo)).not.toContain('work.ts')
  })

  it('succeeds when taskId provided and HEAD is the correct task branch', async () => {
    checkoutTaskBranch(repo, 'task-abc')
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    const { sha } = await commitMain({
      cwd: repo,
      message: 'feat: task work',
      taskId: 'task-abc',
    })

    expect(sha).toBe(execSync('git rev-parse HEAD', { cwd: repo }).toString().trim())
    expect(headCommitFiles(repo)).toContain('work.ts')
  })

  it('skips branch validation when taskId is omitted (legacy callers)', async () => {
    // Repo is on `main` — without taskId, no branch check runs.
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    await expect(commitMain({ cwd: repo, message: 'chore: no-taskid' })).resolves.toMatchObject({
      sha: expect.any(String),
    })
  })
})

// ---------------------------------------------------------------------------
// autoCommitWorktreeIfDeterministic
// ---------------------------------------------------------------------------

describe('autoCommitWorktreeIfDeterministic', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('records coder-left-dirty and committer-salvage provenance accurately', async () => {
    // Must be on the expected task branch for the branch guard to pass.
    checkoutTaskBranch(repo, 'coder-task')
    writeFileSync(resolve(repo, 'coder-work.ts'), 'export const coderWork = true\n')

    await autoCommitWorktreeIfDeterministic({
      taskId: 'coder-task',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['coder-work.ts'],
    })

    const coderMessage = execSync('git log -1 --format=%B', { cwd: repo }).toString()
    expect(coderMessage).toContain(
      'chore(auto-commit): task coder-task — coder finished but did not commit — 1 path(s)',
    )
    expect(coderMessage).toContain(
      'The coder for task coder-task ended the code step with 1 path(s) still',
    )

    // Switch to a second task branch for the committer-salvage case.
    execFileSync('git', ['checkout', '-q', '-b', 'task/committer-task'], { cwd: repo })
    // committer-salvage uses `git add -u` (tracked modifications only), so the
    // file must be a tracked modification — add it to the index first.
    writeFileSync(resolve(repo, 'tracked.txt'), 'salvage modification\n')

    await autoCommitWorktreeIfDeterministic({
      taskId: 'committer-task',
      provenance: 'committer-salvage',
      integrationBranch: 'release/2026-08',
      worktreePath: repo,
      dirtyFiles: ['tracked.txt'],
    })

    const salvageMessage = execSync('git log -1 --format=%B', { cwd: repo }).toString()
    expect(salvageMessage).toContain('release/2026-08')
    expect(salvageMessage.toLowerCase()).not.toContain('coder')
    expect(salvageMessage).not.toContain('code step')
    expect(salvageMessage).toContain('Authorship is unknown')
  })

  // ── Branch-safety guard (2026-08-05 incident) ───────────────────────────

  it('returns committed:false with refusal main-branch when HEAD is main', async () => {
    // HEAD is `main` — the exact scenario that produced commit 93addc75.
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'task-abc',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['work.ts'],
    })

    expect(result).toMatchObject({ committed: false, refusal: 'main-branch' })
    expect((result as { reason: string }).reason).toContain('integration branch')
    expect((result as { reason: string }).reason).toContain('main')
    // Nothing was staged or committed — HEAD is still the init commit.
    const status = execSync('git status --porcelain', { cwd: repo }).toString().trim()
    expect(status).toContain('work.ts') // still untracked
  })

  it('returns committed:false with refusal wrong-branch when HEAD is a non-task branch', async () => {
    execFileSync('git', ['checkout', '-q', '-b', 'preserve/orphaned-branch'], { cwd: repo })
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'task-abc',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['work.ts'],
    })

    expect(result).toMatchObject({ committed: false, refusal: 'wrong-branch' })
    expect((result as { reason: string }).reason).toContain('preserve/orphaned-branch')
    expect((result as { reason: string }).reason).toContain('task/task-abc')
  })

  it('succeeds when HEAD is the correct task/<taskId> branch', async () => {
    checkoutTaskBranch(repo, 'task-xyz')
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')

    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'task-xyz',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['work.ts'],
    })

    expect(result).toMatchObject({ committed: true, sha: expect.any(String) })
  })

  // ── 2026-08-17 incident: untracked build artifacts on main ──────────────

  it('committer-salvage: refuses untracked dist-* directory files (checkSecretPath guard)', async () => {
    // Reproduce the 2026-08-17 incident: an operator built `app/dist-demo/`
    // as an untracked directory. The salvage path must never commit it.
    checkoutTaskBranch(repo, 'salvage-task')
    mkdirSync(resolve(repo, 'app', 'dist-demo'), { recursive: true })
    writeFileSync(resolve(repo, 'app', 'dist-demo', 'bundle.js'), 'built output\n')
    writeFileSync(resolve(repo, 'app', 'dist-demo', 'style.css'), 'body{}\n')

    // Both files are untracked — git status --porcelain would show "?? app/dist-demo/bundle.js"
    // The salvage chore would receive them as dirtyFiles.
    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'salvage-task',
      provenance: 'committer-salvage',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['app/dist-demo/bundle.js', 'app/dist-demo/style.css'],
    })

    expect(result).toMatchObject({ committed: false, refusal: 'unsafe-path' })
    expect((result as { reason: string }).reason).toContain('app/dist-demo/bundle.js')
    expect((result as { reason: string }).reason).toContain('generated-output directory')

    // Nothing was committed — HEAD is still the initial commit.
    const treeFiles = headCommitTree(repo)
    expect(treeFiles).not.toContain('app/dist-demo/bundle.js')
    expect(treeFiles).not.toContain('app/dist-demo/style.css')
  })

  it('committer-salvage: untracked non-output files are also excluded (git add -u)', async () => {
    // Even when files are not in a generated-output directory, committer-salvage
    // must not pick up untracked files (operator scratch work, etc.). `git add -u`
    // stages only tracked modifications, so untracked files never land.
    checkoutTaskBranch(repo, 'salvage-untracked')

    // Modify the tracked file so there IS something to commit.
    writeFileSync(resolve(repo, 'tracked.txt'), 'tracked modification\n')
    // Drop an untracked scratch file that is NOT in a generated-output dir.
    writeFileSync(resolve(repo, 'scratch-notes.txt'), 'operator notes\n')

    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'salvage-untracked',
      provenance: 'committer-salvage',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['tracked.txt', 'scratch-notes.txt'],
    })

    // The tracked modification lands; the untracked scratch file does not.
    expect(result).toMatchObject({ committed: true, sha: expect.any(String) })
    const committed = headCommitFiles(repo)
    expect(committed).toContain('tracked.txt')
    expect(committed).not.toContain('scratch-notes.txt')
  })

  // ── DEC-15: node_modules/ partition (the all-or-nothing guard regression) ─

  it('coder-left-dirty: commits safe files only when node_modules/ paths are also dirty', async () => {
    // Reproduces the DEC-15 failure: a TypeScript gate task installed
    // `node_modules/` alongside four legitimate work files. The old guard
    // refused the whole commit on the first node_modules/ hit; the partition
    // commits the four real files and excludes the dependency tree.
    checkoutTaskBranch(repo, 'gate-task')

    // The four gate files the coder produced.
    writeFileSync(resolve(repo, 'package.json'), '{"devDependencies":{"typescript":"^5"}}\n')
    writeFileSync(resolve(repo, '.gitignore'), 'node_modules/\n')
    writeFileSync(resolve(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
    writeFileSync(resolve(repo, 'tsconfig.json'), '{"compilerOptions":{}}\n')
    // Simulate a node_modules/ subtree (a handful of representative paths).
    mkdirSync(resolve(repo, 'node_modules', 'typescript', 'lib'), { recursive: true })
    writeFileSync(resolve(repo, 'node_modules', 'typescript', 'lib', 'typescript.js'), '/* ts */\n')
    writeFileSync(resolve(repo, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript"}\n')

    const dirtyFiles = [
      'package.json',
      '.gitignore',
      'package-lock.json',
      'tsconfig.json',
      'node_modules/typescript/lib/typescript.js',
      'node_modules/typescript/package.json',
    ]

    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'gate-task',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles,
    })

    // The four gate files landed; node_modules/ paths did not.
    expect(result).toMatchObject({ committed: true, sha: expect.any(String) })
    const tree = headCommitTree(repo)
    expect(tree).toContain('package.json')
    expect(tree).toContain('.gitignore')
    expect(tree).toContain('package-lock.json')
    expect(tree).toContain('tsconfig.json')
    expect(tree.some((p) => p.startsWith('node_modules/'))).toBe(false)

    // Commit body names the excluded paths (operator transparency).
    const commitMsg = execSync('git log -1 --format=%B', { cwd: repo }).toString()
    expect(commitMsg).toContain('Excluded')
    expect(commitMsg).toContain('dependency directory')
  })

  it('coder-left-dirty: refuses outright when every dirty file is in node_modules/', async () => {
    // All dirty files are unsafe — nothing safe to land. The refusal is
    // unchanged from the old behaviour (committed:false, refusal:unsafe-path).
    checkoutTaskBranch(repo, 'nm-only-task')
    mkdirSync(resolve(repo, 'node_modules', 'lodash'), { recursive: true })
    writeFileSync(resolve(repo, 'node_modules', 'lodash', 'index.js'), 'module.exports={}\n')

    const result = await autoCommitWorktreeIfDeterministic({
      taskId: 'nm-only-task',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['node_modules/lodash/index.js'],
    })

    expect(result).toMatchObject({ committed: false, refusal: 'unsafe-path' })
    expect((result as { reason: string }).reason).toContain('unsafe')
    // Nothing was committed — HEAD is still the initial commit.
    expect(headCommitTree(repo)).not.toContain('node_modules/lodash/index.js')
  })
})
