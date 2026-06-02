/**
 * Tests for the Claude Code plugin activate/deactivate module.
 *
 * Behaviour under test:
 *   - activatePlugin sets enabledPlugins["mars@mars"] = true
 *   - activatePlugin registers the plugin dir in extraKnownMarketplaces["mars"]
 *   - activatePlugin replaces an existing mars marketplace entry (update scenario)
 *   - activatePlugin is idempotent (no duplicate entries on double activation)
 *   - activatePlugin preserves all other settings keys
 *   - activatePlugin preserves non-mars enabledPlugins entries
 *   - activatePlugin preserves non-mars extraKnownMarketplaces entries
 *   - deactivatePlugin removes enabledPlugins["mars@mars"]
 *   - deactivatePlugin removes extraKnownMarketplaces["mars"]
 *   - deactivatePlugin drops empty enabledPlugins/extraKnownMarketplaces keys
 *   - deactivatePlugin is a no-op when mars@mars is not registered
 *   - deactivatePlugin preserves non-mars plugin entries
 *   - resolveActivePluginDir returns the registered mars plugin path
 *   - resolveActivePluginDir returns null when not activated
 */

import { describe, it, expect } from 'vitest'
import {
  activatePlugin,
  deactivatePlugin,
  resolveActivePluginDir,
  type ClaudePluginDeps,
} from './claude-plugin.js'

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/**
 * Build a ClaudePluginDeps backed by an in-memory settings store so tests
 * never touch the real filesystem or ~/.claude/settings.json.
 *
 * `marsPluginDirs` lists the directories that isMarsPlugin should treat as
 * Mars plugin directories (the rest return false).
 */
function makeDeps(
  initial: Record<string, unknown> = {},
  marsPluginDirs: string[] = [],
): ClaudePluginDeps & {
  store: Record<string, unknown>
  lastWrittenPath: string | null
} {
  let store: Record<string, unknown> = { ...initial }
  let lastWrittenPath: string | null = null
  const marsSet = new Set(marsPluginDirs)

  return {
    get store() {
      return store
    },
    get lastWrittenPath() {
      return lastWrittenPath
    },
    readSettings: (_path: string) => ({ ...store }),
    writeSettings: (path: string, settings: Record<string, unknown>) => {
      lastWrittenPath = path
      store = { ...settings }
    },
    isMarsPlugin: (dir: string) => marsSet.has(dir),
  }
}

const SETTINGS_PATH = '/home/user/.claude/settings.json'
const PLUGIN_DIR = '/home/user/mars-framework/.claude'
const OTHER_PLUGIN_DIR = '/home/user/other-plugin'
const PLUGIN_KEY = 'mars@mars'
const MARKETPLACE_KEY = 'mars'

// ---------------------------------------------------------------------------
// activatePlugin — fresh install
// ---------------------------------------------------------------------------

describe('activatePlugin — fresh install (no prior settings)', () => {
  it('sets enabledPlugins["mars@mars"] = true', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins[PLUGIN_KEY]).toBe(true)
  })

  it('registers the plugin dir in extraKnownMarketplaces["mars"].source.path', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<
      string,
      { source: { source: string; path: string } }
    >
    expect(marketplaces[MARKETPLACE_KEY].source.path).toBe(PLUGIN_DIR)
  })

  it('sets extraKnownMarketplaces["mars"].source.source = "local"', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<
      string,
      { source: { source: string; path: string } }
    >
    expect(marketplaces[MARKETPLACE_KEY].source.source).toBe('local')
  })

  it('writes to the supplied settings path', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.lastWrittenPath).toBe(SETTINGS_PATH)
  })

  it('preserves all other existing keys in settings', () => {
    const deps = makeDeps({ env: { FOO: 'bar' }, permissions: { allow: [] } })
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.store.env).toEqual({ FOO: 'bar' })
    expect(deps.store.permissions).toEqual({ allow: [] })
  })
})

// ---------------------------------------------------------------------------
// activatePlugin — update scenario
// ---------------------------------------------------------------------------

