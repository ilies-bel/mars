/**
 * claude-plugin — activate or deactivate the Mars Claude Code plugin.
 *
 * The Mars Claude Code config (mars:* skills, agents, hooks, settings) is
 * delivered to consumers as a Claude Code plugin sourced from the installed
 * framework directory — never copied into the consumer's own repository.
 *
 * On install: `activatePlugin` registers the framework's `.claude/` directory
 * in the user-level `~/.claude/settings.json` under the `plugins` key.
 * On update: the same call replaces the prior plugin path with the newly
 * installed one.
 * On uninstall: `deactivatePlugin` removes the entry.
 *
 * The Mars plugin root is the `.claude/` directory, which contains both
 * `.claude-plugin/` (holding `plugin.json` and `marketplace.json`) and
 * `skills/` (holding the individual skill implementations). The plugin is
 * identified by checking `<dir>/plugin.json` OR `<dir>/.claude-plugin/plugin.json`
 * for `"name": "mars"`. This works regardless of the install path
 * (dev checkout vs. prod binary location) and is backward-compatible with
 * any prior installation that registered `.claude/.claude-plugin/` directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PLUGIN_NAME = 'mars'

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
   * `<dir>/plugin.json` OR `<dir>/.claude-plugin/plugin.json` exists and
   * has `"name": "mars"`. The two-path check lets the Mars plugin root be
   * `.claude/` (recommended) while remaining backward-compatible with
   * older installs that registered `.claude/.claude-plugin/` directly.
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
    const candidates = [
      join(dir, 'plugin.json'),
      join(dir, '.claude-plugin', 'plugin.json'),
    ]
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(
          readFileSync(candidate, 'utf8'),
        ) as { name?: string }
        if (parsed?.name === PLUGIN_NAME) return true
      } catch {
        // try next candidate
      }
    }
    return false
  },
}

/**
 * Register `pluginDir` as the active Mars Claude Code plugin in the user-level
 * Claude Code settings file at `userSettingsPath`.
 *
 * If a Mars plugin entry already exists in `settings.plugins` (identified via
 * `deps.isMarsPlugin`), it is replaced with the new path — the update
 * scenario. All other keys in the settings object are preserved.
 */
export function activatePlugin(
  pluginDir: string,
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): void {
  const settings = deps.readSettings(userSettingsPath)
  const existing = Array.isArray(settings.plugins)
    ? (settings.plugins as string[])
    : []
  const filtered = existing.filter((d) => !deps.isMarsPlugin(d))
  deps.writeSettings(userSettingsPath, {
    ...settings,
    plugins: [...filtered, pluginDir],
  })
}

/**
 * Remove the Mars Claude Code plugin entry from the user-level Claude Code
 * settings file at `userSettingsPath`.
 *
 * If no Mars plugin is currently registered (or the file does not exist), this
 * is a no-op. All other plugins and keys are preserved. When the `plugins`
 * array becomes empty after removal, the key is dropped entirely rather than
 * left as an empty array.
 *
 * Call this BEFORE removing the plugin directory so that `deps.isMarsPlugin`
 * can still read the directory's `plugin.json` to identify the entry.
 */
export function deactivatePlugin(
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): void {
  const settings = deps.readSettings(userSettingsPath)
  if (!Array.isArray(settings.plugins)) return

  const existing = settings.plugins as string[]
  const filtered = existing.filter((d) => !deps.isMarsPlugin(d))
  if (filtered.length === existing.length) return

  const updated: Record<string, unknown> = { ...settings }
  if (filtered.length > 0) {
    updated.plugins = filtered
  } else {
    delete updated.plugins
  }
  deps.writeSettings(userSettingsPath, updated)
}

/**
 * Return the path of the installed Mars plugin directory, or `null` when no
 * Mars plugin is currently registered.
 *
 * Used by `mars uninstall` to display the plugin path before removing it.
 */
export function resolveActivePluginDir(
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): string | null {
  const settings = deps.readSettings(userSettingsPath)
  if (!Array.isArray(settings.plugins)) return null
  return (
    (settings.plugins as string[]).find((d) => deps.isMarsPlugin(d)) ?? null
  )
}
