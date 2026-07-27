/**
 * App boot discovery — inspects a repo root and returns the thinnest runnable
 * dev-server plan the verifier can use without any per-task configuration.
 *
 * The function is intentionally pure (reads the filesystem, no network, no
 * child processes) so it can be called inside a `runNonLlmStepWithSpan` and
 * in unit tests against fixture directories.
 *
 * Discovery order:
 *  1. Known framework config files (Vite, Next, Astro, SvelteKit) at the root.
 *  2. package.json `dev` or `start` script at the root.
 *  3. Steps 1–2 repeated for common UI subdirectories (ui, frontend, web,
 *     client, app) so monorepo layouts are handled without per-task config.
 *
 * Returns null when no runnable surface is found — the caller (behaviour-verify)
 * resolves that to CAN'T-VERIFY, which is always a soft outcome.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface BootPlan {
  /** The shell command to start the dev server, e.g. `npm run dev`. */
  cmd: string
  /** Working directory for `cmd` — the detected project root. */
  cwd: string
  /**
   * The URL the dev server is expected to serve on (framework default or
   * `http://localhost:3000` as fallback). The actual port may differ when the
   * server is started with an injected `PORT` env variable; callers that
   * actually spawn a server update this field before recording the run.
   */
  url: string
  /** Human-readable explanation of why this plan was chosen. */
  reason: string
}

// ---------------------------------------------------------------------------
// Framework detection table
// ---------------------------------------------------------------------------

const FRAMEWORK_MARKERS: ReadonlyArray<{
  files: ReadonlyArray<string>
  cmd: string
  url: string
  reason: string
}> = [
  {
    files: ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'],
    cmd: 'npm run dev',
    url: 'http://localhost:5173',
    reason: 'vite project detected (vite.config found)',
  },
  {
    files: ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.mts'],
    cmd: 'npm run dev',
    url: 'http://localhost:3000',
    reason: 'next.js project detected (next.config found)',
  },
  {
    files: ['astro.config.ts', 'astro.config.js', 'astro.config.mjs', 'astro.config.mts'],
    cmd: 'npm run dev',
    url: 'http://localhost:4321',
    reason: 'astro project detected (astro.config found)',
  },
  {
    files: ['svelte.config.js', 'svelte.config.ts'],
    cmd: 'npm run dev',
    url: 'http://localhost:5173',
    reason: 'sveltekit project detected (svelte.config found)',
  },
]

/** Common UI subdirectory names to probe after the repo root. */
const UI_SUBDIRS: ReadonlyArray<string> = ['ui', 'frontend', 'web', 'client', 'app']

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const readScripts = (dir: string): Record<string, string> | null => {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const scripts = pkg.scripts
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return null
    return scripts as Record<string, string>
  } catch {
    return null
  }
}

/**
 * Probe a single directory for framework markers then package.json scripts.
 * Returns a BootPlan anchored to `dir`, or null.
 */
const probeDir = (dir: string): BootPlan | null => {
  // 1. Framework-specific config files take precedence over generic scripts.
  for (const marker of FRAMEWORK_MARKERS) {
    for (const file of marker.files) {
      if (existsSync(join(dir, file))) {
        return { cmd: marker.cmd, cwd: dir, url: marker.url, reason: marker.reason }
      }
    }
  }

  // 2. Fallback to package.json scripts.
  const scripts = readScripts(dir)
  if (scripts === null) return null

  if (scripts.dev) {
    return {
      cmd: 'npm run dev',
      cwd: dir,
      url: 'http://localhost:3000',
      reason: 'package.json "dev" script found',
    }
  }
  if (scripts.start) {
    return {
      cmd: 'npm start',
      cwd: dir,
      url: 'http://localhost:3000',
      reason: 'package.json "start" script found',
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect `repoRoot` (and common UI subdirectories) to discover how to boot
 * the repo's dev server. Returns a {@link BootPlan} when a runnable surface is
 * found, or `null` when the repo carries no detectable UI.
 *
 * This is a pure filesystem read — no processes are spawned and no network is
 * touched.
 */
export const discoverAppBoot = (repoRoot: string): BootPlan | null => {
  const rootPlan = probeDir(repoRoot)
  if (rootPlan !== null) return rootPlan

  for (const sub of UI_SUBDIRS) {
    const subDir = join(repoRoot, sub)
    if (!existsSync(subDir)) continue
    const plan = probeDir(subDir)
    if (plan !== null) return plan
  }

  return null
}
