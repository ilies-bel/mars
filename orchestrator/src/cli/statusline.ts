import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

interface UpdateCache {
  available?: boolean
  latest?: string
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
      const { resolveContext } = await import('../mastra/context.js')
      const ctx = resolveContext(repo)
      const updatePath = join(ctx.stateDir, 'update.json')
      if (existsSync(updatePath)) {
        cache = JSON.parse(readFileSync(updatePath, 'utf8')) as UpdateCache
      }
    } catch {
      // Can't resolve repo or can't read cache — no nudge.
    }

    const line = buildStatusLine(branch, cache)
    process.stdout.write(`${line}\n`)
  } catch {
    // Last-resort safety net: print something minimal and exit 0.
    process.stdout.write('mars\n')
  }
}
