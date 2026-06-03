/**
 * Tests for the activate-plugin step of mars init.
 *
 * Behaviour under test (routed through tryActivatePlugin with injected deps):
 *   - after the step runs, settings.json at the given path contains the
 *     framework .claude dir in plugins (acceptance criterion a)
 *   - the step does NOT throw when the framework dir is not a Mars plugin
 *     directory (acceptance criterion b — missing dir)
 *   - the step does NOT throw when writeSettings throws (acceptance
 *     criterion b — unwritable settings file)
 *   - running twice leaves exactly one mars entry (acceptance criterion c)
 */

import { describe, it, expect } from 'vitest'
import { tryActivatePlugin } from './init-workflow.js'
import type { ClaudePluginDeps } from '../commands/claude-plugin.js'

// ---------------------------------------------------------------------------
// Test infrastructure — in-memory deps, never touches the real filesystem
// ---------------------------------------------------------------------------

function makeDeps(
  initial: Record<string, unknown> = {},
  marsPluginDirs: string[] = [],
): ClaudePluginDeps & { store: Record<string, unknown> } {
  let store: Record<string, unknown> = { ...initial }
  const marsSet = new Set(marsPluginDirs)

  return {
    get store() {
      return store
    },
    readSettings: (_path: string) => ({ ...store }),
    writeSettings: (_path: string, settings: Record<string, unknown>) => {
      store = { ...settings }
    },
    isMarsPlugin: (dir: string) => marsSet.has(dir),
  }
}

const SETTINGS_PATH = '/tmp/test-home/.claude/settings.json'
const FRAMEWORK_CLAUDE_DIR = '/opt/mars-framework/.claude'
const OTHER_PLUGIN = '/home/user/other-plugin'

// ---------------------------------------------------------------------------
// init activate-plugin step — success path
// ---------------------------------------------------------------------------

describe('init activate-plugin step — success', () => {
  it('registers the framework .claude dir in settings.plugins', () => {
    const deps = makeDeps({}, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toContain(FRAMEWORK_CLAUDE_DIR)
  })

  it('preserves existing non-mars plugins alongside the new entry', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN] }, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toContain(OTHER_PLUGIN)
    expect(deps.store.plugins).toContain(FRAMEWORK_CLAUDE_DIR)
  })

  it('preserves other settings keys (env, permissions, hooks, …)', () => {
    const deps = makeDeps(
      { env: { FOO: 'bar' }, permissions: { allow: [] } },
      [FRAMEWORK_CLAUDE_DIR],
    )
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    expect(deps.store.env).toEqual({ FOO: 'bar' })
    expect(deps.store.permissions).toEqual({ allow: [] })
    expect(deps.store.plugins).toContain(FRAMEWORK_CLAUDE_DIR)
  })
})

// ---------------------------------------------------------------------------
// init activate-plugin step — non-fatal when framework dir is not a Mars plugin
// ---------------------------------------------------------------------------

describe('init activate-plugin step — non-fatal when framework dir is missing', () => {
  it('does not throw when isMarsPlugin returns false', () => {
    const deps = makeDeps() // no dirs in marsSet → isMarsPlugin always false
    expect(() =>
      tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps),
    ).not.toThrow()
  })

  it('does not write to settings when isMarsPlugin returns false', () => {
    const deps = makeDeps()
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// init activate-plugin step — non-fatal when writeSettings throws
// ---------------------------------------------------------------------------

describe('init activate-plugin step — non-fatal when settings file is unwritable', () => {
  it('does not throw when writeSettings throws EACCES', () => {
    const failDeps: ClaudePluginDeps = {
      readSettings: () => ({}),
      writeSettings: () => {
        throw new Error('EACCES: permission denied')
      },
      isMarsPlugin: (dir) => dir === FRAMEWORK_CLAUDE_DIR,
    }

    expect(() =>
      tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, failDeps),
    ).not.toThrow()
  })

  it('does not throw when readSettings throws', () => {
    const failDeps: ClaudePluginDeps = {
      readSettings: () => {
        throw new Error('unexpected read error')
      },
      writeSettings: () => {},
      isMarsPlugin: (dir) => dir === FRAMEWORK_CLAUDE_DIR,
    }

    expect(() =>
      tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, failDeps),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// init activate-plugin step — idempotency
// ---------------------------------------------------------------------------

describe('init activate-plugin step — idempotent (double-run)', () => {
  it('running twice leaves exactly one mars entry in plugins', () => {
    const deps = makeDeps({}, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const plugins = deps.store.plugins as string[]
    expect(
      plugins.filter((p) => p === FRAMEWORK_CLAUDE_DIR),
    ).toHaveLength(1)
  })

  it('preserves non-mars plugins across multiple runs', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN] }, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const plugins = deps.store.plugins as string[]
    expect(plugins).toContain(OTHER_PLUGIN)
    expect(plugins.filter((p) => p === OTHER_PLUGIN)).toHaveLength(1)
  })
})
