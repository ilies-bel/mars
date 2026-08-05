/**
 * `worktree` command group: `worktree reclaim [--dry-run]`.
 *
 * `worktree reclaim` enumerates every directory under `.mars/worktrees/`,
 * joins each entry against the task store, classifies it, computes its
 * disk footprint, and prints a table. Nothing is deleted; the command is
 * always read-only (dry-run is the default and only supported mode for
 * this slice).
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  classifyWorktree,
  computeDirBytes,
  probeWorktreeGitState,
  SAFE_CATEGORIES,
} from '../../core/lib/worktree-reclaim'
import { hasFlag } from '../args'
import type { Command } from '../command'

/** Format bytes as a human-readable string (KB / MB / GB). */
const humanBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const INTEGRATION_BRANCH = process.env.INTEGRATION_BRANCH ?? 'main'
const PROBE_CONCURRENCY = 8

const worktreeReclaim: Command = {
  path: 'worktree reclaim',
  summary: 'classify worktrees by task status and report reclaimable disk usage',
  usage: 'usage: mars worktree reclaim [--dry-run]',
  run: async (args, deps) => {
    // --dry-run is the default and only supported mode; accept the flag for
    // forward compatibility but do not change behaviour based on it.
    if (hasFlag(args, '--no-dry-run')) {
      deps.err('error: deletion mode is not yet supported; remove --no-dry-run')
      return { code: 2 }
    }

    const worktreesDir = join(deps.ctx.repoRoot, '.mars', 'worktrees')

    let entries: string[]
    try {
      entries = await readdir(worktreesDir)
    } catch {
      deps.out('no worktrees directory found — nothing to reclaim')
      return { code: 0 }
    }

    // One DB round-trip for all tasks; build a lookup map by id.
    const allTasks = await deps.store.listTasks()
    const taskById = new Map(allTasks.map((t) => [t.id, t]))

    // Probe git state in bounded-parallelism chunks
    const gitStates = new Map<string, Awaited<ReturnType<typeof probeWorktreeGitState>>>()
    for (let i = 0; i < entries.length; i += PROBE_CONCURRENCY) {
      const chunk = entries.slice(i, i + PROBE_CONCURRENCY)
      const results = await Promise.all(
        chunk.map(async (name) => {
          const wPath = join(worktreesDir, name)
          const state = await probeWorktreeGitState(wPath, INTEGRATION_BRANCH)
          return [name, state] as const
        }),
      )
      for (const [name, state] of results) gitStates.set(name, state)
    }

    // Table header
    deps.out('ID'.padEnd(20) + 'STATUS'.padEnd(22) + 'CATEGORY'.padEnd(28) + 'BYTES')
    deps.out('-'.repeat(90))

    let reclaimCount = 0
    let reclaimBytes = 0

    for (const name of entries) {
      const worktreePath = join(worktreesDir, name)
      const task = taskById.get(name) ?? null
      const gitState = gitStates.get(name) ?? null
      const lease = task?.leaseOwner ? { owner: task.leaseOwner } : null
      const { category, reason: _reason } = classifyWorktree({
        id: name,
        task,
        gitState,
        lease,
      })
      const bytes = await computeDirBytes(worktreePath)

      const statusStr = task ? task.status : '(no task)'
      deps.out(
        name.padEnd(20) +
          statusStr.padEnd(22) +
          category.padEnd(28) +
          humanBytes(bytes),
      )

      if (SAFE_CATEGORIES.has(category)) {
        reclaimCount++
        reclaimBytes += bytes
      }
    }

    deps.out('-'.repeat(80))
    deps.out(
      `Reclaimable: ${reclaimCount} entr${reclaimCount === 1 ? 'y' : 'ies'}, ${humanBytes(reclaimBytes)}`,
    )
    deps.out('(dry-run — nothing was deleted)')
    return { code: 0 }
  },
}

export const worktreeCommands: readonly Command[] = [worktreeReclaim]
