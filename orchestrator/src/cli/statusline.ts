import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
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
 * Pure function: builds a lease prefix for the status line when the current
 * session is running inside a Mars-leased worktree (.mars/worktrees/<id>/).
 *
 * When the task is parked at a named step, renders `step <name> · <mode>`
 * so the operator immediately sees which step they own and whether it is
 * manual (parked, awaiting human) or auto (running headlessly).
 *
 * Falls back to showing the Step guide (leaseNote) when present; otherwise
 * shows the task intent (title).
 * Returns '' when taskId is null. Never throws.
 */
export function buildLeaseSegment(
  taskId: string | null,
  title: string | null,
  stepGuide?: string | null,
  stepName?: string | null,
  stepMode?: 'manual' | 'auto' | null,
): string {
  if (!taskId) return ''
  // Show at most the first 12 chars of the task ID (mars- prefix + 7 hex chars)
  const shortId = taskId.length > 12 ? taskId.slice(0, 12) : taskId
  // When the task is parked at a named step, surface step name and execution
  // mode so the operator immediately sees which step they own.
  if (stepName) {
    const mode = stepMode ?? 'auto'
    return `⛏ ${shortId} · step ${stepName} · ${mode} · `
  }
  // Fallback: prefer the Step guide (leaseNote) when present — it's the
  // current-step context, which is more actionable than the overall task intent.
  const rawLabel = stepGuide || title
  const truncLabel = rawLabel
    ? rawLabel.length > 30
      ? rawLabel.slice(0, 29) + '…'
      : rawLabel
    : ''
  const label = truncLabel ? `${shortId} ${truncLabel}` : shortId
  return `⛏ ${label} · `
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

    // Detect if cwd sits inside a Mars-leased worktree and, if so, read the
    // task row for the lease segment prefix via the daemon's HTTP API
    // (`/view/tasks`, port published to `.mars/http.port`) with a tight
    // timeout so the status bar never stalls. When the daemon is down the
    // segment is simply omitted — no fallback process is spawned.
    // Reads currentStepName to render `step <name> · <mode>` when the task
    // is parked at a named step; falls back to leaseNote / intent otherwise.
    let leaseTaskId: string | null = null
    let leaseTitle: string | null = null
    let leaseStepGuide: string | null = null
    let leaseStepName: string | null = null
    let leaseStepMode: 'manual' | 'auto' | null = null
    try {
      const marsWorktreeSeg = `${sep}.mars${sep}worktrees${sep}`
      const idx = cwd.indexOf(marsWorktreeSeg)
      if (idx !== -1) {
        const afterSeg = cwd.slice(idx + marsWorktreeSeg.length)
        // Task ID is the first path segment after .mars/worktrees/
        const taskId = afterSeg.split(sep)[0]
        if (taskId) {
          const repoRoot = cwd.slice(0, idx)
          const portFile = join(repoRoot, '.mars', 'http.port')
          if (existsSync(portFile)) {
            const port = Number.parseInt(readFileSync(portFile, 'utf8').trim(), 10)
            if (Number.isInteger(port) && port > 0) {
              const res = await fetch(`http://127.0.0.1:${port}/view/tasks`, {
                signal: AbortSignal.timeout(300),
              })
              if (res.ok) {
                const body = (await res.json()) as {
                  tasks?: Array<{
                    id?: string
                    intent?: string | null
                    leasedAt?: string | null
                    leaseNote?: string | null
                    currentStepName?: string | null
                  }>
                }
                const row = (body.tasks ?? []).find((t) => t.id === taskId)
                if (row) {
                  const leasedAt = row.leasedAt ?? null
                  const leaseNoteVal = row.leaseNote ?? null
                  const stepNameVal = row.currentStepName ?? null
                  // Activate the lease segment when leased (manual step parked)
                  // or when a named step is active (auto step visible to anyone
                  // in the worktree directory). Tasks that are queued/done with
                  // no active step produce no segment, falling back to today's
                  // rendering.
                  if (leasedAt !== null || stepNameVal !== null) {
                    leaseTaskId = row.id ?? null
                    leaseTitle = row.intent ?? null
                    leaseStepGuide = leaseNoteVal
                    leaseStepName = stepNameVal
                    leaseStepMode = stepNameVal
                      ? leasedAt !== null
                        ? 'manual'
                        : 'auto'
                      : null
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Lease detection failed (daemon down, timeout, etc.) — proceed without lease segment.
    }

    const leasePfx = buildLeaseSegment(leaseTaskId, leaseTitle, leaseStepGuide, leaseStepName, leaseStepMode)
    const line = leasePfx + buildStatusLine(branch, cache) + buildContextSegment(contextRemainingPct)
    process.stdout.write(`${line}\n`)
  } catch {
    // Last-resort safety net: print something minimal and exit 0.
    process.stdout.write('mars\n')
  }
}
