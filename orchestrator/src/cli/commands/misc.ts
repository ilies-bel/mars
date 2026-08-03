/**
 * Thin / pass-through leaves that do not fit the larger groups: `where`, the
 * `ui` family, `kpi`, `worktree`, `project`, `observability`, `cut`,
 * `statusline`, `triage`, `sweep`.
 *
 * Most delegate to an already-extracted `cli/*` or `core/lib/*` module; the
 * Command wrapper exists so the router stays a pure prefix match with zero
 * bypass branches (ADR-0023 accepts that trivial leaves pay the full
 * ceremony).
 */

import { hasFlag } from '../args'
import type { Command } from '../command'

const where: Command = {
  path: 'where',
  summary: 'print resolved repo/state paths',
  usage: 'usage: mars where',
  run: async (_args, deps) => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    // The live DB is the daemon-provisioned embedded PostgreSQL server; its
    // DSN is published to `.mars/pg.dsn` while the daemon runs.
    const dsnPath = resolve(deps.ctx.stateDir, 'pg.dsn')
    let dbLine = `${dsnPath} (not published — daemon not running)`
    try {
      const dsn = readFileSync(dsnPath, 'utf8').trim()
      if (dsn) dbLine = dsn
    } catch {
      // keep the not-published placeholder
    }
    deps.out(`repo:           ${deps.ctx.repoRoot}`)
    deps.out(`stateDir:       ${deps.ctx.stateDir}`)
    deps.out(`db:             ${dbLine}`)
    return { code: 0 }
  },
}

// ── ui ──────────────────────────────────────────────────────────────────────
// The ui leaves take the raw `--repo` flag, not the resolved context (the
// launcher and pid-file helpers resolve their own paths). `ui stop`/`ui status`
// own their exit behaviour internally.

const uiStop: Command = {
  path: 'ui stop',
  summary: 'stop the read-only UI server',
  usage: 'usage: mars ui stop',
  run: async (args) => {
    const { stopUi } = await import('../ui')
    await stopUi(args.repo)
    return { code: 0 }
  },
}

const uiStatus: Command = {
  path: 'ui status',
  summary: 'print UI server status',
  usage: 'usage: mars ui status',
  run: async (args) => {
    const { statusUi } = await import('../ui')
    statusUi(args.repo)
    return { code: 0 }
  },
}

const uiLaunch: Command = {
  path: 'ui',
  summary: 'launch the read-only Kanban + trace dashboard',
  usage: 'usage: mars ui [--port <p>] [--host <h>] [--dev]',
  run: async (args) => {
    const { launchUi } = await import('../ui')
    launchUi({
      repo: args.repo,
      port: args.flags['--port'],
      host: args.flags['--host'],
      dev: hasFlag(args, '--dev'),
    })
    return { code: 0 }
  },
}

// ── kpi ───────────────────────────────────────────────────────────────────

const kpiSnapshot: Command = {
  path: 'kpi snapshot',
  summary: 'take a KPI snapshot (JSON to stdout)',
  usage: 'usage: mars kpi snapshot',
  run: async (_args, deps) => {
    const { takeKpiSnapshot } = await import('../../core/lib/kpi-snapshots.js')
    const { getDefaultTaskStore } = await import('../../core/store/task-store.js')
    const surface = await getDefaultTaskStore()
    const snapshot = await takeKpiSnapshot({
      surface,
      now: new Date().toISOString(),
    })
    deps.out(JSON.stringify(snapshot, null, 2))
    return { code: 0 }
  },
}

const kpiShow: Command = {
  path: 'kpi show',
  summary: 'show the KPI window comparison (JSON)',
  usage: 'usage: mars kpi show',
  run: async (_args, deps) => {
    const { readKpiWindowComparison } = await import(
      '../../core/lib/kpi-snapshots.js'
    )
    const result = await readKpiWindowComparison({
      now: new Date().toISOString(),
    })
    deps.out(JSON.stringify(result, null, 2))
    return { code: 0 }
  },
}

const kpiGroup: Command = {
  path: 'kpi',
  summary: 'kpi subcommands',
  usage: 'usage: mars kpi <snapshot|show>',
  run: (_args, deps) => {
    deps.err('usage: mars kpi <snapshot|show>')
    return { code: 1 }
  },
}

// ── worktree ────────────────────────────────────────────────────────────────

