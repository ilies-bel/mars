/**
 * Tests for the .claude/ template-tree sync script and its npm lifecycle wiring.
 *
 * Worktree guard (regression):
 *   `sync-claude-templates.sh` detects a git worktree context (`git-dir ≠
 *   git-common-dir`) and exits 0 without touching any files.  This prevents
 *   the worktree-dirtying bug that blocked the rebase-based merge step.
 *
 * Lifecycle hook contract:
 *   The sync script must NOT be wired into `prebuild` or `pretest` — that
 *   was the root cause of the bug.  It is now an explicit maintainer verb
 *   (`mars:bundle:refresh`) that must be run deliberately before committing
 *   changes to the framework's own .claude/ tree.
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

  it('syncs the .claude/ config tree when running from the main working tree', () => {
    const mainRepo = join(tmpDir, 'main')
    mkdirSync(mainRepo)
    setupMainRepo(mainRepo)

    const settingsTemplatePath = join(
      mainRepo,
      'orchestrator',
      'src',
      'init',
      'templates',
      'claude',
      'settings.json',
    )

    const result = spawnSync('bash', ['./scripts/sync-claude-templates.sh'], {
      cwd: join(mainRepo, 'orchestrator'),
      stdio: 'pipe',
    })

    expect(result.status).toBe(0)
    // `.claude/settings.json` MUST have been synced into the template tree.
    expect(readFileSync(settingsTemplatePath, 'utf8')).toBe(CLAUDE_SETTINGS_CONTENT)
  })

  it('does NOT overwrite the bundled CLAUDE.md template (it is hand-maintained)', () => {
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
    // Template MUST be untouched — the framework's CLAUDE.md describes the
    // mars-framework codebase, while the bundled template carries the
    // Mars-meta content shipped to target repos. They have diverged on
    // purpose; syncing would re-couple them.
    expect(readFileSync(templatePath, 'utf8')).toBe(TEMPLATE_CLAUDE_MD_CONTENT)
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

describe('sync-claude-templates — package.json lifecycle hook contract', () => {
  const PACKAGE_JSON_PATH = resolve(__dirname, '../../../package.json')

  it('mars:bundle:refresh script exists and invokes sync-claude-templates.sh', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['mars:bundle:refresh']).toBeDefined()
    expect(pkg.scripts['mars:bundle:refresh']).toContain('sync-claude-templates.sh')
  })

  it('prebuild does not invoke the template sync script', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts: Record<string, string>
    }
    const prebuild = pkg.scripts['prebuild'] ?? ''
    expect(prebuild).not.toContain('sync-claude-templates')
  })

  it('pretest does not invoke the template sync script', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts: Record<string, string>
    }
    const pretest = pkg.scripts['pretest'] ?? ''
    expect(pretest).not.toContain('sync-claude-templates')
  })
})
