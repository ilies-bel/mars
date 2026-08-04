/**
 * "Install codegraph and I will cost you less."
 *
 * Mars cannot see how many files a Worker read — that happens inside the
 * provider CLI. What it can see is how many Workers it sent into the codebase
 * with no index to consult, and whether any of them ever reached a graph
 * traversal tool. That is the evidence this Notice is built from, and the
 * copy claims nothing more than it.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'

export interface CodegraphSuggestion {
  tasksRun: number
  windowDays: number
}

export interface DetectCodegraphSuggestionOptions {
  repoRoot: string
  windowDays?: number
  /** Minimum tasks before an index would plausibly have paid for itself. */
  threshold?: number
  now?: () => number
}

const DEFAULTS = { windowDays: 7, threshold: 25 } as const

/**
 * Whether any graph-traversal MCP server is wired up for this repo.
 *
 * Matched on the server *name* rather than a fixed list of vendors: an
 * operator who installed a different traversal tool has solved the problem,
 * and Mars nagging them to install a specific one would be advertising.
 */
const TRAVERSAL_HINTS = ['codegraph', 'code-graph', 'graph-traversal', 'ast-graph'] as const

const hasTraversalConfigured = async (repoRoot: string): Promise<boolean> => {
  for (const file of ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json']) {
    let raw: string
    try {
      raw = await readFile(resolve(repoRoot, file), 'utf8')
    } catch {
      continue
    }
    const haystack = raw.toLowerCase()
    if (TRAVERSAL_HINTS.some((hint) => haystack.includes(hint))) return true
  }
  return false
}

/**
 * Returns the suggestion only when traversal is absent *and* enough work has
 * gone through the codebase for the absence to have cost anything.
 */
export const detectCodegraphSuggestion = async (
  c: DbClient,
  options: DetectCodegraphSuggestionOptions,
): Promise<CodegraphSuggestion | null> => {
  const windowDays = options.windowDays ?? DEFAULTS.windowDays
  const threshold = options.threshold ?? DEFAULTS.threshold
  const now = (options.now ?? Date.now)()
  const sinceMs = now - windowDays * 24 * 60 * 60 * 1000

  if (await hasTraversalConfigured(options.repoRoot)) return null

  // A Worker that reached a traversal tool proves one is available whatever
  // the config files say.
  const used = await c.execute({
    sql: `SELECT 1 FROM mcp_worker_audit
           WHERE tool_name ILIKE '%codegraph%'
             AND created_at >= to_timestamp(? / 1000.0)
           LIMIT 1`,
    args: [sinceMs],
  })
  if (used.rows.length > 0) return null

  const ran = await c.execute({
    sql: `SELECT count(*) AS n FROM tasks
           WHERE status = 'done'
             AND updated_at >= to_timestamp(? / 1000.0)`,
    args: [sinceMs],
  })
  const tasksRun = Number((ran.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
  if (tasksRun < threshold) return null

  return { tasksRun, windowDays }
}
