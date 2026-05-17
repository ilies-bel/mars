/**
 * Regression test for the worktree-dirtying bug.
 *
 * Root cause: `pretest` / `prebuild` unconditionally ran
 * `sync-claude-templates.sh`, which copies the live project CLAUDE.md into
 * the bundled templates tree. Inside a task worktree the "live" CLAUDE.md is
 * the worktree's copy — overwriting the template with it dirties the tree and
 * blocks the rebase-based merge step.
 *
 * Fix: the script now detects a git worktree context (`git-dir ≠ git-common-
 * dir`) and exits 0 without touching any files.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SCRIPT_PATH = resolve(__dirname, '../../../scripts/sync-claude-templates.sh')

const ROOT_CLAUDE_MD_CONTENT = '# Root CLAUDE.md — live project content\n'
const TEMPLATE_CLAUDE_MD_CONTENT = '# Original template CLAUDE.md — different from root\n'
const CLAUDE_SETTINGS_CONTENT = '{"version": 1}\n'

/** Build a minimal git repo that mirrors the orchestrator layout. */
function setupMainRepo(root: string): void {
  execSync('git init -b main', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' })

  // Source files the script reads from
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), CLAUDE_SETTINGS_CONTENT)
  writeFileSync(join(root, 'CLAUDE.md'), ROOT_CLAUDE_MD_CONTENT)

  // Orchestrator scripts directory with the script under test
  mkdirSync(join(root, 'orchestrator', 'scripts'), { recursive: true })
  copyFileSync(SCRIPT_PATH, join(root, 'orchestrator', 'scripts', 'sync-claude-templates.sh'))

  // Template destination with different content so we can detect overwrites
  mkdirSync(join(root, 'orchestrator', 'src', 'init', 'templates'), { recursive: true })
  writeFileSync(
    join(root, 'orchestrator', 'src', 'init', 'templates', 'CLAUDE.md'),
    TEMPLATE_CLAUDE_MD_CONTENT,
  )

  // Commit everything so the worktree add below has a HEAD to checkout
  execSync('git add -A', { cwd: root, stdio: 'pipe' })
  execSync('git commit -m "initial"', { cwd: root, stdio: 'pipe' })
}

describe('sync-claude-templates.sh — worktree guard', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-sync-templates-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('syncs templates when running from the main working tree', () => {
    const mainRepo = join(tmpDir, 'main')
    mkdirSync(mainRepo)
    setupMainRepo(mainRepo)

    const templatePath = join(
      mainRepo,
      'orchestrator',
      'src',
      'init',
      'templates',
      'CLAUDE.md',
    )

    const result = spawnSync('bash', ['./scripts/sync-claude-templates.sh'], {
      cwd: join(mainRepo, 'orchestrator'),
      stdio: 'pipe',
    })

    expect(result.status).toBe(0)
    // Template MUST have been overwritten with the root CLAUDE.md
    const content = readFileSync(templatePath, 'utf8')
    expect(content).toBe(ROOT_CLAUDE_MD_CONTENT)
  })

  it('does NOT touch template files when running from inside a git worktree', () => {
    const mainRepo = join(tmpDir, 'main')
    mkdirSync(mainRepo)
    setupMainRepo(mainRepo)

    // Create a git worktree — the critical condition that triggers the bug
    const worktreePath = join(tmpDir, 'worktree')
    execSync(`git worktree add --detach "${worktreePath}"`, {
      cwd: mainRepo,
      stdio: 'pipe',
    })

    const templatePath = join(
      worktreePath,
      'orchestrator',
      'src',
      'init',
      'templates',
      'CLAUDE.md',
    )

    // Capture template content before the script runs
    const contentBefore = readFileSync(templatePath, 'utf8')

    const result = spawnSync('bash', ['./scripts/sync-claude-templates.sh'], {
      cwd: join(worktreePath, 'orchestrator'),
      stdio: 'pipe',
    })

    expect(result.status).toBe(0)
    // Template MUST be unchanged — the sync was skipped
    const contentAfter = readFileSync(templatePath, 'utf8')
    expect(contentAfter).toBe(contentBefore)
  })

  it('exits 0 (not an error) when skipping inside a worktree', () => {
    const mainRepo = join(tmpDir, 'main')
    mkdirSync(mainRepo)
    setupMainRepo(mainRepo)

    const worktreePath = join(tmpDir, 'worktree')
    execSync(`git worktree add --detach "${worktreePath}"`, {
      cwd: mainRepo,
      stdio: 'pipe',
    })

    const result = spawnSync('bash', ['./scripts/sync-claude-templates.sh'], {
      cwd: join(worktreePath, 'orchestrator'),
      stdio: 'pipe',
    })

    // Must succeed (exit 0) so pretest/prebuild don't break the verify step
    expect(result.status).toBe(0)
  })

  it('emits a diagnostic message on stderr when skipping inside a worktree', () => {
    const mainRepo = join(tmpDir, 'main')
    mkdirSync(mainRepo)
    setupMainRepo(mainRepo)

    const worktreePath = join(tmpDir, 'worktree')
    execSync(`git worktree add --detach "${worktreePath}"`, {
      cwd: mainRepo,
      stdio: 'pipe',
    })

    const result = spawnSync('bash', ['./scripts/sync-claude-templates.sh'], {
      cwd: join(worktreePath, 'orchestrator'),
      encoding: 'utf8',
      stdio: 'pipe',
    })

    // Operator should be able to see WHY the sync was skipped
    expect(result.stderr).toContain('inside a git worktree')
  })
})
