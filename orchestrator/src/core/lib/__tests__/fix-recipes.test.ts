import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { genericRecoveryRecipe, getRecipe, getRecipeOrGeneric, hasRecipe, recipes } from '../fix-recipes'

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
         - If the output is empty, the tree is already clean: do NOT touch any file, do NOT commit, do NOT emit an actionQueue notification. Exit successfully — the original task can be retried as-is.
         - If the output is non-empty, proceed to STEP 2 with the CURRENT status, not the snapshot below.

        STEP 2 — only if STEP 1 still shows a dirty tree. Inspect each modified or untracked file:
         (a) commit files that represent intentional work with a meaningful commit message that describes the actual changes;
         (b) discard files that are clearly transient (build artifacts, .DS_Store, editor swap files, anything in .gitignore that slipped in via \`git add -f\` etc.);
         (c) for anything ambiguous, do NOT guess — emit a high-priority actionQueue notification listing the file(s) and what's unclear, and exit.

        Do not push. Save your work.

        Merge target path: /tmp/main-checkout
        Merge target branch: main

        Original \`git status --porcelain\` output captured at failure time (may be stale — re-check before acting):
        \`\`\`
         M src/foo.ts
        ?? new-file.txt

        \`\`\`

        If you need to file an actionQueue notification, use \`mars actionQueue raise --from -\` with priority='high' and a clear message describing the ambiguous file(s)."
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
      expect(prompt).toContain('high-priority actionQueue notification')
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

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
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

    it('uses merge-base-scoped diff ($BASE..HEAD) instead of raw integration..HEAD to avoid stale-baseline reversions', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('merge-base')
      expect(prompt).toContain('$BASE..HEAD')
      // The failing-worktree form `git -C <targetPath> diff main..HEAD` that
      // silently reverted newer main commits must not appear in the capture step.
      // (The guard step `git diff main..HEAD --stat` without -C is permitted.)
      expect(prompt).not.toContain(
        `git -C ${ctx.targetPath} diff ${ctx.integrationBranch}..HEAD`,
      )
    })

    it('orders the commit-immediately step before the iterate step (step numbering updated for guard)', () => {
      const recipe = getRecipe(
        'merge:vcs-supervisor-aborted/not-fast-forward',
      )
      const prompt = recipe.buildPrompt(ctx)
      // Guard step must appear between apply and commit.
      const guardIdx = prompt.indexOf('stale-baseline lift')
      const commitIdx = prompt.search(/\*\*Commit immediately\*\*/i)
      const iterateIdx = prompt.search(/may you iterate/i)
      expect(guardIdx).toBeGreaterThan(0)
      expect(commitIdx).toBeGreaterThan(guardIdx)
      expect(iterateIdx).toBeGreaterThan(commitIdx)
    })
  })

  describe('verify:typecheck/typecheck-excess-property recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-abc',
      statusOutput:
        "src/core/lib/__tests__/reflector.test.ts(40,9): error TS2353: Object literal may only specify known properties, and 'removedField' does not exist in type '{ inputTokens: number; outputTokens: number; cacheCreateTokens: number; cacheReadTokens: number; cacheHitRatio: number; }'.\nCommand failed: npx tsc --noEmit\n",
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

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-excess-property')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt:
          'remove removedField from SomeType and all call sites',
      })
      expect(promptWithSource).toContain(
        'remove removedField from SomeType and all call sites',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'remove removedField from SomeType and all call sites',
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
        "src/core/lib/deep-reflect-query.ts(169,21): error TS2339: Property 'removedField' does not exist on type 'SomeType'.\nCommand failed: npx tsc --noEmit\n",
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

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-property-not-exist')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'remove removedField from SomeType and all call sites',
      })
      expect(promptWithSource).toContain(
        'remove removedField from SomeType and all call sites',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'remove removedField from SomeType and all call sites',
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
        'src/core/blocker-resolution.test.ts(19,73): error TS2694: Namespace \'...\' has no exported member \'markOriginDoneFromRecovery\'.\nCommand failed: npx tsc --noEmit\n',
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

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
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
        "src/core/daemon/__tests__/liveness.test.ts(144,51): error TS2345: Argument of type '(value: void | PromiseLike<void>) => void' is not assignable to parameter of type '(err?: Error | undefined) => void'.\nCommand failed: npx tsc --noEmit\n",
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

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-arg-type-mismatch')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'add isDaemonAlive helper in src/core/daemon/liveness.ts',
      })
      expect(promptWithSource).toContain(
        'add isDaemonAlive helper in src/core/daemon/liveness.ts',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'add isDaemonAlive helper in src/core/daemon/liveness.ts',
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
        "src/core/queue-fix-tasks.ts(605,11): error TS2304: Cannot find name 'NO_RECIPE_ACTION_QUEUE_KIND'.\nCommand failed: npx tsc --noEmit\n",
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

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-cannot-find-name')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: 'delete NO_RECIPE_ACTION_QUEUE_KIND and all its usages from queue-fix-tasks.ts',
      })
      expect(promptWithSource).toContain(
        'delete NO_RECIPE_ACTION_QUEUE_KIND and all its usages from queue-fix-tasks.ts',
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        'delete NO_RECIPE_ACTION_QUEUE_KIND and all its usages from queue-fix-tasks.ts',
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

  describe('verify:typecheck/typecheck-type-mismatch recipe', () => {
    const ctx = {
      targetPath: '/tmp/worktrees/task-eda2d54c',
      statusOutput: [
        "src/core/lib/error-kinds.ts(119,7): error TS2322: Type 'Readonly<...>' is not assignable to type 'Readonly<Record<...>>'.",
        "  The types of '\"stale-worktree\".recoveryActions' are incompatible between these types.",
        "    Type '{ id: string; label: string; op: \"investigate\"; }[]' is not assignable to type 'ActionDescriptor[]'.",
        "      Type '{ id: string; label: string; op: \"investigate\"; }' is not assignable to type 'ActionDescriptor'.",
        "        Types of property 'op' are incompatible.",
        "          Type '\"investigate\"' is not assignable to type 'ActionOp'.",
        'Command failed: npx tsc --noEmit',
      ].join('\n'),
      targetBranch: 'task/mars-eda2d54c',
      integrationBranch: 'main',
      originalPrompt: '',
    }

    it('is registered under the correct signature', () => {
      expect(hasRecipe('verify:typecheck/typecheck-type-mismatch')).toBe(true)
    })

    it('produces a stable title', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      expect(recipe.title(ctx)).toBe(
        'Fix type-mismatch error(s) to resolve TS2322 typecheck failure',
      )
    })

    it('prompt contains TS2322, step instructions, and constraint against ts-ignore', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain('TS2322')
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      expect(prompt).toContain('STEP 3')
      expect(prompt).toMatch(/do NOT add.*@ts-ignore/i)
      expect(prompt).toContain('Save your work')
    })

    it('explains the most common cause — partial union extension omitting a new literal', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/partial union extension/i)
      expect(prompt).toMatch(/extend the union/i)
    })

    it('gives concrete guidance on intentionally-new vs wrong value', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/intentionally new value/i)
      expect(prompt).toMatch(/wrong value/i)
    })

    it('warns to check exhaustive switch handlers when extending a union', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/switch/i)
      expect(prompt).toMatch(/exhaustive/i)
    })

    it('embeds the failing branch and worktree path', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toContain(ctx.targetBranch)
      expect(prompt).toContain(ctx.targetPath)
    })

    it('inlines the original task prompt when provided so the agent skips .mars/mars.db spelunking', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const promptWithSource = recipe.buildPrompt({
        ...ctx,
        originalPrompt: "add 'investigate' daemon action for stale worktrees",
      })
      expect(promptWithSource).toContain(
        "add 'investigate' daemon action for stale worktrees",
      )
      expect(promptWithSource).toMatch(/inlined/i)
      const promptWithout = recipe.buildPrompt(ctx)
      expect(promptWithout).not.toContain(
        "add 'investigate' daemon action for stale worktrees",
      )
      expect(promptWithout).not.toMatch(/Original task prompt \(inlined/i)
    })

    it('instructs agent to not narrow the value to an existing member when the new value is intentional', () => {
      const recipe = getRecipe('verify:typecheck/typecheck-type-mismatch')
      const prompt = recipe.buildPrompt(ctx)
      expect(prompt).toMatch(/do NOT narrow.*existing union member/i)
    })
  })

  describe('merge:vcs-supervisor-aborted/not-fast-forward covers Path 2 and Path 3 classifier extensions', () => {
    // Confirmed in investigation 2026-05-30 (task mars-c5b48744): two live
    // failure paths in mergeBranch (git.ts) produce first-line messages that
    // previously classified as /unclassified. The not-fast-forward rule's
    // `match` regex was extended to cover both shapes so they route to the
    // existing recipe instead of raising a no-recipe action-queue item.
    it('has a registered recipe under merge:vcs-supervisor-aborted/not-fast-forward', () => {
      expect(hasRecipe('merge:vcs-supervisor-aborted/not-fast-forward')).toBe(true)
    })

    it('recipe prompt instructs the recovery agent to lift the committed diff and re-land it — correct for all three not-fast-forward variants', () => {
      const ctx = {
        targetPath: '/tmp/worktrees/task-mars-c5b48744',
        statusOutput: '',
        targetBranch: 'task/mars-c5b48744',
        integrationBranch: 'main',
        originalPrompt: '',
      }
      const recipe = getRecipe('merge:vcs-supervisor-aborted/not-fast-forward')
      const prompt = recipe.buildPrompt(ctx)
      // The code is committed on the task branch; the agent must lift it.
      expect(prompt).toContain(`git -C ${ctx.targetPath} diff`)
      expect(prompt).toMatch(/commit immediately/i)
      // Agent must work in their own recovery worktree, not the failing one.
      expect(prompt).toMatch(/FRESH recovery worktree/i)
      expect(prompt).toMatch(/never edit there/i)
      // False-positive escape hatch must be gated on a non-zero rev-list count.
      const exitLine = prompt
        .split('\n')
        .find((line) => /exit successfully/i.test(line))
      expect(exitLine).toBeDefined()
      expect(exitLine).toMatch(/non-zero/i)
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

  })
})

describe('genericRecoveryRecipe (first-principles fallback)', () => {
  const baseCtx = {
    targetPath: '/tmp/worktrees/task-abc',
    statusOutput: 'process exited with code 1\nsome unknown error',
    targetBranch: 'task/abc',
    integrationBranch: 'main',
    originalPrompt: 'add the nudge link in src/components/NudgePanel.tsx',
  }

  describe('Problem 1 — git log scoped + capped + split (work-failure path)', () => {
    it('scopes git log to the integration branch and caps at 30 commits', () => {
      const prompt = genericRecoveryRecipe.buildPrompt(baseCtx)
      expect(prompt).toContain(
        `git -C ${baseCtx.targetPath} log --oneline ${baseCtx.integrationBranch}..HEAD --max-count 30`,
      )
    })

    it('does NOT use the unbounded, unscoped git log that swallows status and diff', () => {
      const prompt = genericRecoveryRecipe.buildPrompt(baseCtx)
      // The old chained form "log --oneline`, `...status`, and `...diff`"
      // had no branch scope and no --max-count, causing long logs to swallow
      // the subsequent status and diff output.
      expect(prompt).not.toMatch(/log --oneline[^`\n]*`,\s*`[^`\n]*status/)
      expect(prompt).not.toContain('log --oneline` , `')
      // No unbounded log (missing --max-count)
      const logLine = prompt
        .split('\n')
        .find((l) => l.includes('log --oneline') && l.includes(baseCtx.targetPath))
      expect(logLine).toBeDefined()
      expect(logLine).toContain('--max-count')
    })

    it('emits git status as a separate command line, not chained with git log', () => {
      const prompt = genericRecoveryRecipe.buildPrompt(baseCtx)
      const lines = prompt.split('\n')
      const logLineIdx = lines.findIndex(
        (l) => l.includes('log --oneline') && l.includes(baseCtx.targetPath),
      )
      const statusLineIdx = lines.findIndex(
        (l) => l.includes(`git -C ${baseCtx.targetPath} status`),
      )
      expect(logLineIdx).toBeGreaterThan(-1)
      expect(statusLineIdx).toBeGreaterThan(-1)
      // They must be on different lines (not crammed into one instruction)
      expect(statusLineIdx).not.toBe(logLineIdx)
    })

    it('emits git diff as a separate command line, not chained with git log', () => {
      const prompt = genericRecoveryRecipe.buildPrompt(baseCtx)
      const lines = prompt.split('\n')
      const logLineIdx = lines.findIndex(
        (l) => l.includes('log --oneline') && l.includes(baseCtx.targetPath),
      )
      const diffLineIdx = lines.findIndex(
        (l) => l.includes(`git -C ${baseCtx.targetPath} diff`),
      )
      expect(logLineIdx).toBeGreaterThan(-1)
      expect(diffLineIdx).toBeGreaterThan(-1)
      expect(diffLineIdx).not.toBe(logLineIdx)
    })

    it('falls back to `main` when integrationBranch is absent from the context', () => {
      const prompt = genericRecoveryRecipe.buildPrompt({
        targetPath: baseCtx.targetPath,
        statusOutput: baseCtx.statusOutput,
        targetBranch: baseCtx.targetBranch,
        originalPrompt: '',
      })
      expect(prompt).toContain(
        `git -C ${baseCtx.targetPath} log --oneline main..HEAD --max-count 30`,
      )
    })

    it('uses a custom integrationBranch when provided', () => {
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        integrationBranch: 'develop',
      })
      expect(prompt).toContain(
        `git -C ${baseCtx.targetPath} log --oneline develop..HEAD --max-count 30`,
      )
    })
  })

  describe('Problem 2 — gate failure vs work failure branching', () => {
    it('work-failure path (no failureSignature) includes re-analysis steps 1–2', () => {
      const prompt = genericRecoveryRecipe.buildPrompt(baseCtx)
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain('STEP 2')
      // Step 1 reads what's already here (log/status/diff)
      expect(prompt).toContain(
        `git -C ${baseCtx.targetPath} log --oneline main..HEAD --max-count 30`,
      )
      // Step 2 shows the original goal
      expect(prompt).toContain(baseCtx.originalPrompt)
    })

    it('work-failure path (code: signature) includes re-analysis steps', () => {
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        failureSignature: 'code:some-unknown-step/unclassified',
      })
      expect(prompt).toContain('STEP 1')
      expect(prompt).toContain(
        `git -C ${baseCtx.targetPath} log --oneline main..HEAD --max-count 30`,
      )
    })

    it('gate-failure path (verify: signature) skips re-analysis steps and goes straight to the gate failure', () => {
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        failureSignature: 'verify:some-unknown-gate/unclassified',
      })
      // The prompt must mention the gate failure summary immediately
      expect(prompt).toContain(baseCtx.statusOutput)
      // No read-what-is-here step: the log/status/diff analysis commands
      // are wasted tokens when the coder's work succeeded
      expect(prompt).not.toContain(
        `git -C ${baseCtx.targetPath} log --oneline`,
      )
    })

    it('gate-failure path excludes git status and git diff commands in addition to git log (full no-analysis guard)', () => {
      // Regression guard: an earlier version excluded only git log. Ensure all
      // three read-what-is-here commands are absent so nothing about the
      // re-analysis block can creep back in.
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        failureSignature: 'verify:some-unknown-gate/unclassified',
      })
      expect(prompt).not.toContain(`git -C ${baseCtx.targetPath} status`)
      expect(prompt).not.toContain(`git -C ${baseCtx.targetPath} diff`)
      expect(prompt).not.toContain(`git -C ${baseCtx.targetPath} log`)
    })

    it('gate-failure path still includes worktree path and save reminder', () => {
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        failureSignature: 'verify:some-unknown-gate/unclassified',
      })
      expect(prompt).toContain(baseCtx.targetPath)
      expect(prompt).toContain(baseCtx.targetBranch)
      expect(prompt).toContain('Save your work')
    })

    it('gate-failure path names the failure signature in the intro', () => {
      const sig = 'verify:some-unknown-gate/unclassified'
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        failureSignature: sig,
      })
      expect(prompt).toContain(sig)
    })

    it('gate-failure path still inlines the original goal so fixer has context', () => {
      const prompt = genericRecoveryRecipe.buildPrompt({
        ...baseCtx,
        failureSignature: 'verify:some-gate/unclassified',
      })
      expect(prompt).toContain(baseCtx.originalPrompt)
    })
  })
})

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  ensureQueueSchema: typeof import('../../queue').ensureQueueSchema
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
  await q.ensureQueueSchema()
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

  it('flows the original task prompt into the recovery recipe output so the agent does not need to re-fetch it from .mars/mars.db', async () => {
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

    const r = await q.resolveQueueClient().execute({
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
      'Raise an actionQueue message on draft-idea creation',
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

    const r = await q.resolveQueueClient().execute({
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

    const r = await q.resolveQueueClient().execute({
      sql: `SELECT prompt FROM tasks WHERE id = ?`,
      args: [result.fixTaskId ?? ''],
    })
    const row = r.rows[0] as unknown as { prompt: string }
    expect(row.prompt).toContain('leftover.tmp')
    expect(row.prompt).toContain('high-priority actionQueue notification')
  })
})

describe('handleTaskFailureWithFixTask unknown-signature path', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('spawns a generic-recipe recovery fix and blocks the source (ADR: uniform failure→fix spawn)', async () => {
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

    // Every regular-task failure spawns a fix, even with no registered recipe.
    expect(result.outcome).toBe('blocked')
    expect(result.fixTaskId).toBeTruthy()

    // Source task is blocked (not failed) behind the recovery.
    const source = await q.getTask(t.id)
    expect(source?.status).toBe('blocked')

    // A kind='fix' recovery was created from the generic recipe, carrying the
    // original intent verbatim so the fixer can resume from first principles.
    const fix = await q.getTask(result.fixTaskId as string)
    expect(fix?.kind).toBe('fix')
    expect(fix?.fixForTaskId).toBe(t.id)
    expect(fix?.prompt).toContain(originalPrompt)

    const all = await q.resolveQueueClient().execute({
      sql: `SELECT id FROM tasks`,
      args: [],
    })
    expect(all.rows.length).toBe(2)
  })
})

describe('verify:test/test-no-suite-found recipe', () => {
  const ctx = {
    targetPath: '/tmp/worktrees/task-abc',
    statusOutput: [
      '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  src/core/agents/__tests__/registry.test.ts',
      'Error: No test suite found in file /tmp/worktrees/task-abc/orchestrator/src/core/agents/__tests__/registry.test.ts',
    ].join('\n'),
    targetBranch: 'task/abc',
    integrationBranch: 'main',
    originalPrompt: '',
  }

  it('is registered under the correct signature', () => {
    expect(hasRecipe('verify:test/test-no-suite-found')).toBe(true)
  })

  it('produces a stable title naming the failing branch', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    expect(recipe.title(ctx)).toBe(
      'Remove or populate the empty test file blocking verify:test on task/abc',
    )
  })

  it('prompt instructs the agent to identify the empty file from the failure output', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    const prompt = recipe.buildPrompt(ctx)
    expect(prompt).toContain('No test suite found in file')
    expect(prompt).toContain(ctx.statusOutput)
    expect(prompt).toMatch(/identify.*empty.*file/i)
  })

  it('prompt instructs the agent to check for sibling test files before deciding to delete or populate', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    const prompt = recipe.buildPrompt(ctx)
    expect(prompt).toMatch(/sibling.*test.*file|other.*test.*file/i)
    expect(prompt).toMatch(/delete.*empty.*file|delete.*placeholder/i)
    expect(prompt).toMatch(/populate/i)
  })

  it('prompt includes the standard lift-diff steps to avoid an empty recovery branch', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    const prompt = recipe.buildPrompt(ctx)
    expect(prompt).toContain(`git -C ${ctx.targetPath} diff`)
    expect(prompt).toMatch(/commit immediately/i)
    expect(prompt).toContain('git add -A && git commit')
  })

  it('prompt gates exit-successfully on a non-zero rev-list count', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    const prompt = recipe.buildPrompt(ctx)
    const exitLine = prompt
      .split('\n')
      .find((line) => /exit successfully/i.test(line))
    expect(exitLine).toBeDefined()
    expect(exitLine).toMatch(/non-zero/i)
  })

  it('prompt embeds the failing worktree path and integration branch', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    const prompt = recipe.buildPrompt(ctx)
    expect(prompt).toContain(ctx.targetPath)
    expect(prompt).toContain(ctx.integrationBranch)
    expect(prompt).toContain('Save your work')
  })

  it('inlines the original task prompt when provided', () => {
    const recipe = getRecipe('verify:test/test-no-suite-found')
    const promptWithSource = recipe.buildPrompt({
      ...ctx,
      originalPrompt: 'add agent registry with writer entry',
    })
    expect(promptWithSource).toContain('add agent registry with writer entry')
    expect(promptWithSource).toMatch(/inlined/i)
    const promptWithout = recipe.buildPrompt(ctx)
    expect(promptWithout).not.toContain('add agent registry with writer entry')
  })
})
describe('lift-diff stale-baseline guard (all five lift-diff / re-land recipe sites)', () => {
  // Regression guard for the incident where a recovery task lifted
  // `integration..HEAD` from a stale worktree baseline and silently reverted
  // two newer main commits (merge-retry fix + Progress-tab SSE re-land).
  // All five recipes that emit a `git diff <integration>..HEAD > patch` step
  // must now use merge-base-scoped diffs and include an explicit no-spurious-
  // revert guard.
  const signatures = [
    'merge:vcs-supervisor-aborted/not-fast-forward',
    'verify:test/test-assertion-error',
    'verify:test/test-no-suite-found',
  ] as const
  const ctx = {
    targetPath: '/tmp/worktrees/task-abc',
    statusOutput: '',
    targetBranch: 'task/abc',
    integrationBranch: 'main',
    originalPrompt: '',
  }

  for (const sig of signatures) {
    describe(sig, () => {
      it('instructs computing merge-base to scope the diff to task-only commits, not stale baseline content', () => {
        const recipe = getRecipe(sig)
        const prompt = recipe.buildPrompt(ctx)
        // Must mention merge-base so the diff is scoped to the task's own commits.
        expect(prompt).toContain('merge-base')
        // Must use $BASE..HEAD for the capture step.
        expect(prompt).toContain('$BASE..HEAD')
        // The failing-worktree form `git -C <targetPath> diff main..HEAD` that
        // caused the stale-baseline reversion incident must NOT appear.
        // Note: `git diff main..HEAD` (no -C) IS allowed — that is the guard
        // step that runs in the recovery worktree after applying the patch.
        expect(prompt).not.toContain(
          `git -C ${ctx.targetPath} diff ${ctx.integrationBranch}..HEAD`,
        )
      })

      it('includes the no-spurious-revert guard and STOP instruction before the commit step', () => {
        const recipe = getRecipe(sig)
        const prompt = recipe.buildPrompt(ctx)
        // Must instruct the agent to check for spurious reversions.
        expect(prompt).toContain('stale-baseline lift')
        // Must name the specific failure mode: reverting files the task never touched.
        expect(prompt).toMatch(/files.*task.*never touched|files.*never touched/i)
        // Must require an explicit STOP — agent must not silently commit.
        expect(prompt).toMatch(/STOP.*do not commit|STOP: do not commit/i)
      })

      it('requires the recovery branch to be based on current integration before lifting', () => {
        const recipe = getRecipe(sig)
        const prompt = recipe.buildPrompt(ctx)
        // Must instruct the agent to verify via merge-base --is-ancestor.
        expect(prompt).toContain(
          `git merge-base --is-ancestor ${ctx.integrationBranch} HEAD`,
        )
      })

      it('instructs computing BASE from the failing worktree merge-base, not the recovery worktree', () => {
        const recipe = getRecipe(sig)
        const prompt = recipe.buildPrompt(ctx)
        // The merge-base must be computed against the FAILING worktree (via -C)
        // so it reflects that branch's own divergence point.
        expect(prompt).toContain(
          `git -C ${ctx.targetPath} merge-base ${ctx.integrationBranch} HEAD`,
        )
      })
    })
  }
})
