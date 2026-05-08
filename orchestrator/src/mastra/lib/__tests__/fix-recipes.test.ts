import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getRecipe, recipes } from '../fix-recipes'

describe('fix-recipes', () => {
  describe('dirty_merge_target recipe', () => {
    const ctx = {
      targetPath: '/tmp/main-checkout',
      statusOutput: ' M src/foo.ts\n?? new-file.txt\n',
      targetBranch: 'main',
    }

    it('produces stable title for stable input', () => {
      const recipe = getRecipe('dirty_merge_target')
      expect(recipe.title(ctx)).toBe(
        'Resolve dirty changes blocking merge into main',
      )
    })

    it('produces stable prompt for stable input (snapshot)', () => {
      const recipe = getRecipe('dirty_merge_target')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatchInlineSnapshot(`
"The merge target at /tmp/main-checkout has uncommitted changes that block a fast-forward merge. Inspect each modified or untracked file:
 (a) commit files that represent intentional work with a meaningful commit message that describes the actual changes;
 (b) discard files that are clearly transient (build artifacts, .DS_Store, editor swap files, anything in .gitignore that slipped in via \`git add -f\` etc.);
 (c) for anything ambiguous, do NOT guess — emit a high-priority inbox notification listing the file(s) and what's unclear, and exit.

Do not push. Save your work.

Merge target path: /tmp/main-checkout
Merge target branch: main

\`git status --porcelain\` output:
\`\`\`
 M src/foo.ts
?? new-file.txt

\`\`\`

If you need to file an inbox notification, create a row in .mars/queue.db inbox_items table with priority='high' and a clear message describing the ambiguous file(s)."
`)
    })

    it('includes targetPath, status output and verbatim instructions', () => {
      const recipe = getRecipe('dirty_merge_target')
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
  })

  describe('worktree_install_failed recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktree/orchestrator',
      statusOutput: 'ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen lockfile\n',
      targetBranch: 'task/abc123',
    }

    it('produces a stable title', () => {
      const recipe = getRecipe('worktree_install_failed')
      expect(recipe.title(ctx)).toBe(
        'Resolve dependency install failure in worktree setup',
      )
    })

    it('embeds the failing path, branch, and install error into the prompt', () => {
      const recipe = getRecipe('worktree_install_failed')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.statusOutput.trim())
      expect(prompt).toContain('TS2688')
      expect(prompt).toContain('lockfile drift')
      expect(prompt).toContain('Save your work')
    })
  })

  describe('getRecipe', () => {
    it('throws on unknown signature', () => {
      expect(() => getRecipe('does_not_exist')).toThrow(
        /Unknown fix recipe signature/,
      )
    })

    it('returns the registered recipe by signature', () => {
      const recipe = getRecipe('dirty_merge_target')
      expect(recipe.signature).toBe('dirty_merge_target')
      expect(recipes.dirty_merge_target).toBe(recipe)
    })
  })
})

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface FixModule {
  handleTaskFailure: typeof import('../../queue-fix-suggestions').handleTaskFailure
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-recipe-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; fix: FixModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  delete process.env.MARS_FIX_RETRY_BUDGET
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const fix = (await import(
    '../../queue-fix-suggestions'
  )) as unknown as FixModule
  return { q, fix }
}

describe('handleTaskFailure with recipeSignature', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('dirty_merge_target signature creates a suggestion using the canned recipe', async () => {
    const { q, fix } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const statusOutput = ' M src/foo.ts\n?? leftover.tmp\n'
    const result = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'merge:preflight',
      errorOutput: statusOutput,
      branch: 'task/abc',
      recipeSignature: 'dirty_merge_target',
      recipeContext: {
        targetPath: resolve(repo),
        statusOutput,
        targetBranch: 'main',
      },
    })
    expect(result.outcome).toBe('blocked')
    expect(result.failureSignature).toBe('dirty_merge_target')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.blockerId).toBe(result.suggestionId)

    const r = await q.getClient().execute({
      sql: `SELECT title, prompt FROM task_suggestions WHERE id = ?`,
      args: [result.suggestionId ?? ''],
    })
    const row = r.rows[0] as unknown as { title: string; prompt: string }
    expect(row.title).toBe('Resolve dirty changes blocking merge into main')
    expect(row.prompt).toContain('leftover.tmp')
    expect(row.prompt).toContain('high-priority inbox notification')
  })
})
