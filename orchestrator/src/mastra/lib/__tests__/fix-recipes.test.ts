import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getRecipe, hasRecipe, recipes } from '../fix-recipes'

describe('fix-recipes', () => {
  describe('merge:preflight/uncommitted-changes recipe', () => {
    const ctx = {
      targetPath: '/tmp/main-checkout',
      statusOutput: ' M src/foo.ts\n?? new-file.txt\n',
      targetBranch: 'main',
      originalPrompt: '',
    }

    it('produces stable title for stable input', () => {
      const recipe = getRecipe('merge:preflight/uncommitted-changes')
      expect(recipe.title(ctx)).toBe(
        'Resolve dirty changes blocking merge into main',
      )
    })

    it('produces stable prompt for stable input (snapshot)', () => {
      const recipe = getRecipe('merge:preflight/uncommitted-changes')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatchInlineSnapshot(`
        "The merge target at /tmp/main-checkout appeared dirty when merge pre-flight ran, blocking a fast-forward merge into main. By the time you read this another task may already have cleaned it up.

        STEP 1 — re-check first. Run \`git -C /tmp/main-checkout status --porcelain\` right now.
         - If the output is empty, the tree is already clean: do NOT touch any file, do NOT commit, do NOT emit an inbox notification. Exit successfully — the original task can be retried as-is.
         - If the output is non-empty, proceed to STEP 2 with the CURRENT status, not the snapshot below.

        STEP 2 — only if STEP 1 still shows a dirty tree. Inspect each modified or untracked file:
         (a) commit files that represent intentional work with a meaningful commit message that describes the actual changes;
         (b) discard files that are clearly transient (build artifacts, .DS_Store, editor swap files, anything in .gitignore that slipped in via \`git add -f\` etc.);
         (c) for anything ambiguous, do NOT guess — emit a high-priority inbox notification listing the file(s) and what's unclear, and exit.

        Do not push. Save your work.

        Merge target path: /tmp/main-checkout
        Merge target branch: main

        Original \`git status --porcelain\` output captured at failure time (may be stale — re-check before acting):
        \`\`\`
         M src/foo.ts
        ?? new-file.txt

        \`\`\`

        If you need to file an inbox notification, use \`mars inbox raise --from -\` with priority='high' and a clear message describing the ambiguous file(s)."
      `)
    })

    it('includes targetPath, status output and verbatim instructions', () => {
      const recipe = getRecipe('merge:preflight/uncommitted-changes')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain(ctx.statusOutput.trim())
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(
        'commit files that represent intentional work with a meaningful commit message',
      )
      expect(prompt).toContain('discard files that are clearly transient')
      expect(prompt).toContain('do NOT guess')
      expect(prompt).toContain('high-priority inbox notification')
      expect(prompt).toContain('Do not push. Save your work.')
    })

    it('instructs the agent to re-check git status first and no-op if clean', () => {
      const recipe = getRecipe('merge:preflight/uncommitted-changes')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(
        `git -C ${ctx.targetPath} status --porcelain`,
      )
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain(
        'If the output is empty, the tree is already clean',
      )
      expect(prompt).toMatch(/Exit successfully/i)
      expect(prompt).toContain('may be stale')
    })
  })

  describe('setup:install/install-frozen-lockfile recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktree/orchestrator',
      statusOutput: 'ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen lockfile\n',
      targetBranch: 'task/abc123',
      originalPrompt: '',
    }

    it('produces a stable title', () => {
      const recipe = getRecipe('setup:install/install-frozen-lockfile')
      expect(recipe.title(ctx)).toBe(
        'Resolve dependency install failure in worktree setup',
      )
    })

    it('embeds the failing path, branch, and install error into the prompt', () => {
      const recipe = getRecipe('setup:install/install-frozen-lockfile')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.statusOutput.trim())
      expect(prompt).toContain('TS2688')
      expect(prompt).toContain('lockfile drift')
      expect(prompt).toContain('Save your work')
    })
  })

  describe('verify:has-diff/no-commits-ahead recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktree/abc',
      statusOutput: 'branch task/abc has 0 commits ahead of main',
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      expect(recipe.title(ctx)).toBe(
        'Re-do the original task and commit your work (failing branch task/abc)',
      )
    })

    it('counts via `git rev-list --count integration..HEAD` against the recovery cwd, not the failing worktree', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(
        `git rev-list --count ${ctx.integrationBranch}..HEAD`,
      )
      // The old form pointed `git -C <failing worktree>` at the failing
      // branch and either fatalled (worktree gone) or led the agent to
      // edit the wrong tree. Lock the new form in.
      expect(prompt).not.toContain(`git -C ${ctx.targetPath} rev-list`)
      expect(prompt).not.toContain(
        `rev-list --count ${ctx.integrationBranch}..${ctx.targetBranch}`,
      )
    })

    it('does NOT use the broken `git log task ^task~` primitive that printed integration tip commits', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).not.toContain(`^${ctx.targetBranch}~`)
      expect(prompt).not.toContain(`git log -n 5 --oneline`)
    })

    it('gates the exit-successfully escape hatch on the rev-list integer being non-zero', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      // The string "exit successfully" must only appear inside the
      // non-zero / false-positive branch, never as an unconditional
      // escape hatch.
      const exitOccurrences = prompt.match(/exit successfully/gi) ?? []
      expect(exitOccurrences.length).toBeGreaterThan(0)
      const nonZeroLine = prompt
        .split('\n')
        .find((line) => /exit successfully/i.test(line))
      expect(nonZeroLine).toMatch(/non-zero/i)
    })

    it('instructs the agent to re-do and commit the work when the branch is empty', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('STEP 2')
      expect(prompt).toMatch(/commit immediately/i)
      expect(prompt).toContain('git add -A && git commit')
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.integrationBranch)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain('Save your work')
    })

    it('orders the commit before any further refinement', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      // The commit step must come BEFORE the iterate/refine step so the
      // recovery agent cannot burn its budget on refactors and tests
      // first and then exit empty-handed.
      const commitIdx = prompt.indexOf('Commit immediately')
      const iterateIdx = prompt.search(/may you iterate/i)
      expect(commitIdx).toBeGreaterThan(0)
      expect(iterateIdx).toBeGreaterThan(commitIdx)
    })

    it('shows a concrete minimal-commit example (stub + TODO)', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/Example of an acceptable minimal first commit/i)
      expect(prompt).toMatch(/TODO/)
      expect(prompt).toMatch(/stub/i)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/queue.db spelunking', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'rename foo to bar in src/baz.ts',
      })
      expect(promptWithSource).toContain('rename foo to bar in src/baz.ts')
      expect(promptWithSource).toMatch(/inlined/i)
      // Without it, no inlined section and no leftover marker.
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain('rename foo to bar in src/baz.ts')
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('instructs the agent to inspect the failing worktree read-only and lift its diff when present', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      // The most common failure mode is staged-but-uncommitted work in the
      // failing worktree. Recovery should prefer lifting that diff over
      // re-doing from scratch — but read-only against the failing tree.
      expect(prompt).toContain(`git -C ${ctx.targetPath} status --short`)
      expect(prompt).toContain(`git -C ${ctx.targetPath} diff HEAD`)
      expect(prompt).toMatch(/git apply/i)
      expect(prompt).toMatch(/lift the existing diff/i)
    })

    it('warns the agent NOT to edit the failing task worktree', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt(ctx)
      // Regression: the previous recipe pointed `Worktree: <failing>` and
      // the agent obediently edited there, leaving the recovery branch
      // empty. The new prompt must explicitly warn off that path.
      expect(prompt).toMatch(/do not edit/i)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toMatch(/FRESH recovery worktree/i)
    })

    it('falls back to `main` when integrationBranch is absent from the context', () => {
      const recipe = getRecipe('verify:has-diff/no-commits-ahead')
      const prompt = recipe.buildPrompt({
        targetPath: ctx.targetPath,
        statusOutput: ctx.statusOutput,
        targetBranch: ctx.targetBranch,
        originalPrompt: '',
      })
      expect(prompt).toContain(`git rev-list --count main..HEAD`)
    })
  })

  describe('getRecipe', () => {
    it('throws on unknown signature', () => {
      expect(() => getRecipe('does_not_exist')).toThrow(
        /Unknown fix recipe signature/,
      )
    })

    it('returns the registered recipe by signature', () => {
      const recipe = getRecipe('merge:preflight/uncommitted-changes')
      expect(recipe.signature).toBe('merge:preflight/uncommitted-changes')
      expect(recipes['merge:preflight/uncommitted-changes']).toBe(recipe)
    })
  })

  describe('intentionally absent recipes (documented investigation outcomes)', () => {
    it('merge:crashed/index-lock-contention has no recipe — environmental transient failure; operator restarts with `mars restart`', () => {
      // Investigated 2026-05-18 (task 5c15a8e1). Root cause: git checkout main
      // crashed because .git/index.lock existed (stale or concurrent process).
      // Task coding work was already committed on branch task/mars-cea7a89f.
      // A recipe that deletes index.lock is dangerous (may be held by an active
      // process). Operator fix: confirm no active git process, then mars restart.
      expect(hasRecipe('merge:crashed/index-lock-contention')).toBe(false)
    })

    it('merge:vcs-supervisor-aborted/index-lock-contention has no recipe — same environmental transient failure via a different code path', () => {
      // Investigated 2026-05-18 (task mars-6348aec4). Root cause: vcs-supervisor
      // ran `git merge --ff-only task/mars-6348aec4` and got "Unable to create
      // .git/index.lock: File exists", causing aborted=true. The task's coding
      // work was already committed (commit 31933fe on task/mars-6348aec4).
      // The lock was gone by the time the investigator ran — confirming transient.
      // A recipe that deletes index.lock is dangerous (may be held by an active
      // process). Operator fix: confirm no active git process, then mars restart.
      expect(hasRecipe('merge:vcs-supervisor-aborted/index-lock-contention')).toBe(false)
    })
  })
})

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface FixTaskModule {
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-recipe-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTaskModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  delete process.env.MARS_FIX_RETRY_BUDGET
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const ft = (await import(
    '../../queue-fix-tasks'
  )) as unknown as FixTaskModule
  return { q, ft }
}

