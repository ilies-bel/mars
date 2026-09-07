/**
 * Hot-paths view module.
 *
 * Aggregates per-file (or per-directory) change frequency over a rolling
 * window by walking `git log --name-only` on the integration branch.
 *
 * Results are cached keyed on (HEAD sha × window × group) so repeated calls
 * during the same commit are free, but the cache invalidates automatically
 * as soon as a new commit lands. Unneeded entries are evicted after the next
 * HEAD advance so the map stays bounded.
 *
 * Generated and vendored paths are excluded (dist/, node_modules/,
 * *.generated.*, lock files) to avoid noise from churn that the operator
 * does not maintain.
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve as resolvePath, dirname, basename } from 'node:path'
import { resolveGitBin, execProbe } from '../../lib/git/internal'
import type { HotPathEntry, HotPathsResult } from '../http-server'

export type WindowKey = '30d' | '90d' | 'all'

const WINDOW_DAYS: Record<WindowKey, number | null> = {
  '30d': 30,
  '90d': 90,
  all: null,
}

// ── Path filters ──────────────────────────────────────────────────────────────

/**
 * Paths/patterns excluded from the hot-paths aggregation.
 * These represent generated or vendored content the operator does not maintain.
 */
const EXCLUDED_PREFIXES = [
  'dist/',
  'node_modules/',
  '.yarn/',
  '.pnp',
  'build/',
  'coverage/',
  '.next/',
  'out/',
]

const EXCLUDED_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',
])

const EXCLUDED_SUFFIXES = [
  '.generated.ts',
  '.generated.tsx',
  '.generated.js',
  '.generated.d.ts',
  '.gen.ts',
  '.gen.tsx',
  '.g.ts',
  '.min.js',
  '.min.css',
]

const isExcluded = (file: string): boolean => {
  if (EXCLUDED_BASENAMES.has(basename(file))) return true
  for (const prefix of EXCLUDED_PREFIXES) {
    if (file.startsWith(prefix) || file.includes(`/${prefix.replace(/\/$/, '')}/`)) return true
  }
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (file.endsWith(suffix)) return true
  }
  return false
}

// ── Scoped paths (match the reference pipeline) ───────────────────────────────

/**
 * Only paths under these prefixes are included.
 * Mirrors the reference pipeline: `git log … -- orchestrator/src ui/src`.
 * An empty array means no scope filter (all paths included).
 */
const SCOPE_PREFIXES: string[] = ['orchestrator/src', 'ui/src', 'packages/']

const isInScope = (file: string): boolean => {
  if (SCOPE_PREFIXES.length === 0) return true
  return SCOPE_PREFIXES.some((p) => file.startsWith(p))
}

// ── SHA-keyed in-process cache ─────────────────────────────────────────────────

interface CacheEntry {
  result: HotPathsResult
  headSha: string
}

const cache = new Map<string, CacheEntry>()

// ── Tombstone shape ───────────────────────────────────────────────────────────

interface Tombstone {
  taskId: string
  mergeCommitSha?: string | null
  reason?: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the hot-paths aggregation for a given window and group mode.
 *
 * Caches results keyed on `"${headSha}:${window}:${group}"` so repeated
 * requests within the same commit are free; any new commit lands and the
 * key naturally misses.
 */
export const buildHotPathsView = async (opts: {
  stateDir: string
  repoRoot: string
  window: WindowKey
  group: 'file' | 'dir'
}): Promise<HotPathsResult> => {
  const { stateDir, repoRoot, window, group } = opts

  // Resolve HEAD sha for cache keying.
  const gitBin = resolveGitBin()
  const headResult = await execProbe(gitBin, ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  }).catch(() => null)
  const headSha =
    headResult?.exitCode === 0 ? headResult.stdout.trim() : `ts:${Date.now()}`

  const cacheKey = `${headSha}:${window}:${group}`
  const cached = cache.get(cacheKey)
  if (cached) return cached.result

  // Evict entries whose HEAD sha is no longer current.
  for (const [key, entry] of cache.entries()) {
    if (entry.headSha !== headSha) cache.delete(key)
  }

  const result = await computeHotPaths({ stateDir, repoRoot, window, group, gitBin })
  cache.set(cacheKey, { result, headSha })
  return result
}

// ── Cache invalidation (for tests) ───────────────────────────────────────────

