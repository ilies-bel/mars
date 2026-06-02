/**
 * Tests for the activate-plugin step of mars init.
 *
 * Behaviour under test (routed through tryActivatePlugin with injected deps):
 *   - after the step runs, settings.json has enabledPlugins["mars@mars"] = true
 *     and extraKnownMarketplaces["mars"] pointing to the framework .claude dir
 *     (acceptance criterion a)
 *   - the step does NOT throw when the framework dir is not a Mars plugin
 *     directory (acceptance criterion b — missing dir)
 *   - the step does NOT throw when writeSettings throws (acceptance
 *     criterion b — unwritable settings file)
 *   - running twice leaves exactly one mars entry (acceptance criterion c)
 */

import { describe, it, expect } from 'vitest'
import { tryActivatePlugin, getFrameworkClaudeDir } from './init-workflow.js'
import { realDeps } from '../commands/claude-plugin.js'
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
const PLUGIN_KEY = 'mars@mars'
const MARKETPLACE_KEY = 'mars'

// ---------------------------------------------------------------------------
// init activate-plugin step — success path
// ---------------------------------------------------------------------------

describe('init activate-plugin step — success', () => {
  it('sets enabledPlugins["mars@mars"] = true', () => {
    const deps = makeDeps({}, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins[PLUGIN_KEY]).toBe(true)
  })

  it('registers the framework .claude dir in extraKnownMarketplaces["mars"].source.path', () => {
    const deps = makeDeps({}, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<
      string,
      { source: { path: string } }
    >
    expect(marketplaces[MARKETPLACE_KEY].source.path).toBe(FRAMEWORK_CLAUDE_DIR)
  })

  it('preserves other settings keys (env, permissions, hooks, …)', () => {
    const deps = makeDeps(
      { env: { FOO: 'bar' }, permissions: { allow: [] } },
      [FRAMEWORK_CLAUDE_DIR],
    )
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    expect(deps.store.env).toEqual({ FOO: 'bar' })
    expect(deps.store.permissions).toEqual({ allow: [] })
    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins[PLUGIN_KEY]).toBe(true)
  })

  it('preserves existing non-mars enabledPlugins entries', () => {
    const deps = makeDeps({ enabledPlugins: { 'other@marketplace': true } }, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins['other@marketplace']).toBe(true)
    expect(enabledPlugins[PLUGIN_KEY]).toBe(true)
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

    expect(deps.store.enabledPlugins).toBeUndefined()
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
// getFrameworkClaudeDir — path resolution
// ---------------------------------------------------------------------------

describe('getFrameworkClaudeDir — path resolution', () => {
  it('resolves to <frameworkRoot>/.claude, not orchestrator/.claude', () => {
    const dir = getFrameworkClaudeDir()
    // Must end with /<repoName>/.claude — not /orchestrator/.claude
    expect(dir).toMatch(/\/\.claude$/)
    expect(dir).not.toMatch(/orchestrator\/\.claude$/)
  })

  it('resolved directory is a real Mars plugin directory (contains .claude-plugin/plugin.json with name=mars)', () => {
    const dir = getFrameworkClaudeDir()
    expect(realDeps.isMarsPlugin(dir)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// init activate-plugin step — idempotency
// ---------------------------------------------------------------------------

describe('init activate-plugin step — idempotent (double-run)', () => {
  it('running twice leaves exactly one mars@mars entry in enabledPlugins', () => {
    const deps = makeDeps({}, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const pluginKeys = Object.keys(
      deps.store.enabledPlugins as Record<string, boolean>,
    ).filter((k) => k === PLUGIN_KEY)
    expect(pluginKeys).toHaveLength(1)
  })

  it('running twice leaves exactly one mars entry in extraKnownMarketplaces', () => {
    const deps = makeDeps({}, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const marketplaceKeys = Object.keys(
      deps.store.extraKnownMarketplaces as Record<string, unknown>,
    ).filter((k) => k === MARKETPLACE_KEY)
    expect(marketplaceKeys).toHaveLength(1)
  })

  it('preserves non-mars enabledPlugins entries across multiple runs', () => {
    const deps = makeDeps({ enabledPlugins: { 'other@marketplace': true } }, [FRAMEWORK_CLAUDE_DIR])
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)
    tryActivatePlugin(FRAMEWORK_CLAUDE_DIR, SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins['other@marketplace']).toBe(true)
    const otherKeys = Object.keys(enabledPlugins).filter((k) => k === 'other@marketplace')
    expect(otherKeys).toHaveLength(1)
  })
})
