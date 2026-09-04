/**
 * Hot-paths view module.
 *
 * Aggregates per-file (or per-directory) change frequency over a rolling
 * window by walking `git log --name-only` on the integration branch and
 * attributing each commit to a task via the worktree tombstone files that
 * record `mergeCommitSha` when a branch fast-forwards into main.
 *
 * Results are cached for 60 seconds (keyed on window × group) to keep the
 * endpoint cheap on repeated SSE-driven refreshes.
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve as resolvePath, dirname } from 'node:path'
import { resolveGitBin, execProbe } from '../../lib/git/internal'
import type { HotPathEntry, HotPathsResult } from '../http-server'

type WindowKey = '7d' | '30d' | '90d'

const WINDOW_DAYS: Record<WindowKey, number> = { '7d': 7, '30d': 30, '90d': 90 }

// ── 60-second in-process cache ────────────────────────────────────────────────

interface CacheEntry {
  result: HotPathsResult
  expiresAt: number
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
 * Caches results for 60 s keyed on `"${window}:${group}"`.
 */
export const buildHotPathsView = async (opts: {
  stateDir: string
  repoRoot: string
  window: WindowKey
  group: 'file' | 'dir'
}): Promise<HotPathsResult> => {
  const { stateDir, repoRoot, window, group } = opts
  const cacheKey = `${window}:${group}`
  const now = Date.now()
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.result

  const result = await computeHotPaths({ stateDir, repoRoot, window, group })
  cache.set(cacheKey, { result, expiresAt: now + 60_000 })
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
}): Promise<HotPathsResult> {
  const { stateDir, repoRoot, window, group } = opts

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

  // Compute since date
  const sinceDays = WINDOW_DAYS[window]
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()

  // Run git log — format: COMMIT:<sha> <ISO-date> per commit, then file names
  const gitBin = resolveGitBin()
  const logResult = await execProbe(
    gitBin,
    ['log', `--since=${since}`, '--name-only', '--format=COMMIT:%H %aI'],
    { cwd: repoRoot },
  ).catch(() => null)

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
  //
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

  // Aggregate per path

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

  // Sort by change count desc, cap at 50
  const paths: HotPathEntry[] = Array.from(pathStats.entries())
    .sort((a, b) => b[1].changes - a[1].changes)
    .slice(0, 50)
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