/** @internal Clears the in-process cache — intended for tests only. */
export const clearHotPathsCache = (): void => cache.clear()

// ── Core computation ──────────────────────────────────────────────────────────

async function computeHotPaths(opts: {
  stateDir: string
  repoRoot: string
  window: WindowKey
  group: 'file' | 'dir'
  gitBin: string
}): Promise<HotPathsResult> {
  const { stateDir, repoRoot, window, group, gitBin } = opts

  // Build tombstone lookup: mergeCommitSha → taskId
  const shaToTask = new Map<string, string>()
  try {
    const worktreesDir = resolvePath(stateDir, 'worktrees')
    const entries = await readdir(worktreesDir).catch(() => [] as string[])
    await Promise.all(
      entries
        .filter((e) => e.endsWith('.removed.json'))
        .map(async (entry) => {
          try {
            const raw = await readFile(resolvePath(worktreesDir, entry), 'utf8')
            const parsed = JSON.parse(raw) as Tombstone
            if (typeof parsed.mergeCommitSha === 'string' && parsed.mergeCommitSha) {
              shaToTask.set(parsed.mergeCommitSha, parsed.taskId)
            }
          } catch {
            // Skip malformed tombstone
          }
        }),
    )
  } catch {
    // .mars/worktrees directory may not exist yet — treat as empty
  }

  // Build git log args
  const logArgs: string[] = ['log', '--name-only', '--format=COMMIT:%H %aI']
  const sinceDays = WINDOW_DAYS[window]
  if (sinceDays !== null) {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    logArgs.push(`--since=${since}`)
  }
  // Scope to the paths the operator maintains
  if (SCOPE_PREFIXES.length > 0) {
    logArgs.push('--', ...SCOPE_PREFIXES)
  }

  const logResult = await execProbe(gitBin, logArgs, { cwd: repoRoot }).catch(() => null)

  if (!logResult || logResult.exitCode !== 0 || !logResult.stdout.trim()) {
    return { paths: [], window, total: 0 }
  }

  // Parse the git log output.
  //
  // Each commit produces:
  //   COMMIT:<sha> <ISO-date>
  //   <blank>
  //   file1
  //   file2
  //   <blank>   ← before the next COMMIT header (or end of output)

  interface CommitEntry {
    sha: string
    date: string
    files: string[]
  }

  const commits: CommitEntry[] = []
  let current: CommitEntry | null = null

  for (const rawLine of logResult.stdout.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('COMMIT:')) {
      if (current) commits.push(current)
      const rest = line.slice('COMMIT:'.length)
      const spaceIdx = rest.indexOf(' ')
      const sha = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)
      const date = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim()
      current = { sha, date, files: [] }
    } else if (current && line) {
      current.files.push(line)
    }
  }
  if (current) commits.push(current)

  // Aggregate per path — skip generated/vendored files

  interface PathStats {
    changes: number
    tasks: Set<string>
    lastChangedAt: string
    touchedByHumans: number
    touchedByMars: number
  }

  const pathStats = new Map<string, PathStats>()

  for (const commit of commits) {
    const taskId = shaToTask.get(commit.sha)
    const isMars = taskId !== undefined

    for (const file of commit.files) {
      if (isExcluded(file)) continue

      const key = group === 'dir' ? (dirname(file) || '.') : file
      let stats = pathStats.get(key)
      if (!stats) {
        stats = {
          changes: 0,
          tasks: new Set(),
          lastChangedAt: '',
          touchedByHumans: 0,
          touchedByMars: 0,
        }
        pathStats.set(key, stats)
      }
      stats.changes++
      if (commit.date && commit.date > stats.lastChangedAt) {
        stats.lastChangedAt = commit.date
      }
      if (isMars) {
        stats.tasks.add(taskId)
        stats.touchedByMars++
      } else {
        stats.touchedByHumans++
      }
    }
  }

  // Sort by change count desc, cap at 60
  const paths: HotPathEntry[] = Array.from(pathStats.entries())
    .sort((a, b) => b[1].changes - a[1].changes)
    .slice(0, 60)
    .map(([path, stats]) => ({
      path,
      changes: stats.changes,
      tasks: Array.from(stats.tasks),
      lastChangedAt: stats.lastChangedAt,
      touchedByHumans: stats.touchedByHumans,
      touchedByMars: stats.touchedByMars,
    }))

  return { paths, window, total: pathStats.size }
}
