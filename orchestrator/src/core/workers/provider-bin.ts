/**
 * Provider binary resolution — one place that answers "which executable does
 * this provider run, and does it actually exist?".
 *
 * ## Why this exists (defensive hardening, not an observed root cause)
 *
 * Each headless adapter used to resolve its binary inline, at spawn time, from
 * whatever `PATH` the daemon happened to inherit:
 *
 *   const resolveCodexBin = () => process.env.MARS_CODEX_BIN?.trim() || 'codex'
 *
 * Nothing verified the result, and nothing pinned it. If the daemon's
 * environment cannot resolve the binary, every coder run dies instantly with
 * exit 127 and lands in `coder-exit-nonzero` — a bucket with no diagnostic
 * content at all — while `which codex` in the operator's own shell keeps
 * saying everything is fine. That is a failure mode worth making impossible
 * even though it is not what any observed incident turned out to be.
 *
 * Two guards live here:
 *   1. {@link resolveProviderBin} performs a real executability check across
 *      `PATH` plus the POSIX fallback dirs, and reports what it searched, so
 *      the daemon can refuse to start with an actionable message.
 *   2. {@link providerBinPath} resolves ONCE per process and caches the
 *      absolute path, so a mid-session `PATH` change cannot silently break
 *      every subsequent run.
 */

import { isAbsolute, join } from 'node:path'
import { FALLBACK_CLAUDE_PATH_DIRS, isExecutableFile } from '../lib/git/internal'
import type { ProviderName } from './provider-types'

/** Env var that pins each provider's binary path. */
export const PROVIDER_BIN_ENV: Readonly<Record<ProviderName, string>> = {
  claude: 'MARS_CLAUDE_BIN',
  codex: 'MARS_CODEX_BIN',
  gemini: 'MARS_GEMINI_BIN',
}

/** Bare executable name searched on PATH when no env override is set. */
export const PROVIDER_BIN_NAME: Readonly<Record<ProviderName, string>> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
}

export interface ProviderBinResolution {
  provider: ProviderName
  /** The env var consulted for an override. */
  envVar: string
  /** The override's value, when set. */
  override: string | null
  /** Bare executable name searched when no override is set. */
  binaryName: string
  /** Absolute path to an existing executable, or `null` when unresolvable. */
  path: string | null
  /** Directories searched, in order. Empty when an override short-circuited. */
  searchedDirs: readonly string[]
  /** The `PATH` the daemon actually inherited (verbatim). */
  pathEnv: string
}

const candidateNames = (provider: ProviderName): readonly string[] => {
  const base = PROVIDER_BIN_NAME[provider]
  return process.platform === 'win32' ? [`${base}.exe`, `${base}.cmd`] : [base]
}

/**
 * Test seam. Production always passes nothing and reads the live environment;
 * tests pin `pathEnv`/`fallbackDirs` so the host machine's real
 * `/opt/homebrew/bin` cannot leak into an assertion.
 */
export interface ResolveProviderBinOptions {
  pathEnv?: string
  fallbackDirs?: readonly string[]
}

const searchDirs = (opts: ResolveProviderBinOptions): readonly string[] => {
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const fallback =
    opts.fallbackDirs ?? (process.platform === 'win32' ? [] : FALLBACK_CLAUDE_PATH_DIRS)
  const dirs = (opts.pathEnv ?? process.env.PATH ?? '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const dir of [...dirs, ...fallback]) {
    if (seen.has(dir) || !isAbsolute(dir)) continue
    seen.add(dir)
    ordered.push(dir)
  }
  return ordered
}

/**
 * Resolve a provider's binary, verifying that the result is an existing
 * executable file. Never throws; the verdict is in `path` (`null` = not found).
 *
 * An env override is honoured verbatim — including a bare name, which is then
 * searched on PATH like any other — so operators can point at a non-standard
 * install without also having to fix PATH.
 */
