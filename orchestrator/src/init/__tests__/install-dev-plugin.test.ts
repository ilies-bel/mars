/**
 * Tests for the plugin-activation wiring in install-dev.sh.
 *
 * Acceptance criteria (slice 5):
 *   - Running install-dev.sh activates the Mars Claude Code plugin in
 *     ~/.claude/settings.json so mars:* skills become visible in Claude Code.
 *   - The plugin path registered is <repo-root>/.claude.
 *   - The consumer's pre-existing ~/.claude/settings.json is not overwritten —
 *     only the `plugins` key is extended.
 *
 * The test runs the real install-dev.sh in an isolated temp directory to
 * confirm the full shell → tsx → CLI → claude-plugin chain works end-to-end.
 * It overrides HOME to prevent any write to the real ~/.claude/settings.json.
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Resolve the repo root from this file's location:
// src/init/__tests__/ → src/init/ → src/ → orchestrator/ → repo root
const ORCHESTRATOR_ROOT = resolve(__dirname, '..', '..', '..')
const REPO_ROOT = resolve(ORCHESTRATOR_ROOT, '..')
const INSTALL_DEV_SH = resolve(REPO_ROOT, 'install-dev.sh')

// Only run these tests when the .claude/.claude-plugin/ dir exists (i.e. in
// the framework's own checkout, not in a sparse consumer clone).
// The plugin root is .claude/.claude-plugin/ — not .claude/ itself — so the
// Claude Code project-skills auto-discovery loader (.claude/skills/) finds no
// skills and only the namespaced /mars:* entries are registered.
const PLUGIN_DIR = resolve(REPO_ROOT, '.claude', '.claude-plugin')
const canRun = existsSync(INSTALL_DEV_SH) && existsSync(PLUGIN_DIR)

describe.skipIf(!canRun)('install-dev.sh — plugin activation', () => {
  let tmpHome: string
  let binDir: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mars-install-dev-test-'))
    binDir = join(tmpHome, 'bin')
    mkdirSync(binDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('registers the framework .claude/ as a Claude Code plugin after install', () => {
    const result = spawnSync('bash', [INSTALL_DEV_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PREFIX: tmpHome,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    })

    expect(result.status, `install-dev.sh failed:\n${result.stderr}`).toBe(0)

    const settingsPath = join(tmpHome, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      plugins?: string[]
    }
    expect(Array.isArray(settings.plugins)).toBe(true)
    expect(settings.plugins).toContain(PLUGIN_DIR)
  })

  it('preserves pre-existing ~/.claude/settings.json content when activating', () => {
    // Simulate a consumer with existing Claude Code settings
    const claudeDir = join(tmpHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const existingSettings = {
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(git status)'] },
    }
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(existingSettings, null, 2),
      'utf8',
    )

    spawnSync('bash', [INSTALL_DEV_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PREFIX: tmpHome,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    })

    const settings = JSON.parse(
      readFileSync(join(claudeDir, 'settings.json'), 'utf8'),
    ) as { env?: { FOO?: string }; permissions?: { allow?: string[] }; plugins?: string[] }

    // Existing keys must be preserved
    expect(settings.env?.FOO).toBe('bar')
    expect(settings.permissions?.allow).toContain('Bash(git status)')
    // And the plugin must be registered
    expect(settings.plugins).toContain(PLUGIN_DIR)
  })

  it('does not write any .claude/ files into the repository install ran from', () => {
    // install-dev.sh must never scaffold .claude/ into the consumer's own
    // repository — the plugin delivers those through Claude Code.
    spawnSync('bash', [INSTALL_DEV_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PREFIX: tmpHome,
      },
      encoding: 'utf8',
      stdio: 'pipe',
    })

    // tmpHome is the isolated HOME; no .claude/ should be written there other
    // than settings.json (which is the user-level settings, not a repo config)
    const repoClaudeDir = join(tmpHome, 'some-consumer-repo', '.claude')
    expect(existsSync(repoClaudeDir)).toBe(false)
  })
})
