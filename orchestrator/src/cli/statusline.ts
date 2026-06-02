import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

interface UpdateCache {
  available?: boolean
  latest?: string
}

/**
 * Pure function: builds a GSD-style context-window segment showing
 * how much usable context remains before auto-compaction triggers.
 * Never throws; returns '' when input is absent or invalid.
 */
export function buildContextSegment(
  remainingPercentage: number | null | undefined,
): string {
  if (remainingPercentage == null || isNaN(remainingPercentage)) return ''

  // Claude Code reserves ~16.5% of the window for the auto-compact buffer.
  // Normalise so 16.5 → 0% usable remaining, 100 → 100% usable remaining.
  const AUTO_COMPACT_BUFFER_PCT = 16.5
  const usableRemaining = Math.max(
    0,
    ((remainingPercentage - AUTO_COMPACT_BUFFER_PCT) /
      (100 - AUTO_COMPACT_BUFFER_PCT)) *
      100,
  )
  const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)))
  const remainingToCompact = 100 - used

  // 10-segment block bar.
  const filled = Math.floor(used / 10)
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)

  // Color thresholds by 'used' (GSD style).
  let color: string
  if (used < 50) color = '\x1b[32m' // green
  else if (used < 65) color = '\x1b[33m' // yellow
  else if (used < 80) color = '\x1b[38;5;208m' // orange
  else color = '\x1b[31m' // red

  return ` ${color}${bar} ${remainingToCompact}% left\x1b[0m`
}

/**
 * Pure function: builds the one-line status string.
 * Never throws; safe to call with any input.
 */
export function buildStatusLine(
  branch: string | null,
  cache: UpdateCache | null,
): string {
  const base = branch ? `mars · ${branch}` : 'mars'
  const nudge =
    cache?.available === true && cache.latest
      ? `  ⚡ v${cache.latest} available`
      : ''
  return `${base}${nudge}`
}

/**
 * Side-effectful entry point: reads stdin, resolves repo, prints one line.
 * Exits 0 always — never throws out to the caller.
 */
export async function statuslineCommand(repo?: string): Promise<void> {
  try {
    // Read stdin if piped — Claude Code passes session JSON here.
    // We honour workspace.current_dir when present so the branch reflects
    // the user's active workspace, not the CLI's own CWD.
    let cwd = process.cwd()
    let contextRemainingPct: number | null = null
    if (!process.stdin.isTTY) {
      try {
        const raw = readFileSync(0, 'utf8')
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const workspace = parsed['workspace']
          if (
            workspace !== null &&
            typeof workspace === 'object' &&
            'current_dir' in workspace &&
            typeof (workspace as Record<string, unknown>)['current_dir'] ===
              'string'
          ) {
            cwd = (workspace as Record<string, unknown>)[
              'current_dir'
            ] as string
          }
          // Read context_window.remaining_percentage defensively.
          const contextWindow = parsed['context_window']
          if (contextWindow !== null && typeof contextWindow === 'object') {
            const pct = (contextWindow as Record<string, unknown>)[
              'remaining_percentage'
            ]
            if (typeof pct === 'number') {
              contextRemainingPct = pct
            }
          }
        }
      } catch {
        // Malformed or absent stdin — proceed with process.cwd()
      }
    }

    // Resolve git branch cheaply — 500 ms hard timeout so a slow FS can't
    // stall the Claude Code status bar.
    let branch: string | null = null
    try {
      branch =
        execSync('git rev-parse --abbrev-ref HEAD', {
          cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 500,
        }).trim() || null
    } catch {
      // Not a git repo or git unavailable — emit "mars" without a branch.
    }

    // Read update cache — file only, never network.
    let cache: UpdateCache | null = null
    try {
      const { resolveContext } = await import('../core/context.js')
      const ctx = resolveContext(repo)
      const updatePath = join(ctx.stateDir, 'update.json')
      if (existsSync(updatePath)) {
        cache = JSON.parse(readFileSync(updatePath, 'utf8')) as UpdateCache
      }
    } catch {
      // Can't resolve repo or can't read cache — no nudge.
    }

    const line = buildStatusLine(branch, cache) + buildContextSegment(contextRemainingPct)
    process.stdout.write(`${line}\n`)
  } catch {
    // Last-resort safety net: print something minimal and exit 0.
    process.stdout.write('mars\n')
  }
}