describe('activatePlugin — update scenario (existing mars plugin)', () => {
  it('replaces the prior marketplace path with the new one', () => {
    const oldDir = '/old/mars-framework/.claude'
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: oldDir } },
      },
    })
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<
      string,
      { source: { path: string } }
    >
    expect(marketplaces[MARKETPLACE_KEY].source.path).toBe(PLUGIN_DIR)
  })

  it('does not duplicate enabledPlugins entry when activated twice with the same path', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const pluginKeys = Object.keys(
      deps.store.enabledPlugins as Record<string, boolean>,
    ).filter((k) => k === PLUGIN_KEY)
    expect(pluginKeys).toHaveLength(1)
  })

  it('does not duplicate extraKnownMarketplaces entry when activated twice', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const marketplaceKeys = Object.keys(
      deps.store.extraKnownMarketplaces as Record<string, unknown>,
    ).filter((k) => k === MARKETPLACE_KEY)
    expect(marketplaceKeys).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// activatePlugin — preserves non-mars entries
// ---------------------------------------------------------------------------

describe('activatePlugin — preserves non-mars entries', () => {
  it('preserves non-mars enabledPlugins entries', () => {
    const deps = makeDeps({ enabledPlugins: { 'other@marketplace': true } })
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins['other@marketplace']).toBe(true)
    expect(enabledPlugins[PLUGIN_KEY]).toBe(true)
  })

  it('preserves non-mars extraKnownMarketplaces entries', () => {
    const deps = makeDeps({
      extraKnownMarketplaces: {
        'other-marketplace': { source: { source: 'github', repo: 'x/y' } },
      },
    })
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<string, unknown>
    expect('other-marketplace' in marketplaces).toBe(true)
    expect(MARKETPLACE_KEY in marketplaces).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// deactivatePlugin — removes the registered mars plugin
// ---------------------------------------------------------------------------

describe('deactivatePlugin — removes the registered mars plugin', () => {
  it('removes enabledPlugins["mars@mars"]', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
      },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean> | undefined
    expect(enabledPlugins?.[PLUGIN_KEY]).toBeUndefined()
  })

  it('removes extraKnownMarketplaces["mars"]', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
      },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<string, unknown> | undefined
    expect(marketplaces?.[MARKETPLACE_KEY]).toBeUndefined()
  })

  it('drops the enabledPlugins key entirely when it becomes empty', () => {
    const deps = makeDeps({ enabledPlugins: { [PLUGIN_KEY]: true } })
    deactivatePlugin(SETTINGS_PATH, deps)

    expect('enabledPlugins' in deps.store).toBe(false)
  })

  it('drops the extraKnownMarketplaces key entirely when it becomes empty', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
      },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    expect('extraKnownMarketplaces' in deps.store).toBe(false)
  })

  it('preserves other settings keys when removing the mars plugin', () => {
    const deps = makeDeps(
      { enabledPlugins: { [PLUGIN_KEY]: true }, env: { FOO: 'bar' } },
    )
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(deps.store.env).toEqual({ FOO: 'bar' })
  })
})

// ---------------------------------------------------------------------------
// deactivatePlugin — no-op when no mars plugin registered
// ---------------------------------------------------------------------------

describe('deactivatePlugin — no-op when no mars plugin registered', () => {
  it('does not write settings when enabledPlugins key is absent', () => {
    const deps = makeDeps({ env: { X: '1' } })
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(deps.lastWrittenPath).toBeNull()
  })

  it('does not write settings when mars@mars key is absent from enabledPlugins', () => {
    const deps = makeDeps({ enabledPlugins: { 'other@marketplace': true } })
    const before = JSON.stringify(deps.store)
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(JSON.stringify(deps.store)).toBe(before)
    expect(deps.lastWrittenPath).toBeNull()
  })

  it('does not throw when settings file is empty', () => {
    const deps = makeDeps({})
    expect(() => deactivatePlugin(SETTINGS_PATH, deps)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// deactivatePlugin — preserves non-mars entries
// ---------------------------------------------------------------------------

describe('deactivatePlugin — preserves non-mars entries', () => {
  it('keeps non-mars enabledPlugins entries after deactivation', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true, 'other@marketplace': true },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    const enabledPlugins = deps.store.enabledPlugins as Record<string, boolean>
    expect(enabledPlugins['other@marketplace']).toBe(true)
  })

  it('keeps the enabledPlugins key when non-mars entries remain', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true, 'other@marketplace': false },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    expect('enabledPlugins' in deps.store).toBe(true)
  })

  it('keeps non-mars extraKnownMarketplaces entries after deactivation', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
        'other-marketplace': { source: { source: 'github', repo: 'x/y' } },
      },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    const marketplaces = deps.store.extraKnownMarketplaces as Record<string, unknown>
    expect('other-marketplace' in marketplaces).toBe(true)
  })

  it('keeps the extraKnownMarketplaces key when non-mars entries remain', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
        'other-marketplace': { source: { source: 'github', repo: 'x/y' } },
      },
    })
    deactivatePlugin(SETTINGS_PATH, deps)

    expect('extraKnownMarketplaces' in deps.store).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveActivePluginDir
// ---------------------------------------------------------------------------

describe('resolveActivePluginDir', () => {
  it('returns the plugin dir from extraKnownMarketplaces when mars@mars is enabled', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
      },
    })
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBe(PLUGIN_DIR)
  })

  it('returns null when enabledPlugins key is absent', () => {
    const deps = makeDeps({})
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })

  it('returns null when mars@mars is not in enabledPlugins', () => {
    const deps = makeDeps({ enabledPlugins: { 'other@marketplace': true } })
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })

  it('returns null when mars@mars is false', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: false },
      extraKnownMarketplaces: {
        [MARKETPLACE_KEY]: { source: { source: 'local', path: PLUGIN_DIR } },
      },
    })
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })

  it('returns null when extraKnownMarketplaces is absent', () => {
    const deps = makeDeps({ enabledPlugins: { [PLUGIN_KEY]: true } })
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })

  it('returns null when mars marketplace entry is absent', () => {
    const deps = makeDeps({
      enabledPlugins: { [PLUGIN_KEY]: true },
      extraKnownMarketplaces: { 'other-marketplace': {} },
    })
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Round-trip: activate then deactivate
// ---------------------------------------------------------------------------

describe('activate → deactivate round-trip', () => {
  it('settings return to original state after activate then deactivate', () => {
    const initial = { env: { FOO: 'bar' }, permissions: { allow: [] } }
    const deps = makeDeps(initial)

    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(deps.store).toEqual(initial)
  })

  it('resolveActivePluginDir returns null after deactivation', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })
})