describe('handleTaskFailureWithFixTask routes to a registered recipe by signature', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('flows the original task prompt into the recovery recipe output so the agent does not need to re-fetch it from .mars/queue.db', async () => {
    const { q, ft } = await loadModules(repo)
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const originalPrompt =
      'rename oldName to newName in orchestrator/src/foo.ts'
    const t = await q.enqueueTask(originalPrompt, undefined, {
      skipTriage: true,
    })
    const result = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:has-diff',
      // Signature 'verify:has-diff/no-commits-ahead' is keyed on this
      // canonical lead from git.ts:807 (checkBranchHasDiff).
      errorOutput: `no commits ahead of integration branch — task did not produce any changes\nbranch task/${t.id} has 0 commits ahead of main`,
      branch: `task/${t.id}`,
      recipeContext: {
        targetPath: resolve(repo, '.mars/worktrees', t.id),
        statusOutput: '',
        targetBranch: `task/${t.id}`,
        integrationBranch: 'main',
        // Deliberately leave originalPrompt empty: the handler must
        // backfill it from the source task row, not require callers
        // to thread it through manually.
        originalPrompt: '',
      },
    })
    expect(result.outcome).toBe('blocked')
    expect(result.failureSignature).toBe('verify:has-diff/no-commits-ahead')

    const r = await q.getClient().execute({
      sql: `SELECT prompt FROM tasks WHERE id = ?`,
      args: [result.fixTaskId ?? ''],
    })
    const row = r.rows[0] as unknown as { prompt: string }
    expect(row.prompt).toContain(originalPrompt)
    expect(row.prompt).toMatch(/Original task prompt \(inlined/i)
  })

  it('an error matching the merge:preflight/uncommitted-changes classifier produces a fix-task using the canned recipe', async () => {
    const { q, ft } = await loadModules(repo)
    // Default retry budget is 0 (every failure drops); this test exercises
    // the recipe-routing path, which only fires when a retry is allowed.
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const statusOutput = ' M src/foo.ts\n?? leftover.tmp\n'
    const result = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'merge:preflight',
      // Classifier-friendly lead line; raw porcelain via recipeContext.
      errorOutput: `merge target ${resolve(repo)} has uncommitted changes blocking fast-forward\n${statusOutput}`,
      branch: 'task/abc',
      recipeContext: {
        targetPath: resolve(repo),
        statusOutput,
        targetBranch: 'main',
        originalPrompt: '',
      },
    })
    expect(result.outcome).toBe('blocked')
    expect(result.failureSignature).toBe(
      'merge:preflight/uncommitted-changes',
    )

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')

    const r = await q.getClient().execute({
      sql: `SELECT prompt FROM tasks WHERE id = ?`,
      args: [result.fixTaskId ?? ''],
    })
    const row = r.rows[0] as unknown as { prompt: string }
    expect(row.prompt).toContain('leftover.tmp')
    expect(row.prompt).toContain('high-priority inbox notification')
  })
})
