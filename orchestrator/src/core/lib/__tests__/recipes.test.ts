import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  listBuiltInRecipeFiles,
  loadRecipeCatalog,
  recipesDir,
  VALID_RECIPE_TOOL_NAMES,
} from '../recipes'

const setupStateDir = (): string =>
  mkdtempSync(resolve(tmpdir(), 'mars-recipes-'))

/**
 * The eight built-in recipes shipped with slice E. The list pins them to
 * the catalog so dropping one accidentally is a loud test failure rather
 * than a silently smaller catalog.
 */
const BUILT_IN_RECIPE_NAMES = [
  'context-fetcher',
  'diagnose-only',
  'lint-autofix',
  'main-commiter',
  'merge-aborter',
  'prompt-tightener',
  'scope-narrower',
  'test-repairer',
  'typecheck-fixer',
] as const

describe('recipe catalog', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = setupStateDir()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  describe('built-in seed', () => {
    it('ships exactly the slice-E built-in recipes', () => {
      const names = listBuiltInRecipeFiles()
        .map((e) => e.name)
        .sort()
      expect(names).toEqual([...BUILT_IN_RECIPE_NAMES].sort())
    })

    it('loads every shipped built-in cleanly (no warnings)', async () => {
      const warnings: string[] = []
      const cat = await loadRecipeCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      const names = cat
        .list()
        .map((r) => r.name)
        .sort()
      expect(names).toEqual([...BUILT_IN_RECIPE_NAMES].sort())
      expect(warnings).toEqual([])
    })

    it('every built-in declares only tools from the closed allowlist', async () => {
      const cat = await loadRecipeCatalog(stateDir)
      for (const recipe of cat.list()) {
        for (const tool of recipe.tools) {
          expect(VALID_RECIPE_TOOL_NAMES).toContain(tool)
        }
      }
    })

    it('marks built-ins with source="built-in"', async () => {
      const cat = await loadRecipeCatalog(stateDir)
      for (const recipe of cat.list()) {
        expect(recipe.source).toBe('built-in')
      }
    })

    it('built-in prompts have the frontmatter stripped', async () => {
      const cat = await loadRecipeCatalog(stateDir)
      for (const recipe of cat.list()) {
        expect(recipe.prompt.startsWith('---')).toBe(false)
        // Each built-in starts with a `# Title` heading after the
        // frontmatter; trimming any leading blank line, the body should
        // begin with `#`.
        expect(recipe.prompt.trimStart().startsWith('#')).toBe(true)
      }
    })

    /**
     * `refs/stash` lives in the repository's COMMON git dir, so every linked
     * worktree in this repo shares one stack addressed by shifting position.
     * A recipe that tells a recovery agent to run any `git stash` verb hands
     * it a mechanism that can swallow — or hand it — another in-flight task's
     * uncommitted work (the 2026-07-28 data-loss incident). Recipes park work
     * on per-task refs via `git commit-tree` + `git update-ref` instead.
     *
     * The assertion targets *invocations* (`git stash <verb>`), so prose that
     * explains the ban ("never run any `git stash` verb") still passes.
     */
    it('no built-in recipe instructs an agent to invoke a git stash verb', async () => {
      const cat = await loadRecipeCatalog(stateDir)
      const invocation = /git stash (push|pop|create|apply|save|branch|store)/
      for (const recipe of cat.list()) {
        expect(
          recipe.prompt,
          `built-in recipe '${recipe.name}' invokes git stash`,
        ).not.toMatch(invocation)
      }
    })

    it('main-commiter commits ordinary dirty changes and refuses only danger signals', async () => {
      const cat = await loadRecipeCatalog(stateDir)
      const prompt = cat.get('main-commiter')?.prompt ?? ''
      expect(prompt).not.toBe('')
      expect(prompt).toContain('Commit unless danger')
      expect(prompt).toContain('git add -A && git commit -m')
      // The refusal boundary is closed: orchestrator state, secret-looking
      // material, and explicit unfinished-work markers are danger signals.
      expect(prompt).toContain('.mars/')
      expect(prompt).toContain('exit with a non-zero command immediately')
      expect(prompt).toContain(
        'Do not stage, commit, delete, reset, or otherwise modify that path',
      )
      expect(prompt).toContain('secret-looking')
      expect(prompt).toContain('TODO, FIXME, or XXX')
      expect(prompt).toContain('exit non-zero without committing')
      // Broad diffs and scratch files are ordinary changes, not ambiguity.
      expect(prompt).not.toContain('Safe to park')
      expect(prompt).not.toContain('refs/mars/parked/')
      expect(prompt).not.toContain('Ambiguous')
      expect(prompt).not.toContain('unrelated subsystems')
      expect(prompt).not.toContain('Mixed-domain changes')
    })
  })

  describe('overrides', () => {
    const writeOverride = (name: string, body: string): void => {
      const dir = recipesDir(stateDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, `${name}.md`), body, 'utf8')
    }

    it('replaces a built-in entry wholesale when the filename matches', async () => {
      writeOverride(
        'typecheck-fixer',
        `---
name: typecheck-fixer
description: Custom override of the typecheck fixer.
tools: [Bash]
---
# Custom body

Custom prompt content.
`,
      )
      const cat = await loadRecipeCatalog(stateDir)
      const recipe = cat.get('typecheck-fixer')
      expect(recipe?.description).toBe(
        'Custom override of the typecheck fixer.',
      )
      expect(recipe?.tools).toEqual(['Bash'])
      expect(recipe?.source).toBe('override')
      expect(recipe?.prompt).toContain('Custom body')
    })

    it('adds a brand-new recipe when the name has no built-in counterpart', async () => {
      writeOverride(
        'my-new-recipe',
        `---
name: my-new-recipe
description: A new recipe for my use case.
tools: [Read, Grep]
---
# New
`,
      )
      const cat = await loadRecipeCatalog(stateDir)
      const recipe = cat.get('my-new-recipe')
      expect(recipe).not.toBeNull()
      expect(recipe?.source).toBe('override')
      // Built-ins still present.
      for (const name of BUILT_IN_RECIPE_NAMES) {
        expect(cat.get(name)).not.toBeNull()
      }
    })
  })

  describe('error handling', () => {
    const writeFile = (filename: string, body: string): void => {
      const dir = recipesDir(stateDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, filename), body, 'utf8')
    }

    it('skips a file with no frontmatter block but loads the rest', async () => {
      writeFile('broken.md', '# Just a markdown file, no frontmatter.\n')
      const warnings: string[] = []
      const cat = await loadRecipeCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      expect(cat.get('broken')).toBeNull()
      expect(warnings.some((w) => w.includes('frontmatter'))).toBe(true)
      // Built-ins still loaded.
      expect(cat.get('typecheck-fixer')).not.toBeNull()
    })

    it('rejects an unknown tool name with a clear error', async () => {
      writeFile(
        'bad-tool.md',
        `---
name: bad-tool
description: Tries to use a tool that does not exist.
tools: [Bash, Frobnicate]
---
# x
`,
      )
      const warnings: string[] = []
      const cat = await loadRecipeCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      expect(cat.get('bad-tool')).toBeNull()
      const warning = warnings.find((w) => w.includes('bad-tool'))
      expect(warning).toBeTruthy()
      // The clear-error contract: message mentions valid tools.
      expect(warning).toMatch(/valid tools/i)
    })

    it('rejects a missing required field', async () => {
      // No `description` field.
      writeFile(
        'no-desc.md',
        `---
name: no-desc
tools: [Bash]
---
# x
`,
      )
      const warnings: string[] = []
      const cat = await loadRecipeCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      expect(cat.get('no-desc')).toBeNull()
      expect(warnings.some((w) => w.includes('description'))).toBe(true)
    })

    it('rejects a name that does not match the filename', async () => {
      writeFile(
        'misnamed.md',
        `---
name: not-misnamed
description: Frontmatter name disagrees with the filename.
tools: [Bash]
---
# x
`,
      )
      const warnings: string[] = []
      const cat = await loadRecipeCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      expect(cat.get('misnamed')).toBeNull()
      expect(cat.get('not-misnamed')).toBeNull()
      expect(
        warnings.some((w) => w.includes('does not match filename')),
      ).toBe(true)
    })

    it('skips one malformed file but loads valid siblings', async () => {
      writeFile(
        'good.md',
        `---
name: good
description: A clean recipe.
tools: [Bash]
---
# good
`,
      )
      writeFile('bad.md', 'no frontmatter here\n')
      const cat = await loadRecipeCatalog(stateDir)
      expect(cat.get('good')).not.toBeNull()
      expect(cat.get('bad')).toBeNull()
    })

    it('treats an empty closing frontmatter as a missing-field rejection', async () => {
      writeFile(
        'empty-fm.md',
        `---
---
# body only
`,
      )
      const warnings: string[] = []
      const cat = await loadRecipeCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      expect(cat.get('empty-fm')).toBeNull()
      expect(warnings.length).toBeGreaterThan(0)
    })

    it('get(unknown) returns null rather than throwing', async () => {
      const cat = await loadRecipeCatalog(stateDir)
      expect(cat.get('definitely-not-a-recipe')).toBeNull()
    })
  })

  describe('built-in resolution off import.meta.url', () => {
    it('still loads built-ins when invoked from a different cwd', async () => {
      // Simulate a daemon started inside a worktree by changing cwd to a
      // tmpdir that has nothing to do with the orchestrator source tree.
      // The loader must still resolve its built-in directory off
      // import.meta.url, not off process.cwd().
      const originalCwd = process.cwd()
      const elsewhere = mkdtempSync(resolve(tmpdir(), 'mars-recipes-cwd-'))
      try {
        process.chdir(elsewhere)
        const cat = await loadRecipeCatalog(elsewhere)
        const names = cat
          .list()
          .map((r) => r.name)
          .sort()
        expect(names).toEqual([...BUILT_IN_RECIPE_NAMES].sort())
      } finally {
        process.chdir(originalCwd)
        rmSync(elsewhere, { recursive: true, force: true })
      }
    })
  })
})
