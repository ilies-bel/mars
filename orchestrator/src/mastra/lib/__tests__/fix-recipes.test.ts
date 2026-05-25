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

  describe('setup:preflight/dirty-main recipe', () => {
    const ctx = {
      targetPath: '/tmp/main-checkout',
      statusOutput: ' M orchestrator/src/foo.ts\n?? new-file.txt\n',
      targetBranch: 'main',
      originalPrompt: '',
    }

    it('is registered and marked shared (one recovery, many edges)', () => {
      expect(hasRecipe('setup:preflight/dirty-main')).toBe(true)
      expect(getRecipe('setup:preflight/dirty-main').shared).toBe(true)
    })

    it('produces a stable title naming the merge target', () => {
      const recipe = getRecipe('setup:preflight/dirty-main')
      expect(recipe.title(ctx)).toBe(
        'Auto-commit dirty changes on main blocking task setup',
      )
    })

    it('auto-commits via git -C on the merge target without judgement', () => {
      const recipe = getRecipe('setup:preflight/dirty-main')
      const prompt = recipe.buildPrompt(ctx)
      // Operates on the merge target directly, never a worktree, never cd.
      expect(prompt).toContain(`git -C ${ctx.targetPath} add -A`)
      expect(prompt).toContain(`git -C ${ctx.targetPath} commit`)
      expect(prompt).toContain(`git -C ${ctx.targetPath} status --porcelain`)
      expect(prompt).toMatch(/Do NOT `cd`/)
      // Auto-commit, not the triage/discard judgement of the merge-time recipe.
      expect(prompt).toContain('auto-commits without judgement')
      expect(prompt).not.toContain('discard files that are clearly transient')
      // No push; commit lands on the merge target branch in place.
      expect(prompt).toContain('Do NOT push')
      expect(prompt).toContain(ctx.statusOutput.trim())
    })

    it('re-checks first and no-ops if the tree is already clean', () => {
      const recipe = getRecipe('setup:preflight/dirty-main')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('STEP 1')
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

    describe('Path B placeholder commit', () => {
      it('git commit --allow-empty with placeholder message appears before any read/explore instruction in Path B', () => {
        const recipe = getRecipe('verify:has-diff/no-commits-ahead')
        const prompt = recipe.buildPrompt(ctx)
        const pathBIdx = prompt.indexOf('Path B')
        expect(pathBIdx).toBeGreaterThan(-1)

        // The empty commit must appear in the Path B section
        const emptyCommitIdx = prompt.indexOf('git commit --allow-empty', pathBIdx)
        expect(emptyCommitIdx).toBeGreaterThan(pathBIdx)

        // The placeholder commit message must reference the failing branch/task
        expect(prompt).toContain(`recover: placeholder for ${ctx.targetBranch}`)

        // The empty commit must appear BEFORE the "Read the Original task prompt" instruction
        const readOriginalIdx = prompt.indexOf('Read the **Original task prompt**', pathBIdx)
        expect(readOriginalIdx).toBeGreaterThan(emptyCommitIdx)
      })

      it('Path B section explicitly forbids Read, Grep, or Bash calls before the placeholder commit', () => {
        const recipe = getRecipe('verify:has-diff/no-commits-ahead')
        const prompt = recipe.buildPrompt(ctx)
        const pathBIdx = prompt.indexOf('Path B')
        const emptyCommitIdx = prompt.indexOf('git commit --allow-empty', pathBIdx)

        // The prohibition must appear in Path B before (or around) the empty commit step
        const sectionAroundPlaceholder = prompt.slice(pathBIdx, emptyCommitIdx + 200)
        expect(sectionAroundPlaceholder).toMatch(
          /do not run.*read.*grep.*bash|no.*read.*grep.*bash|before.*any.*read|without.*any.*read/i,
        )
      })

      it('Path B section instructs the agent to re-run the rev-list assertion immediately after the placeholder commit', () => {
        const recipe = getRecipe('verify:has-diff/no-commits-ahead')
        const prompt = recipe.buildPrompt(ctx)
        const pathBIdx = prompt.indexOf('Path B')
        const emptyCommitIdx = prompt.indexOf('git commit --allow-empty', pathBIdx)

        // There must be a rev-list check AFTER the placeholder commit in Path B
        const revListAfterIdx = prompt.indexOf('git rev-list --count', emptyCommitIdx)
        expect(revListAfterIdx).toBeGreaterThan(emptyCommitIdx)
      })

      it('Path B section permits amending the placeholder commit message or adding follow-up commits', () => {
        const recipe = getRecipe('verify:has-diff/no-commits-ahead')
        const prompt = recipe.buildPrompt(ctx)
        const pathBIdx = prompt.indexOf('Path B')
        const pathBSection = prompt.slice(pathBIdx)

        expect(pathBSection).toMatch(/amend.*placeholder|follow-up commit|--amend/i)
      })

      it('Path A section does not contain git commit --allow-empty', () => {
        const recipe = getRecipe('verify:has-diff/no-commits-ahead')
        const prompt = recipe.buildPrompt(ctx)
        const pathAIdx = prompt.indexOf('Path A')
        const pathBIdx = prompt.indexOf('Path B')
        expect(pathAIdx).toBeGreaterThan(-1)

        // Extract only the Path A section (between Path A and Path B markers)
        const pathASection = prompt.slice(pathAIdx, pathBIdx)
        expect(pathASection).not.toContain('git commit --allow-empty')
      })
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

  describe('verify:test/test-assertion-error recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        'FAIL  src/cli/__tests__/ui.test.ts > stopUi > exits 0\nAssertionError: expected [ \'no ui running\' ] to include \'no mars ui running\'\n',
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('produces a stable title that names the failing branch', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      expect(recipe.title(ctx)).toBe(
        'Fix failing test assertions in task/abc',
      )
    })

    it('embeds the failing path, branch, integration branch, and test output', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.integrationBranch)
      expect(prompt).toContain('AssertionError')
      expect(prompt).toContain('Save your work')
    })

    it('instructs the agent NOT to modify test files', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/do not modify test files/i)
    })

    it('lists common causes including wrong string literal and missing process.exit', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/wrong string literal/i)
      expect(prompt).toMatch(/missing.*process\.exit/i)
    })

    it('gates the exit-successfully escape hatch on a non-zero rev-list count', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      const exitLine = prompt
        .split('\n')
        .find((line) => /exit successfully/i.test(line))
      expect(exitLine).toBeDefined()
      expect(exitLine).toMatch(/non-zero/i)
    })

    it('instructs the recovery agent to read from the failing worktree using git -C and never edit there', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(`git -C ${ctx.targetPath} diff`)
      expect(prompt).toMatch(/do not edit/i)
      expect(prompt).toMatch(/FRESH recovery worktree/i)
      expect(prompt).toMatch(/never edit there/i)
    })

    it('orders commit-immediately before fixing assertions', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      const commitIdx = prompt.search(/commit immediately/i)
      const step3Idx = prompt.search(/STEP 3/i)
      expect(commitIdx).toBeGreaterThan(0)
      expect(step3Idx).toBeGreaterThan(commitIdx)
    })

    it('uses git apply to land the lifted diff in the recovery worktree', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/git apply/i)
      expect(prompt).toContain('git add -A && git commit')
    })

    it('falls back to `main` when integrationBranch is absent', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const prompt = recipe.buildPrompt({
        targetPath: ctx.targetPath,
        statusOutput: ctx.statusOutput,
        targetBranch: ctx.targetBranch,
        originalPrompt: '',
      })
      expect(prompt).toContain('git rev-list --count main..HEAD')
    })

    it('inlines the original task prompt when provided', () => {
      const recipe = getRecipe('verify:test/test-assertion-error')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'add mars ui stop subcommand in src/cli/ui-stop.ts',
      })
      expect(promptWithSource).toContain(
        'add mars ui stop subcommand in src/cli/ui-stop.ts',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'add mars ui stop subcommand in src/cli/ui-stop.ts',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })
  })

  describe('verify:test/test-libsql-no-such-table recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-mars-9a654a2e',
      statusOutput: [
        ' × src/bus/__tests__/publisher.test.ts > publishWithRetry > two concurrent publishWithRetry calls both commit',
        'LibsqlError: SQLITE_ERROR: no such table: events',
        'Caused by: SqliteError: no such table: events',
      ].join('\n'),
      targetBranch: 'task/mars-9a654a2e',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      expect(recipe.title(ctx)).toBe(
        'Fix libsql concurrent-transaction test failure (no such table — switch to file-based DB)',
      )
    })

    it('embeds the failing path, branch, integration branch, and captured failure output', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.integrationBranch)
      expect(prompt).toContain('no such table: events')
      expect(prompt).toContain('Save your work')
    })

    it('explains the root cause: libsql detaches the connection on each transaction call', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/this\.#db = null/i)
      expect(prompt).toMatch(/in-memory/i)
      expect(prompt).toMatch(/:memory:/i)
    })

    it('instructs the agent to replace :memory: with a temp file URL', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(`createClient({ url: ':memory:' })`)
      expect(prompt).toContain('file:${dbPath}')
      expect(prompt).toContain('mkdtempSync')
      expect(prompt).toContain('rmSync')
    })

    it('instructs the recovery agent to lift the diff from the failing worktree using git -C', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(`git -C ${ctx.targetPath} diff`)
      expect(prompt).toMatch(/never edit there/i)
      expect(prompt).toMatch(/FRESH recovery worktree/i)
    })

    it('gates the false-positive escape hatch on a non-zero rev-list count', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('git rev-list --count main..HEAD')
      const exitLine = prompt
        .split('\n')
        .find((line) => /exit successfully/i.test(line))
      expect(exitLine).toBeDefined()
      expect(exitLine).toMatch(/non-zero/i)
    })

    it('falls back to `main` when integrationBranch is absent', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt({
        targetPath: ctx.targetPath,
        statusOutput: ctx.statusOutput,
        targetBranch: ctx.targetBranch,
        originalPrompt: '',
      })
      expect(prompt).toContain('git rev-list --count main..HEAD')
    })

    it('instructs the agent NOT to change production code', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/do not change production code/i)
    })

    it('inlines the original task prompt when provided', () => {
      const recipe = getRecipe('verify:test/test-libsql-no-such-table')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt:
          'add publishWithRetry helper in src/bus/publisher.ts with concurrent-writers test',
      })
      expect(promptWithSource).toContain(
        'add publishWithRetry helper in src/bus/publisher.ts with concurrent-writers test',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'add publishWithRetry helper in src/bus/publisher.ts with concurrent-writers test',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
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

  describe('merge:vcs-supervisor-aborted/not-fast-forward recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput: '',
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('produces a stable title that names the branch and integration branch', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      expect(recipe.title(ctx)).toBe(
        'Re-land task/abc onto current main (diverged after VCS supervisor rebased)',
      )
    })

    it('falls back to `main` when integrationBranch is absent', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt({
        targetPath: ctx.targetPath,
        statusOutput: ctx.statusOutput,
        targetBranch: ctx.targetBranch,
        originalPrompt: '',
      })
      expect(prompt).toContain('git rev-list --count main..HEAD')
    })

    it('embeds the failing path, branch, integration branch, and key instructions', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetPath)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.integrationBranch)
      expect(prompt).toContain('Save your work')
    })

    it('instructs the recovery agent to read from the failing worktree using git -C and never edit there', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(`git -C ${ctx.targetPath} log`)
      expect(prompt).toContain(`git -C ${ctx.targetPath} diff`)
      expect(prompt).toMatch(/do not edit/i)
      expect(prompt).toMatch(/FRESH recovery worktree/i)
      expect(prompt).toMatch(/never edit there/i)
    })

    it('gates the exit-successfully escape hatch on a non-zero rev-list count', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      const exitLine = prompt
        .split('\n')
        .find((line) => /exit successfully/i.test(line))
      expect(exitLine).toBeDefined()
      expect(exitLine).toMatch(/non-zero/i)
    })

    it('orders the commit-immediately step before the iterate step', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      const commitIdx = prompt.search(/commit immediately/i)
      const iterateIdx = prompt.search(/may you iterate/i)
      expect(commitIdx).toBeGreaterThan(0)
      expect(iterateIdx).toBeGreaterThan(commitIdx)
    })

    it('uses git apply to land the diff in the recovery worktree', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/git apply/i)
      expect(prompt).toContain('git add -A && git commit')
    })

    it('inlines the original task prompt when provided', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'add the nudge link in TodoPage.tsx',
      })
      expect(promptWithSource).toContain('add the nudge link in TodoPage.tsx')
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain('add the nudge link in TodoPage.tsx')
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })
  })

  describe('verify:typecheck/typecheck-excess-property recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        "src/mastra/lib/__tests__/reflector.test.ts(40,9): error TS2353: Object literal may only specify known properties, and 'totalCostUsd' does not exist in type '{ inputTokens: number; outputTokens: number; cacheCreateTokens: number; cacheReadTokens: number; cacheHitRatio: number; }'.\nCommand failed: npx tsc --noEmit\n",
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('is registered under the correct signature', () => {
      expect(hasRecipe('verify:typecheck/typecheck-excess-property')).toBe(true)
    })

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      expect(recipe.title(ctx)).toBe(
        'Remove excess property(ies) from object literals to resolve TS2353 typecheck failure',
      )
    })

    it('prompt contains TS2353, step instructions, and constraint against reverting the type', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS2353')
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      expect(prompt).toContain('STEP 3')
      expect(prompt).toMatch(/do NOT revert the type change/i)
      expect(prompt).toMatch(/do NOT add.*@ts-ignore/i)
      expect(prompt).toContain('Save your work')
    })

    it('explains the canonical cause — partial type cleanup where the implementation was updated but object literals were not', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/partial type cleanup/i)
      expect(prompt).toMatch(/object literal/i)
      expect(prompt).toMatch(/intentional/i)
    })

    it('instructs the agent to remove the excess property from ALL object literals that include it, not just the first TS error site', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/all of them|ALL of them/i)
    })

    it('mentions shared fixtures (emptySummary pattern) to help the agent find less-obvious removal sites', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/emptySummary|shared.*fixture|fixture.*shared/i)
    })

    it('embeds the failing branch and worktree path', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.targetPath)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/queue.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt:
          'remove totalCostUsd from reflect-query aggregation so callers receive token totals only',
      })
      expect(promptWithSource).toContain(
        'remove totalCostUsd from reflect-query aggregation so callers receive token totals only',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'remove totalCostUsd from reflect-query aggregation so callers receive token totals only',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('instructs the agent to run vitest after typecheck is clean, to catch assertion-level regressions', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/npx vitest run/i)
    })
  })

  describe('verify:typecheck/typecheck-property-not-exist recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        "src/mastra/lib/deep-reflect-query.ts(169,21): error TS2339: Property 'totalCostUsd' does not exist on type 'TaskSignalRow'.\nCommand failed: npx tsc --noEmit\n",
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('is registered under the correct signature', () => {
      expect(hasRecipe('verify:typecheck/typecheck-property-not-exist')).toBe(true)
    })

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      expect(recipe.title(ctx)).toBe(
        'Fix property-does-not-exist error(s) to resolve TS2339/TS2353 typecheck failure',
      )
    })

    it('prompt contains TS2339 and TS2353, step instructions, and constraint against ts-ignore', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS2339')
      expect(prompt).toContain('TS2353')
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      expect(prompt).toContain('STEP 3')
      expect(prompt).toMatch(/do NOT add.*@ts-ignore/i)
      expect(prompt).toContain('Save your work')
    })

    it('describes the incomplete-refactoring (deletion) path so the agent completes removals rather than re-adding the field', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/incomplete refactoring/i)
      expect(prompt).toMatch(/complete the deletion/i)
      expect(prompt).toMatch(/do NOT re-add a field that the original task explicitly removed/i)
    })

    it('describes common code patterns the agent must clean up when completing a deletion', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/property access/i)
      expect(prompt).toMatch(/object literal/i)
      expect(prompt).toMatch(/accumulator/i)
    })

    it('describes the missing-implementation path so the agent can add a field when that is the intent', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/missing implementation/i)
    })

    it('embeds the failing branch and worktree path', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.targetPath)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/queue.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'remove totalCostUsd from TaskSignalRow and all call sites',
      })
      expect(promptWithSource).toContain(
        'remove totalCostUsd from TaskSignalRow and all call sites',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'remove totalCostUsd from TaskSignalRow and all call sites',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('instructs the agent to re-run typecheck after each fix to confirm error count drops', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('npx tsc --noEmit')
      expect(prompt).toMatch(/error count drops/i)
    })
  })

  describe('verify:typecheck/typecheck-missing-export recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        'src/mastra/blocker-resolution.test.ts(19,73): error TS2694: Namespace \'...\' has no exported member \'markOriginDoneFromRecovery\'.\nCommand failed: npx tsc --noEmit\n',
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('is registered under the correct signature', () => {
      expect(hasRecipe('verify:typecheck/typecheck-missing-export')).toBe(true)
    })

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-missing-export')
      expect(recipe.title(ctx)).toBe(
        'Implement missing exported member(s) to resolve TS2694 typecheck failure',
      )
    })

    it('prompt contains TS2694, step instructions, and constraint not to modify tests', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-missing-export')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS2694')
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      expect(prompt).toContain('STEP 3')
      expect(prompt).toMatch(/Do NOT delete or modify the test file/i)
      expect(prompt).toMatch(/Do NOT add an `export \* from`/i)
      expect(prompt).toContain('Save your work')
    })

    it('embeds the failing branch and worktree path', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-missing-export')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.targetPath)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/queue.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-missing-export')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'add markOriginDoneFromRecovery to blocker-resolution.ts',
      })
      expect(promptWithSource).toContain(
        'add markOriginDoneFromRecovery to blocker-resolution.ts',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'add markOriginDoneFromRecovery to blocker-resolution.ts',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('mentions cascade TS7006 errors so the agent understands they are not independent', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-missing-export')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS7006')
      expect(prompt).toMatch(/cascade/i)
    })
  })

  describe('verify:typecheck/typecheck-arg-type-mismatch recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        "src/mastra/daemon/__tests__/liveness.test.ts(144,51): error TS2345: Argument of type '(value: void | PromiseLike<void>) => void' is not assignable to parameter of type '(err?: Error | undefined) => void'.\nCommand failed: npx tsc --noEmit\n",
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('is registered under the correct signature', () => {
      expect(hasRecipe('verify:typecheck/typecheck-arg-type-mismatch')).toBe(true)
    })

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      expect(recipe.title(ctx)).toBe(
        'Fix argument type mismatch(es) to resolve TS2345 typecheck failure',
      )
    })

    it('prompt contains TS2345, step instructions, and constraint against ts-ignore', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS2345')
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      expect(prompt).toContain('STEP 3')
      expect(prompt).toMatch(/do NOT add.*@ts-ignore/i)
      expect(prompt).toContain('Save your work')
    })

    it('shows the Promise-resolver-as-error-first-callback example — the most common cause in this codebase', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/server\.close\(resolve\)/i)
      expect(prompt).toMatch(/error-first callback/i)
      expect(prompt).toMatch(/err \? reject\(err\) : resolve\(\)/i)
    })

    it('embeds the failing branch and worktree path', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.targetPath)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/queue.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'add isDaemonAlive helper in src/mastra/daemon/liveness.ts',
      })
      expect(promptWithSource).toContain(
        'add isDaemonAlive helper in src/mastra/daemon/liveness.ts',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'add isDaemonAlive helper in src/mastra/daemon/liveness.ts',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('instructs the agent to adapt the argument to match the declared parameter, not change the parameter type', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/adapt the argument to match the declared parameter/i)
    })
  })

  describe('verify:typecheck/typecheck-cannot-find-name recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        "src/mastra/queue-fix-tasks.ts(605,11): error TS2304: Cannot find name 'NO_RECIPE_INBOX_KIND'.\nCommand failed: npx tsc --noEmit\n",
      targetBranch: 'task/abc',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('is registered under the correct signature', () => {
      expect(hasRecipe('verify:typecheck/typecheck-cannot-find-name')).toBe(true)
    })

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      expect(recipe.title(ctx)).toBe(
        'Fix cannot-find-name error(s) to resolve TS2304 typecheck failure',
      )
    })

    it('prompt contains TS2304, step instructions, and constraint against ts-ignore', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS2304')
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      expect(prompt).toContain('STEP 3')
      expect(prompt).toMatch(/do NOT add.*@ts-ignore/i)
      expect(prompt).toContain('Save your work')
    })

    it('describes the partial-deletion path so the agent completes deletions rather than re-adding the name', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/partial deletion/i)
      expect(prompt).toMatch(/complete the deletion/i)
      expect(prompt).toMatch(/do not re-introduce a name that the original task explicitly removed/i)
    })

    it('describes the missing-implementation and missing-import paths', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/missing implementation/i)
      expect(prompt).toMatch(/missing import/i)
    })

    it('embeds the failing branch and worktree path', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.targetPath)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/queue.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'delete NO_RECIPE_INBOX_KIND and all its usages from queue-fix-tasks.ts',
      })
      expect(promptWithSource).toContain(
        'delete NO_RECIPE_INBOX_KIND and all its usages from queue-fix-tasks.ts',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'delete NO_RECIPE_INBOX_KIND and all its usages from queue-fix-tasks.ts',
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('instructs agent to re-run typecheck after each fix to confirm error count drops', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('npx tsc --noEmit')
      expect(prompt).toMatch(/error count drops/i)
    })
  })

  describe('intentionally absent recipes (documented investigation outcomes)', () => {
    it('merge:crashed/index-lock-contention has no recipe — environmental transient failure; operator restarts with `mars restart`', () => {
      // Investigated 2026-05-18 (task 5c15a8e1). Root cause: git checkout main
      // crashed because .git/index.lock existed (stale or concurrent process).
      // Task coding work was already committed on branch task/mars-cea7a89f.
      // A recipe that deletes index.lock is dangerous (may be held by an active
      // process). Operator fix: confirm no active git process, then mars restart.
      //
      // Re-confirmed 2026-05-20 (task mars-f0b3da78, origin 82f2b926). In this
      // occurrence the branch had 0 commits ahead of main — the queue-fix-tasks
      // migration work was never committed before the merge crashed. Lock was
      // already gone at investigation time. mars restart mars-f0b3da78 will route
      // the retry through verify:has-diff/no-commits-ahead which has a recipe.
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

    it('merge:preflight/template-leakage/template-paths-detected has no recipe — task prompt conflict; human must update template on main', () => {
      // Investigated 2026-05-18 (task mars-77844c1f). Root cause: PRD 208a283c
      // Slice 3a explicitly instructed the agent to edit
      // orchestrator/src/init/templates/CLAUDE.md. The template-leakage
      // preflight categorically blocks ALL orchestrator edits to that subtree
      // (git.ts: "humans edit it directly on main"). A recipe is wrong because:
      // (a) any recovery agent hits the same preflight block if it tries to
      // update the template; (b) a recovery that skips the template edit fails
      // the task's own verify criteria (the verify rg command checks the
      // template path). Root cause is a task prompt asking for the impossible
      // — resolution requires a human to update the template directly on main.
      // Repro: git diff --name-only ${integrationBranch}..task/mars-77844c1f
      //        | grep 'orchestrator/src/init/templates/'
      expect(hasRecipe('merge:preflight/template-leakage/template-paths-detected')).toBe(false)
    })

    it('merge:preflight/template-leakage/unclassified has no recipe — same root cause as template-paths-detected; stale orchestrator process at failure time', () => {
      // Investigated 2026-05-19 (task mars-5989999f). Root cause: task tried to
      // edit orchestrator/src/init/templates/claude/skills/mars:inbox/SKILL.md
      // (a YAML description fix in the frontmatter). The template-leakage
      // preflight categorically blocks ALL orchestrator edits to that subtree
      // (git.ts: "humans edit it directly on main"). A recipe is wrong for the
      // same reasons as template-paths-detected:
      // (a) any recovery agent hits the same preflight block if it tries to
      //     update the template;
      // (b) a recovery that skips the template edit fails the task's own verify
      //     criteria (the verify diff command checks the template path).
      // The /unclassified suffix appeared because the 'template-paths-detected'
      // classifier rule (commit 9ed0041, added during the mars-77844c1f
      // investigation) was already in the codebase but the orchestrator process
      // that ran the merge preflight had not been restarted to pick it up.
      // Future occurrences of this error produce the stable
      // 'merge:preflight/template-leakage/template-paths-detected' signature.
      // Outcome: (b) inbox item; human must edit the template directly on main.
      // Repro: git diff --name-only main..task/mars-5989999f
      //        | grep 'orchestrator/src/init/templates/'
      //
      // Re-confirmed 2026-05-19 (task mars-9dce6ff6). Root cause: PRD
      // e32ed35f slice 2 instructed the agent to remove the false SessionStart
      // claim from orchestrator/src/init/templates/CLAUDE.md. The agent
      // correctly committed the change (commit ab0b0c9 on task/mars-9dce6ff6),
      // but the merge preflight blocked it. Same outcome (b): human must apply
      // the template edit directly on main. The /unclassified suffix persists
      // because the orchestrator daemon is still running the pre-9ed0041 classifier.
      // Repro: git diff --name-only main..task/mars-9dce6ff6
      //        | grep 'orchestrator/src/init/templates/'
      //
      // Re-confirmed 2026-05-19 (task mars-2c6dd178). Root cause: the task
      // prompt explicitly asked to hard-cut zombie inbox kinds
      // (idea-needs-shaping, stale-worktree) from template files — specifically
      // orchestrator/src/init/templates/CLAUDE.md,
      // orchestrator/src/init/templates/claude/skills/mars:grill/SKILL.md, and
      // orchestrator/src/init/templates/claude/skills/mars:inbox/SKILL.md.
      // The agent correctly committed the change (commit cf8ed6b on
      // task/mars-2c6dd178), but the merge preflight blocked it. The task's
      // own verify command (`grep -rn 'idea-needs-shaping|stale-worktree'
      // orchestrator/src CLAUDE.md`) explicitly names template paths, so a
      // recovery that skips the template edit cannot satisfy the verify.
      // Same outcome (b): human must apply the template edits directly on main.
      // The /unclassified suffix persists because the orchestrator daemon has
      // not been restarted to pick up the template-paths-detected classifier
      // rule added in commit 9ed0041.
      // Repro: git diff --name-only main..task/mars-2c6dd178
      //        | grep 'orchestrator/src/init/templates/'
      //
      // Re-confirmed 2026-05-20 (task mars-af0d8023). Root cause: the task
      // prompt explicitly asked to update orchestrator/src/init/templates/
      // claude/skills/mars:inbox/SKILL.md to limit the open-inbox listing
      // to 20 rows via `| head -n 20`. The agent committed the change across
      // 10 template paths (commit f49bddc on task/mars-af0d8023), but the
      // merge preflight blocked all 10. The task's own verify command
      // (`grep -n "mars inbox list" orchestrator/src/init/templates/...`)
      // explicitly names the template path, so a recovery that skips the
      // template edit fails verify. Same outcome (b): human must apply the
      // head-20 edit directly on main. The /unclassified suffix appears
      // because the daemon process that ran the preflight predated commit
      // 9ed0041 — the task itself ran at 15:42 on 2026-05-18, before
      // 9ed0041 landed at 19:06 on the same day.
      // Repro: git diff --name-only main..task/mars-af0d8023
      //        | grep 'orchestrator/src/init/templates/'
      expect(hasRecipe('merge:preflight/template-leakage/unclassified')).toBe(false)
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

  it('recovery prompt for verify:has-diff/no-commits-ahead uses git rev-list --count integration..HEAD (recovery branch), never git -C <failing-path> rev-list or rev-list ...<failing-branch>', async () => {
    // Regression: task mars-fda4da8b failed with no-commits-ahead and spawned
    // recovery 9900226d. The OLD recipe used
    //   `git -C .mars/worktrees/mars-fda4da8b/ rev-list --count main..task/mars-fda4da8b`
    // which checked the ORIGINAL (empty) branch, not the recovery branch.
    // The agent then committed in its own CWD (task/9900226d) but the
    // orchestrator's verify step found 0 commits on task/mars-fda4da8b and
    // marked recovery failed. This test locks in the CORRECT countCmd form:
    // `git rev-list --count main..HEAD` (no -C flag, no branch name — just HEAD
    // in the recovery worktree's CWD), so the check always reflects the
    // recovery task's own branch state, not the original failing branch.
    const { q, ft } = await loadModules(repo)
    process.env.MARS_FIX_RETRY_BUDGET = '1'
    const failingBranch = 'task/mars-fda4da8b'
    const failingWorktree = resolve(repo, '.mars/worktrees/mars-fda4da8b')
    const t = await q.enqueueTask(
      'Raise an inbox message on draft-idea creation',
      undefined,
      { skipTriage: true },
    )
    const result = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'verify:has-diff',
      errorOutput: `no commits ahead of integration branch — task did not produce any changes\nbranch ${failingBranch} has 0 commits ahead of main`,
      branch: failingBranch,
      recipeContext: {
        targetPath: failingWorktree,
        statusOutput: '',
        targetBranch: failingBranch,
        integrationBranch: 'main',
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

    // The countCmd MUST be in the recovery agent's own CWD (HEAD), not
    // pointing at the failing branch via -C <failing-worktree>.
    expect(row.prompt).toContain('git rev-list --count main..HEAD')

    // The OLD broken forms that pointed at the empty failing branch:
    expect(row.prompt).not.toMatch(/git -C \S+ rev-list/)
    expect(row.prompt).not.toContain(`rev-list --count main..${failingBranch}`)

    // The agent must be told it is in a FRESH worktree (not the failing one).
    expect(row.prompt).toMatch(/FRESH recovery worktree/i)
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

describe('handleTaskFailureWithFixTask investigator path flows originalPrompt', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('includes the original task prompt in the investigator task prompt so the investigator can judge intent vs. incident', async () => {
    const { q, ft } = await loadModules(repo)
    const originalPrompt =
      'add the nudge link in src/components/NudgePanel.tsx with a specific href'
    const t = await q.enqueueTask(originalPrompt, undefined, {
      skipTriage: true,
    })

    const result = await ft.handleTaskFailureWithFixTask({
      taskId: t.id,
      failingStep: 'code:some-unknown-step',
      // Error text that classifies to /unclassified — no recipe registered for it.
      errorOutput:
        'completely unknown error text with no classifier rule match',
    })

    expect(result.outcome).toBe('no-recipe')
    expect(result.investigatorTaskId).toBeDefined()

    const r = await q.getClient().execute({
      sql: `SELECT prompt FROM tasks WHERE id = ?`,
      args: [result.investigatorTaskId ?? ''],
    })
    const row = r.rows[0] as unknown as { prompt: string }
    // The investigator prompt must embed the original task's text verbatim so
    // the investigator can judge whether the failure is a real product bug or a
    // malformed/underspecified task — without burning turn budget on a DB lookup.
    expect(row.prompt).toContain(originalPrompt)
    expect(row.prompt).toMatch(/## Original task prompt/i)
  })
})