const worktreePrune: Command = {
  path: 'worktree prune',
  summary: 'prune git worktree administrative refs',
  usage: 'usage: mars worktree prune [--dry-run]',
  run: async (args, deps) => {
    const dryRun = hasFlag(args, '--dry-run')
    const { runWorktreePrune } = await import('../../core/lib/worktree-prune')
    const summary = await runWorktreePrune({
      dryRun,
      log: (line) => deps.out(line),
    })
    if (
      summary.errors > 0 &&
      summary.removed === 0 &&
      summary.keptInFlight === 0 &&
      summary.keptFailed === 0 &&
      summary.keptOther === 0
    ) {
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const worktreeClean: Command = {
  path: 'worktree clean',
  summary: 'remove orphaned task worktrees',
  usage: 'usage: mars worktree clean [--dry-run] [--force-orphans]',
  run: async (args, deps) => {
    const dryRun = hasFlag(args, '--dry-run')
    const forceOrphans = hasFlag(args, '--force-orphans')
    const { runWorktreeClean } = await import('../../core/lib/worktree-clean')
    const summary = await runWorktreeClean({
      dryRun,
      forceOrphans,
      log: (line) => deps.out(line),
    })
    if (
      summary.errors > 0 &&
      summary.removed === 0 &&
      summary.keptInFlight === 0 &&
      summary.keptDesync === 0 &&
      summary.keptOrphan === 0 &&
      summary.keptOther === 0
    ) {
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const worktreeGroup: Command = {
  path: 'worktree',
  summary: 'worktree subcommands',
  usage:
    'usage: mars worktree clean [--dry-run] [--force-orphans]\n       mars worktree prune [--dry-run]\n       mars worktree reclaim [--dry-run]',
  run: (_args, deps) => {
    deps.err('usage: mars worktree clean [--dry-run] [--force-orphans]')
    deps.err('       mars worktree prune [--dry-run]')
    deps.err('       mars worktree reclaim [--dry-run]')
    return { code: 1 }
  },
}

// ── project ─────────────────────────────────────────────────────────────────

const projectAddCmd: Command = {
  path: 'project add',
  summary: 'register a project',
  usage: 'usage: mars project add <path> [--name <label>]',
  run: async (args, deps) => {
    const pathArg = args.positional[0] ?? args.flags['--path']
    if (!pathArg) {
      deps.err('usage: mars project add <path> [--name <label>]')
      return { code: 1 }
    }
    const { projectAdd } = await import('../project.js')
    await projectAdd({ path: pathArg, name: args.flags['--name'] })
    return { code: 0 }
  },
}

const projectListCmd: Command = {
  path: 'project list',
  summary: 'list registered projects',
  usage: 'usage: mars project list',
  run: async () => {
    const { projectList } = await import('../project.js')
    projectList()
    return { code: 0 }
  },
}

const projectRemoveCmd: Command = {
  path: 'project remove',
  summary: 'remove a registered project',
  usage: 'usage: mars project remove <projectId>',
  run: async (args, deps) => {
    const projectId = args.positional[0]
    if (!projectId) {
      deps.err('usage: mars project remove <projectId>')
      return { code: 1 }
    }
    const { projectRemove } = await import('../project.js')
    projectRemove(projectId)
    return { code: 0 }
  },
}

const projectGroup: Command = {
  path: 'project',
  summary: 'project subcommands',
  usage: 'usage: mars project <add|list|remove> ...',
  run: (_args, deps) => {
    deps.err('usage: mars project <add|list|remove> ...')
    return { code: 1 }
  },
}

// ── observability ─────────────────────────────────────────────────────────

const observabilityPrune: Command = {
  path: 'observability prune',
  summary: 'prune old telemetry rows',
  usage: 'usage: mars observability prune [<days>]',
  run: async (args, deps) => {
    const ageArg = args.positional[0]
    let maxAgeDays = 3
    if (ageArg !== undefined) {
      const parsed = Number(ageArg)
      if (!Number.isFinite(parsed) || parsed < 0) {
        deps.err(
          `usage: mars observability prune [<days>]\n\n<days> must be a non-negative number (0 = wipe all); got '${ageArg}'`,
        )
        return { code: 1 }
      }
      maxAgeDays = parsed
    }
    const { pruneObservability } = await import(
      '../../core/lib/observability-prune'
    )
    const { resolveDbTarget } = await import('../../core/context')
    const deleted = await pruneObservability(resolveDbTarget(), maxAgeDays)
    deps.out(`pruned ${deleted} telemetry row${deleted === 1 ? '' : 's'}`)
    return { code: 0 }
  },
}

const observabilityGroup: Command = {
  path: 'observability',
  summary: 'observability subcommands',
  usage: 'usage: mars observability prune [<days>]',
  run: (_args, deps) => {
    deps.err('usage: mars observability prune [<days>]')
    return { code: 2 }
  },
}

// ── db ────────────────────────────────────────────────────────────────────

const dbCompact: Command = {
  path: 'db compact',
  summary: 'prune all high-volume tables, then VACUUM (ANALYZE)',
  usage: 'usage: mars db compact',
  run: async (_args, deps) => {
    const { pruneRetention, RETENTION_BATCH_SIZE } = await import(
      '../../core/lib/retention-prune'
    )
    const { openDb } = await import('../../core/lib/db')
    const { resolveDbTarget } = await import('../../core/context')
    const dbTarget = resolveDbTarget()

    deps.out('Pruning high-volume tables…')

    // Run repeated batched passes until a full pass produces no deletions so
    // large DBs are fully cleaned without any single pass exceeding the
    // batch ceiling.
    let totalTraceByAge = 0
    let totalTraceByCount = 0
    let totalSPE = 0

    while (true) {
      const r = await pruneRetention(dbTarget, {
        batchSize: RETENTION_BATCH_SIZE,
      })
      totalTraceByAge += r.traceEventsByAge
      totalTraceByCount += r.traceEventsByCount
      totalSPE += r.subscriberProcessedEvents
      if (
        r.traceEventsByAge === 0 &&
        r.traceEventsByCount === 0 &&
        r.subscriberProcessedEvents === 0
      ) {
        break
      }
    }

    const totalTrace = totalTraceByAge + totalTraceByCount
    deps.out(
      `  trace_events:               ${totalTrace} row(s) removed` +
        ` (by-age: ${totalTraceByAge}, by-count: ${totalTraceByCount})`,
    )
    deps.out(
      `  subscriber_processed_events: ${totalSPE} orphaned row(s) removed`,
    )

    // VACUUM (ANALYZE): reclaim dead tuples from the prune above and refresh
    // planner statistics. PostgreSQL's autovacuum handles routine upkeep; this
    // is the deliberate operator-run compaction after a bulk prune. Plain
    // VACUUM never takes an exclusive lock, so it is safe alongside a running
    // daemon.
    const client = openDb(dbTarget)
    try {
      deps.out('Running VACUUM (ANALYZE)…')
      await client.execute('VACUUM (ANALYZE)')
      deps.out('  VACUUM complete')
    } finally {
      await client.close()
    }

    return { code: 0 }
  },
}

const dbGroup: Command = {
  path: 'db',
  summary: 'database maintenance subcommands',
  usage: 'usage: mars db compact',
  run: (_args, deps) => {
    deps.err('usage: mars db compact')
    return { code: 2 }
  },
}

// ── cut ──────────────────────────────────────────────────────────────────

const cutVerify: Command = {
  path: 'cut verify',
  summary: 'run the hard-cut gate checks for a phase',
  usage: 'usage: mars cut verify <drain|reset|recreate>',
  run: async (args, deps) => {
    const { isCutPhase, runCutVerify } = await import('../cut-verify.js')
    const phase = args.positional[0]
    if (!isCutPhase(phase)) {
      deps.err(
        `mars cut verify: unknown phase '${phase ?? ''}'\nusage: mars cut verify <drain|reset|recreate>`,
      )
      return { code: 1 }
    }
    await runCutVerify(phase, args.repo)
    return { code: 0 }
  },
}

const cutGroup: Command = {
  path: 'cut',
  summary: 'cut subcommands',
  usage: 'usage: mars cut verify <drain|reset|recreate>',
  run: (_args, deps) => {
    deps.err('usage: mars cut verify <drain|reset|recreate>')
    return { code: 1 }
  },
}

// ── statusline ─────────────────────────────────────────────────────────────

const statusline: Command = {
  path: 'statusline',
  summary: 'print the Claude Code statusline segment',
  usage: 'usage: mars statusline',
  run: async (args) => {
    const { statuslineCommand } = await import('../statusline.js')
    await statuslineCommand(args.repo)
    return { code: 0 }
  },
}

// ── triage ─────────────────────────────────────────────────────────────────

const triage: Command = {
  path: 'triage',
  summary: 'run triage on a draft task, or all draft tasks',
  usage: 'usage: mars triage [<id>]',
  run: async (args, deps) => {
    const { runTriage } = await import('../../workflows/triage-workflow')
    const id = args.positional[0]
    if (id) {
      const result = await runTriage(id)
      deps.out(`[${result.taskId}] actionable=${result.actionable}`)
      if (result.reason) deps.out(`  reason: ${result.reason}`)
      return { code: 0 }
    }
    const drafts = await deps.store.listTasks('draft')
    if (drafts.length === 0) {
      deps.out('no draft tasks')
      return { code: 0 }
    }
    const runs = drafts.map(async (t) => {
      try {
        const result = await runTriage(t.id)
        return { taskId: t.id, ok: true as const, result }
      } catch (err) {
        return {
          taskId: t.id,
          ok: false as const,
          error: (err as Error).message,
        }
      }
    })
    const settled = await Promise.allSettled(runs)
    for (const s of settled) {
      if (s.status !== 'fulfilled') {
        deps.err(`triage rejected: ${String(s.reason)}`)
        continue
      }
      const v = s.value
      if (v.ok) {
        deps.out(`[${v.taskId}] actionable=${v.result.actionable}`)
      } else {
        deps.out(`[${v.taskId}] error: ${v.error}`)
      }
    }
    return { code: 0 }
  },
}

// ── sweep ─────────────────────────────────────────────────────────────────

const sweep: Command = {
  path: 'sweep',
  summary: 'interactively reconcile orphan task branches',
  usage: 'usage: mars sweep',
  run: async (_args, deps) => {
    if (!process.stdin.isTTY) {
      deps.err(
        'mars sweep: stdin is not a terminal; an interactive TTY is required to prompt for each orphan branch',
      )
      return { code: 1 }
    }
    const integrationBranch = process.env.INTEGRATION_BRANCH ?? 'main'
    const {
      runSweepVerb,
      listLocalTaskBranches,
      listUniqueCommitsAhead,
      applyCommitsCherryPick,
    } = await import('../../core/lib/sweep')
    const { execFile: cpExecFile } = await import('node:child_process')
    const { promisify: cpPromisify } = await import('node:util')
    const cpExec = cpPromisify(cpExecFile)
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    const askAction = (
      branch: string,
    ): Promise<'keep' | 'delete' | 'cherry-pick'> =>
      new Promise((resolve) => {
        const onClose = (): void => resolve('keep')
        rl.once('close', onClose)
        rl.question(
          `  Action for ${branch} — [k]eep  [d]elete  [c]herry-pick-then-delete > `,
          (answer) => {
            rl.removeListener('close', onClose)
            const a = answer.trim().toLowerCase()
            if (a === 'd' || a === 'delete') return resolve('delete')
            if (
              a === 'c' ||
              a === 'cherry-pick' ||
              a === 'cherry-pick-then-delete'
            ) {
              return resolve('cherry-pick')
            }
            resolve('keep')
          },
        )
      })

    await runSweepVerb({
      integrationBranch,
      log: (line) => deps.out(line),
      deps: {
        listTaskBranches: () => listLocalTaskBranches(deps.ctx.repoRoot),
        getTask: (id) => deps.store.getTask(id),
        listUniqueCommits: (branch, integration) =>
          listUniqueCommitsAhead(branch, integration, deps.ctx.repoRoot),
        prompt: (orphan) => askAction(orphan.branch),
        deleteBranch: async (branch) => {
          await cpExec('git', ['branch', '-D', branch], {
            cwd: deps.ctx.repoRoot,
          })
        },
        cherryPickCommits: (commits) =>
          applyCommitsCherryPick(commits, integrationBranch, deps.ctx.repoRoot),
      },
    })

    rl.close()
    return { code: 0 }
  },
}

export const miscCommands: readonly Command[] = [
  where,
  uiLaunch,
  uiStop,
  uiStatus,
  kpiSnapshot,
  kpiShow,
  kpiGroup,
  worktreePrune,
  worktreeClean,
  worktreeGroup,
  projectAddCmd,
  projectListCmd,
  projectRemoveCmd,
  projectGroup,
  observabilityPrune,
  observabilityGroup,
  dbCompact,
  dbGroup,
  cutVerify,
  cutGroup,
  statusline,
  triage,
  sweep,
]
