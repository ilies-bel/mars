/**
 * Tests for the Claude Code plugin activate/deactivate module.
 *
 * Behaviour under test:
 *   - activatePlugin registers the plugin dir in ~/.claude/settings.json
 *   - activatePlugin replaces an existing mars plugin entry (update scenario)
 *   - activatePlugin preserves all other settings keys
 *   - activatePlugin preserves non-mars plugin entries
 *   - deactivatePlugin removes the mars plugin entry
 *   - deactivatePlugin is a no-op when no mars plugin is registered
 *   - deactivatePlugin drops the plugins key when it becomes empty
 *   - deactivatePlugin preserves non-mars plugin entries
 *   - resolveActivePluginDir returns the registered mars plugin path
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
const OTHER_PLUGIN = '/home/user/other-plugin'

// ---------------------------------------------------------------------------
// activatePlugin
// ---------------------------------------------------------------------------

describe('activatePlugin — fresh install (no prior settings)', () => {
  it('writes settings.plugins containing the plugin dir', () => {
    const deps = makeDeps()
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toEqual([PLUGIN_DIR])
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

describe('activatePlugin — when no plugins key exists', () => {
  it('creates the plugins key with the single entry', () => {
    const deps = makeDeps({ hooks: {} })
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toEqual([PLUGIN_DIR])
    expect(deps.store.hooks).toEqual({})
  })
})

describe('activatePlugin — update scenario (existing mars plugin)', () => {
  it('replaces the prior mars plugin path with the new one', () => {
    const oldDir = '/old/mars-framework/.claude'
    const deps = makeDeps({ plugins: [oldDir] }, [oldDir])
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).not.toContain(oldDir)
    expect(deps.store.plugins).toContain(PLUGIN_DIR)
  })

  it('does not duplicate the entry when activated twice with the same path', () => {
    const deps = makeDeps({ plugins: [PLUGIN_DIR] }, [PLUGIN_DIR])
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect((deps.store.plugins as string[]).filter((p) => p === PLUGIN_DIR)).toHaveLength(1)
  })
})

describe('activatePlugin — preserves non-mars plugins', () => {
  it('keeps existing non-mars plugins when adding the mars plugin', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN] })
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toContain(OTHER_PLUGIN)
    expect(deps.store.plugins).toContain(PLUGIN_DIR)
  })

  it('keeps non-mars plugins when replacing an existing mars plugin', () => {
    const oldDir = '/old/.claude'
    const deps = makeDeps({ plugins: [OTHER_PLUGIN, oldDir] }, [oldDir])
    activatePlugin(PLUGIN_DIR, SETTINGS_PATH, deps)

    expect(deps.store.plugins).toContain(OTHER_PLUGIN)
    expect(deps.store.plugins).toContain(PLUGIN_DIR)
    expect(deps.store.plugins).not.toContain(oldDir)
  })
})

// ---------------------------------------------------------------------------
// deactivatePlugin
// ---------------------------------------------------------------------------

describe('deactivatePlugin — removes the registered mars plugin', () => {
  it('removes the mars plugin dir from settings.plugins', () => {
    const deps = makeDeps({ plugins: [PLUGIN_DIR] }, [PLUGIN_DIR])
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(Array.isArray(deps.store.plugins)
      ? (deps.store.plugins as string[]).includes(PLUGIN_DIR)
      : false
    ).toBe(false)
  })

  it('drops the plugins key entirely when array becomes empty', () => {
    const deps = makeDeps({ plugins: [PLUGIN_DIR] }, [PLUGIN_DIR])
    deactivatePlugin(SETTINGS_PATH, deps)

    expect('plugins' in deps.store).toBe(false)
  })

  it('preserves other settings keys when removing the mars plugin', () => {
    const deps = makeDeps(
      { plugins: [PLUGIN_DIR], env: { FOO: 'bar' } },
      [PLUGIN_DIR],
    )
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(deps.store.env).toEqual({ FOO: 'bar' })
  })
})

describe('deactivatePlugin — no-op when no mars plugin registered', () => {
  it('does not write settings when no mars plugin exists', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN] })
    const before = JSON.stringify(deps.store)
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(JSON.stringify(deps.store)).toBe(before)
    expect(deps.lastWrittenPath).toBeNull()
  })

  it('does not write settings when plugins key is absent', () => {
    const deps = makeDeps({ env: { X: '1' } })
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(deps.lastWrittenPath).toBeNull()
  })
})

describe('deactivatePlugin — preserves non-mars plugins', () => {
  it('keeps non-mars plugins when removing the mars plugin', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN, PLUGIN_DIR] }, [PLUGIN_DIR])
    deactivatePlugin(SETTINGS_PATH, deps)

    expect(deps.store.plugins).toEqual([OTHER_PLUGIN])
  })

  it('keeps the plugins key when non-mars plugins remain', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN, PLUGIN_DIR] }, [PLUGIN_DIR])
    deactivatePlugin(SETTINGS_PATH, deps)

    expect('plugins' in deps.store).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveActivePluginDir
// ---------------------------------------------------------------------------

describe('resolveActivePluginDir', () => {
  it('returns the registered mars plugin dir', () => {
    const deps = makeDeps({ plugins: [PLUGIN_DIR] }, [PLUGIN_DIR])
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBe(PLUGIN_DIR)
  })

  it('returns null when no mars plugin is registered', () => {
    const deps = makeDeps({ plugins: [OTHER_PLUGIN] })
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })

  it('returns null when plugins key is absent', () => {
    const deps = makeDeps({})
    expect(resolveActivePluginDir(SETTINGS_PATH, deps)).toBeNull()
  })
})
