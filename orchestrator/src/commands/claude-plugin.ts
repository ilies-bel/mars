/**
 * claude-plugin — activate or deactivate the Mars Claude Code plugin.
 *
 * The Mars Claude Code config (mars:* skills, agents, hooks, settings) is
 * delivered to consumers as a Claude Code plugin sourced from the installed
 * framework directory — never copied into the consumer's own repository.
 *
 * Claude Code loads plugins via the `enabledPlugins` map in
 * ~/.claude/settings.json (keyed `name@marketplace`), and discovers the
 * marketplace directory via the `extraKnownMarketplaces` map. The plugin dir
 * must contain a `.claude-plugin/plugin.json` manifest and optionally a
 * `.claude-plugin/marketplace.json` marketplace declaration.
 *
 * On install: `activatePlugin` registers `pluginDir` as the `mars` marketplace
 * in `extraKnownMarketplaces` and sets `enabledPlugins["mars@mars"] = true`.
 * On update: the same call replaces the prior marketplace path with the new one.
 * On uninstall: `deactivatePlugin` removes both entries.
 *
 * The Mars plugin is identified by checking `.claude-plugin/plugin.json` in the
 * candidate directory for `"name": "mars"`. This works regardless of the install
 * path (dev checkout vs. prod binary location).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PLUGIN_NAME = 'mars'
const MARKETPLACE_NAME = 'mars'
const PLUGIN_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`

export interface ClaudePluginDeps {
  /**
   * Read and parse `path` as JSON. Return `{}` (not throw) when the file is
   * absent or unparseable — the caller treats missing settings as empty.
   */
  readSettings: (path: string) => Record<string, unknown>
  /**
   * Serialise `settings` to JSON and write it to `path`. Must create parent
   * directories as needed.
   */
  writeSettings: (path: string, settings: Record<string, unknown>) => void
  /**
   * Return true when `dir` is the Mars plugin directory — i.e. when
   * `<dir>/.claude-plugin/plugin.json` exists and has `"name": "mars"`.
   */
  isMarsPlugin: (dir: string) => boolean
}

/**
 * Inject real filesystem I/O. Used by install-dev.sh (via CLI) and
 * `mars uninstall`.
 */
export const realDeps: ClaudePluginDeps = {
  readSettings: (path: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  },
  writeSettings: (path: string, settings: Record<string, unknown>): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  },
  isMarsPlugin: (dir: string): boolean => {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { name?: string }
      return parsed?.name === PLUGIN_NAME
    } catch {
      return false
    }
  },
}

/**
 * Register `pluginDir` as the active Mars Claude Code plugin in the user-level
 * Claude Code settings file at `userSettingsPath`.
 *
 * Sets `enabledPlugins["mars@mars"] = true` and registers the plugin directory
 * as the `mars` marketplace in `extraKnownMarketplaces`. If a Mars plugin entry
 * already exists (identified by these fixed keys), it is replaced — the update
 * scenario. All other keys in the settings object are preserved.
 */
export function activatePlugin(
  pluginDir: string,
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): void {
  const settings = deps.readSettings(userSettingsPath)

  const extraKnownMarketplaces = (
    typeof settings.extraKnownMarketplaces === 'object' &&
    settings.extraKnownMarketplaces !== null
      ? settings.extraKnownMarketplaces
      : {}
  ) as Record<string, unknown>

  const enabledPlugins = (
    typeof settings.enabledPlugins === 'object' && settings.enabledPlugins !== null
      ? settings.enabledPlugins
      : {}
  ) as Record<string, unknown>

  deps.writeSettings(userSettingsPath, {
    ...settings,
    extraKnownMarketplaces: {
      ...extraKnownMarketplaces,
      [MARKETPLACE_NAME]: { source: { source: 'local', path: pluginDir } },
    },
    enabledPlugins: {
      ...enabledPlugins,
      [PLUGIN_KEY]: true,
    },
  })
}

/**
 * Remove the Mars Claude Code plugin entry from the user-level Claude Code
 * settings file at `userSettingsPath`.
 *
 * Removes `enabledPlugins["mars@mars"]` and the `mars` entry from
 * `extraKnownMarketplaces`. If no Mars plugin is currently registered (i.e.
 * `enabledPlugins["mars@mars"]` is absent), this is a no-op. All other
 * plugins and keys are preserved. Empty `enabledPlugins` or
 * `extraKnownMarketplaces` objects are dropped entirely rather than left as
 * empty objects.
 */
export function deactivatePlugin(
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): void {
  const settings = deps.readSettings(userSettingsPath)

  const enabledPlugins = settings.enabledPlugins
  if (
    typeof enabledPlugins !== 'object' ||
    enabledPlugins === null ||
    !(PLUGIN_KEY in (enabledPlugins as Record<string, unknown>))
  ) {
    return
  }

  const updatedEnabledPlugins = { ...(enabledPlugins as Record<string, unknown>) }
  delete updatedEnabledPlugins[PLUGIN_KEY]

  const extraKnownMarketplaces =
    typeof settings.extraKnownMarketplaces === 'object' &&
    settings.extraKnownMarketplaces !== null
      ? { ...(settings.extraKnownMarketplaces as Record<string, unknown>) }
      : {}
  delete extraKnownMarketplaces[MARKETPLACE_NAME]

  const updated: Record<string, unknown> = { ...settings }

  if (Object.keys(updatedEnabledPlugins).length > 0) {
    updated.enabledPlugins = updatedEnabledPlugins
  } else {
    delete updated.enabledPlugins
  }

  if (Object.keys(extraKnownMarketplaces).length > 0) {
    updated.extraKnownMarketplaces = extraKnownMarketplaces
  } else {
    delete updated.extraKnownMarketplaces
  }

  deps.writeSettings(userSettingsPath, updated)
}

/**
 * Return the path of the installed Mars plugin directory, or `null` when no
 * Mars plugin is currently registered.
 *
 * Reads the path from `extraKnownMarketplaces["mars"].source.path`, which is
 * written by `activatePlugin`. Used by `mars uninstall` to display the plugin
 * path before removing it.
 */
export function resolveActivePluginDir(
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): string | null {
  const settings = deps.readSettings(userSettingsPath)

  const enabledPlugins = settings.enabledPlugins
  if (
    typeof enabledPlugins !== 'object' ||
    enabledPlugins === null ||
    !(enabledPlugins as Record<string, unknown>)[PLUGIN_KEY]
  ) {
    return null
  }

  const extraKnownMarketplaces = settings.extraKnownMarketplaces
  if (typeof extraKnownMarketplaces !== 'object' || extraKnownMarketplaces === null) {
    return null
  }

  const marketplace = (extraKnownMarketplaces as Record<string, unknown>)[MARKETPLACE_NAME]
  if (typeof marketplace !== 'object' || marketplace === null) {
    return null
  }

  const src = (marketplace as Record<string, unknown>).source
  if (typeof src !== 'object' || src === null) {
    return null
  }

  const path = (src as Record<string, unknown>).path
  return typeof path === 'string' ? path : null
}