export const resolveProviderBin = (
  provider: ProviderName,
  opts: ResolveProviderBinOptions = {},
): ProviderBinResolution => {
  const envVar = PROVIDER_BIN_ENV[provider]
  const raw = process.env[envVar]?.trim()
  const override = raw && raw.length > 0 ? raw : null
  const binaryName = PROVIDER_BIN_NAME[provider]
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? ''

  if (override !== null && isAbsolute(override)) {
    return {
      provider,
      envVar,
      override,
      binaryName,
      path: isExecutableFile(override) ? override : null,
      searchedDirs: [],
      pathEnv,
    }
  }

  const names = override !== null ? [override] : candidateNames(provider)
  const dirs = searchDirs(opts)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) {
        return {
          provider,
          envVar,
          override,
          binaryName,
          path: candidate,
          searchedDirs: dirs,
          pathEnv,
        }
      }
    }
  }
  return { provider, envVar, override, binaryName, path: null, searchedDirs: dirs, pathEnv }
}

// Resolve-once cache. Populated by the first call (normally the daemon's
// startup pre-flight) and reused for every spawn thereafter, so a mid-session
// PATH change cannot silently break every subsequent coder run.
const resolved = new Map<ProviderName, string>()

/**
 * The path to spawn for `provider`. Resolved once per process and cached.
 *
 * Falls back to the bare executable name when resolution fails, so `spawn`
 * still surfaces a clean ENOENT (exit 127 → `provider-binary-missing`) rather
 * than this function throwing from inside a workflow step.
 */
export const providerBinPath = (
  provider: ProviderName,
  opts: ResolveProviderBinOptions = {},
): string => {
  const cached = resolved.get(provider)
  if (cached !== undefined) return cached
  const r = resolveProviderBin(provider, opts)
  const value = r.path ?? r.override ?? PROVIDER_BIN_NAME[provider]
  resolved.set(provider, value)
  return value
}

/** Drop the cache. Tests only — production resolves once and keeps it. */
export const resetProviderBinCache = (): void => {
  resolved.clear()
}

/**
 * Render the operator-facing refusal for an unresolvable provider binary.
 * Names the binary, what was searched, and the PATH the DAEMON inherited —
 * the last of which is the whole point: `which codex` in the operator's own
 * shell says nothing about the daemon's environment.
 */
export const describeMissingProviderBin = (r: ProviderBinResolution): string => {
  const what =
    r.override !== null
      ? `${r.envVar}=${r.override}`
      : `'${r.binaryName}' (no ${r.envVar} override set)`
  const where =
    r.searchedDirs.length > 0
      ? `searched ${r.searchedDirs.length} dir(s): ${r.searchedDirs.join(', ')}`
      : 'the override is an absolute path and is not an executable file'
  return (
    `[preflight] worker provider '${r.provider}' binary not found: ${what}; ${where}. ` +
    `PATH inherited by the daemon: ${r.pathEnv || '(empty)'}. ` +
    `Every coder run would fail instantly with exit 127 and no diagnostic. ` +
    `Start the daemon from a shell whose PATH includes the binary, or set ${r.envVar} ` +
    `to its absolute path. Refusing to start.`
  )
}

/** Startup pre-flight verdict for a provider binary. */

export interface ProviderBinCheck {
  ok: boolean
  resolution: ProviderBinResolution
  /** Operator-facing line: the refusal when not ok, a confirmation when ok. */
  message: string
}

/**
 * Startup pre-flight for the effective worker provider's binary. On success it
 * also warms the resolve-once cache, so every later spawn reuses this exact
 * absolute path rather than re-reading PATH.
 */
export const checkProviderBin = (
  provider: ProviderName,
  opts: ResolveProviderBinOptions = {},
): ProviderBinCheck => {
  const resolution = resolveProviderBin(provider, opts)
  if (resolution.path === null) {
    return { ok: false, resolution, message: describeMissingProviderBin(resolution) }
  }
  resolved.set(provider, resolution.path)
  return {
    ok: true,
    resolution,
    message: `[preflight] worker provider '${provider}' binary: ${resolution.path}`,
  }
}
