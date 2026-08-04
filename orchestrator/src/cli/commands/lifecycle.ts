/**
 * Task-lifecycle and top-level query commands: `show`, `set-functional`,
 * `set-technical`, `continue`, `restart`, `purge`, `unblock`,
 * `recover`, `sync`, `drop`, `block`, `list`, `update`.
 *
 * Mutations route through `deps.daemon`; reads through `deps.store`.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { resolveProposalId, getProposal } from '../../core/proposals'
import { hasFlag, readMaybeFile } from '../args'
import type { TaskStatus } from '../../core/queue'
import type { ReconcileSummary } from '../../core/daemon/startup-reconcile'
import type { Command, CommandDeps } from '../command'
import { renderTaskDetail } from './task'
import { renderProposalDetail } from './proposal'
import { errorMessage, readDaemonPort } from './shared'
import {
  fetchActionQueueView,
  renderActionQueueDetail,
} from './action-queue'

const show: Command = {
  path: 'show',
  summary: 'show a task, proposal, or alert by id',
  usage: 'usage: mars show <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars show <id>')
      return { code: 2 }
    }
    const task = await deps.store.getTask(id)
    if (task) {
      await renderTaskDetail(deps, task, 'task')
      return { code: 0 }
    }
    const ideaResolved = await resolveProposalId(id)
    if (ideaResolved.kind === 'ambiguous') {
      deps.err(`ambiguous prefix '${id}' matches ${ideaResolved.count} proposals`)
      return { code: 1 }
    }
    const idea =
      ideaResolved.kind === 'unique' ? await getProposal(ideaResolved.id) : null
    if (idea) {
      await renderProposalDetail(deps, idea, true)
      return { code: 0 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port !== null) {
      try {
        const rows = await fetchActionQueueView(port, 'all')
        const alertRow =
          rows.find((r) => r.id === id || r.entityId === id) ??
          rows.find((r) => r.id.startsWith(id) || r.entityId.startsWith(id))
        if (alertRow) {
          renderActionQueueDetail(deps, alertRow)
          return { code: 0 }
        }
      } catch {
        // Daemon unreachable — fall through to not-found.
      }
    }
    deps.err(`no task, proposal, or alert matching ${id}`)
    return { code: 1 }
  },
}

const makeSetPlan = (kind: 'functional' | 'technical'): Command => ({
  path: `set-${kind}`,
  summary: `set the ${kind} plan text on a draft/queued task`,
  usage: `usage: mars set-${kind} <id> <text|@file>`,
  run: async (args, deps) => {
    const id = args.positional[0]
    const value = args.positional.slice(1).join(' ')
    if (!id || !value) {
      deps.err(`usage: mars set-${kind} <id> <text|@file>`)
      return { code: 2 }
    }
    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`task ${id} not found`)
      return { code: 1 }
    }
    if (task.status !== 'queued' && task.status !== 'draft') {
      deps.err(
        `task ${id} is ${task.status}; plan can only be modified while draft or queued`,
      )
      return { code: 1 }
    }
    const text = readMaybeFile(value)
    const current = task.plan ?? { functional: '', technical: '' }
    const next =
      kind === 'functional'
        ? { ...current, functional: text }
        : { ...current, technical: text }
    await deps.daemon.sendRequest({ op: 'update', id, patch: { plan: next } })
    deps.out(`updated ${id}`)
    return { code: 0 }
  },
})

const makeContinueRestart = (verb: 'continue' | 'restart'): Command => ({
  path: verb,
  summary:
    verb === 'continue'
      ? 'resume failed tasks from their last checkpoint'
      : 'wipe and re-run failed tasks from setup',
  usage:
    verb === 'continue'
      ? `usage: mars ${verb} <id> [<id> ...]`
      : `usage: mars ${verb} <id> [<id> ...] [--force]`,
  helpBody:
    verb === 'continue'
      ? `mars continue <id> [<id> ...]

Resume failed task(s) on their existing worktree and branch, preserving
commits already made by the worker. In short: resume failed tasks from their last checkpoint.
There are no flags in v1.

Code- and verify-phase failures re-enter the coder on the preserved worktree;
code failures first salvage dangling changes and verify failures include the
recorded verify output. Pre-setup failures,
missing worktrees, and legacy rows are Degraded-to-restart and report
degradedToRestart: true.

Refuses (non-zero exit) when the task is not failed or has an in-flight recovery.`
      : `mars restart <id> [<id> ...] [--force]

Use it to wipe and re-run failed tasks from setup on a fresh worktree and
branch. Use --force to restart despite a live recovery.`,
  run: async (args, deps) => {
    const ids = args.positional.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      deps.err(
        verb === 'continue'
          ? `usage: mars ${verb} <id> [<id> ...]`
          : `usage: mars ${verb} <id> [<id> ...] [--force]`,
      )
      return { code: 2 }
    }
    // `--force` is a declared boolean flag, so `parseArgs` routes it to
    // `args.flags` and it never reaches `positional`. Reading it off the
    // positionals silently made the flag a no-op.
    const forceRestart = verb === 'restart' && hasFlag(args, '--force')
    for (const id of ids) {
      let res: unknown
      try {
        res = await deps.daemon.sendRequest(
          verb === 'restart'
            ? { op: 'restart', id, force: forceRestart || undefined }
            : { op: 'continue', id },
        )
      } catch (err) {
        deps.err(`${id}: ${errorMessage(err)}`)
        return { code: 1 }
      }
      let note: string
      if (
        verb === 'continue' &&
        res !== null &&
        typeof res === 'object' &&
        (res as { degradedToRestart?: boolean }).degradedToRestart === true
      ) {
        const fallbackNote = (res as { note?: string }).note
        note = fallbackNote
          ? `queued ${id} for restart from setup — ${fallbackNote}`
          : `queued ${id} for restart from setup (failure was pre-setup; continue and restart are equivalent here)`
      } else if (
        verb === 'continue' &&
        res !== null &&
        typeof res === 'object' &&
        (res as { coderResume?: boolean }).coderResume === true
      ) {
        note = `queued ${id} to continue from code — prior work in worktree preserved (run 'git log' in the worktree to review)`
      } else if (
        verb === 'restart' &&
        res !== null &&
        typeof res === 'object' &&
        (res as { status?: string }).status === 'blocked'
      ) {
        // The restart completed but the task landed in 'blocked' because
        // it still has live incomplete blocker edges. Report honestly rather
        // than printing "queued", which would mislead the operator into
        // thinking the task is about to dispatch.
        note =
          `blocked ${id} — task has incomplete blockers and will not dispatch until they are done.\n` +
          `Run 'mars list ${id}' to see the blocking tasks, or 'mars unblock ${id} <blocker-id>' to remove a specific edge.`
      } else {
        note =
          verb === 'continue'
            ? `queued ${id} to continue from the failed phase`
            : `queued ${id} for restart from setup`
      }
      deps.out(note)
    }
    return { code: 0 }
  },
})

const remerge: Command = {
  path: 'remerge',
  summary: 're-verify and merge an existing branch without re-running the coder',
  usage: 'usage: mars remerge <id> [<id> ...]',
  run: async (args, deps) => {
    const ids = args.positional.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      deps.err('usage: mars remerge <id> [<id> ...]')
      return { code: 2 }
    }
    for (const id of ids) {
      try {
        await deps.daemon.sendRequest({ op: 'remerge', id })
      } catch (err) {
        deps.err(`${id}: ${errorMessage(err)}`)
        return { code: 1 }
      }
      deps.out(`queued ${id} to re-verify and merge the existing branch (no re-code)`)
    }
    return { code: 0 }
  },
}

const purge: Command = {
  path: 'purge',
  summary:
    'purge failed/done/dropped tasks (worktree + branch + row); use mars drop for any status',
  usage: 'usage: mars purge <id> [<id> ...] [--force]',
  run: async (args, deps) => {
    const ids = args.positional.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      deps.err('usage: mars purge <id> [<id> ...] [--force]')
      return { code: 2 }
    }
    const force = hasFlag(args, '--force')
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        await deps.daemon.sendRequest({ op: 'purge', id, force })
        deps.out(`purged ${id}`)
        succeeded++
      } catch (err) {
        deps.err(`${id}: ${errorMessage(err)}`)
        failed++
      }
    }
    if (ids.length > 1) {
      deps.out(`purge complete: ${succeeded} succeeded, ${failed} failed`)
    }
    return { code: failed > 0 ? 1 : 0 }
  },
}

const unblock: Command = {
  path: 'unblock',
  summary: 'phantom-recovery (no blocker ids) or edge-removal',
  usage:
    'usage: mars unblock <id>  |  mars unblock <id> <blocker-id> [<blocker-id> ...]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const blockerArgs = args.positional.slice(1)
    if (!id) {
      deps.err(
        `usage: mars unblock <id>                                     clear all blockers and mark task as failed\n       mars unblock <id> <blocker-id> [<blocker-id> ...]     remove specific blocker edges only`,
      )
      return { code: 2 }
    }
    if (blockerArgs.length === 0) {
      const data = (await deps.daemon.sendRequest({ op: 'unblock', id })) as {
        taskId: string
        outcome: 'unblocked' | 'noop'
        previousStatus: string
      }
      if (data.outcome === 'unblocked') {
        deps.out(
          `unblocked ${data.taskId} (was ${data.previousStatus}; now failed). Use 'mars restart ${data.taskId}' to re-queue.`,
        )
      } else {
        deps.out(`task ${data.taskId} is ${data.previousStatus}; nothing to unblock`)
      }
      return { code: 0 }
    }
    const data = (await deps.daemon.sendRequest({
      op: 'remove-blockers',
      id,
      blockerIds: blockerArgs,
    })) as { taskId: string; removed: string[] }
    deps.out(`unblocked ${data.taskId} from: ${data.removed.join(', ')}`)
    return { code: 0 }
  },
}

const recover: Command = {
  path: 'recover',
  summary: 'recover blocked tasks (all, or one by id)',
  usage: 'usage: mars recover [<id>]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const data = (await deps.daemon.sendRequest({ op: 'recover', id })) as {
      outcomes: Array<{
        taskId: string
        outcome: 'queued' | 'noop' | 'failed' | 'not-blocked'
        retryCount: number
        failureReason?: string
      }>
    }
    if (id) {
      const o = data.outcomes[0]
      if (!o) {
        deps.out('no result')
        return { code: 0 }
      }
      if (o.outcome === 'queued') {
        deps.out(`recovered ${o.taskId}: queued for dispatch`)
      } else if (o.outcome === 'failed') {
        deps.out(`${o.taskId}: failed at unblock (${o.failureReason ?? 'unknown'})`)
      } else if (o.outcome === 'not-blocked') {
        deps.out(`${o.taskId}: not blocked — nothing to recover`)
      } else {
        deps.out(`${o.taskId}: still has unmet blockers`)
      }
    } else {
      const queued = data.outcomes.filter((o) => o.outcome === 'queued')
      const failed = data.outcomes.filter((o) => o.outcome === 'failed')
      const noop = data.outcomes.filter(
        (o) => o.outcome === 'noop' || o.outcome === 'not-blocked',
      )
      deps.out(
        `recovered ${queued.length} task(s)${queued.length > 0 ? `: ${queued.map((o) => o.taskId).join(', ')}` : ''}`,
      )
      if (failed.length > 0) {
        deps.out(
          `failed at unblock: ${failed.map((o) => `${o.taskId} (${o.failureReason ?? 'unknown'})`).join(', ')}`,
        )
      }
      if (noop.length > 0) {
        deps.out(`still blocked: ${noop.map((o) => o.taskId).join(', ')}`)
      }
    }
    return { code: 0 }
  },
}

const printReconcile = (
  deps: CommandDeps,
  summary: ReconcileSummary,
  slicedLabel: string,
): boolean => {
  if (summary.daemonKilledAlerts > 0)
    deps.out(`  daemon-killed alerts raised: ${summary.daemonKilledAlerts}`)
  if (summary.blockerDriftRepaired > 0)
    deps.out(`  blocker-drift repaired: ${summary.blockerDriftRepaired}`)
  if (summary.strandedOriginsFailed > 0)
    deps.out(
      `  origins stranded on a failed recovery, now failed: ${summary.strandedOriginsFailed}`,
    )
  if (summary.orphanedBlockedRequeued > 0)
    deps.out(`  orphaned-blocked re-queued: ${summary.orphanedBlockedRequeued}`)
  if (summary.runningRequeued > 0)
    deps.out(`  stale-running re-queued: ${summary.runningRequeued}`)
  if (summary.orphanSpansSwept > 0)
    deps.out(`  orphan spans swept: ${summary.orphanSpansSwept}`)
  if (summary.verifyingRequeued > 0)
    deps.out(`  verifying re-queued: ${summary.verifyingRequeued}`)
  if (summary.verifyingFailed > 0)
    deps.out(`  verifying marked failed (worktree missing): ${summary.verifyingFailed}`)
  if (summary.mergingFinalized > 0)
    deps.out(`  merging finalized to done: ${summary.mergingFinalized}`)
  if (summary.mergingRequeued > 0)
    deps.out(`  merging re-queued: ${summary.mergingRequeued}`)
  if (summary.stalledProposalsSliced > 0) deps.out(slicedLabel)
  const anyWork =
    summary.daemonKilledAlerts +
      summary.blockerDriftRepaired +
      summary.strandedOriginsFailed +
      summary.orphanedBlockedRequeued +
      summary.runningRequeued +
      summary.orphanSpansSwept +
      summary.verifyingRequeued +
      summary.verifyingFailed +
      summary.mergingFinalized +
      summary.mergingRequeued +
      summary.stalledProposalsSliced >
    0
  if (!anyWork) deps.out('  nothing to reconcile — queue is consistent')
  return anyWork
}

const sync: Command = {
  path: 'sync',
  summary: 'reconcile the queue (via daemon, or standalone if down)',
  usage: 'usage: mars sync',
  run: async (_args, deps) => {
    const { isDaemonAlive } = await import('../../core/daemon/paths')
    const liveness = await isDaemonAlive()

    if (liveness.alive) {
      const summary = (await deps.daemon.sendRequest(
        { op: 'sync' },
      )) as ReconcileSummary
      deps.out('sync complete (via daemon):')
      printReconcile(
        deps,
        summary,
        `  stalled proposals sliced: ${summary.stalledProposalsSliced}`,
      )
      return { code: 0 }
    }

    // Daemon down — run reconcile standalone in this process.
    const { migrateQueueSchema } = await import('../../core/queue')
    await migrateQueueSchema()
    const { runStartupReconcile } = await import('../../core/daemon/startup-reconcile')
    const { EventEmitter } = await import('node:events')
    const bus = new EventEmitter()
    const summary = (await runStartupReconcile({
      log: () => {},
      bus,
      traceStore: null,
      handleProposalSlice: null,
    })) as ReconcileSummary
    deps.out('sync complete (standalone — daemon not running):')
    printReconcile(
      deps,
      summary,
      `  stalled proposals detected (not sliced — daemon down): ${summary.stalledProposalsSliced}`,
    )
    if (
      summary.orphanedBlockedRequeued +
        summary.runningRequeued +
        summary.verifyingRequeued +
        summary.mergingRequeued >
      0
    ) {
      deps.out(
        '  note: tasks re-queued but daemon is not running — start it to dispatch them',
      )
    }
    return { code: 0 }
  },
}

const drop: Command = {
  path: 'drop',
  summary:
    'delete any task entirely regardless of status; use mars purge for terminal tasks only',
  usage: 'usage: mars drop <id> [<id> ...] [--force]',
  run: async (args, deps) => {
    const ids = args.positional.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      deps.err(
        `usage: mars drop <id> [<id> ...] [--force]\n\n` +
          `Delete any task entirely (worktree+branch+row) regardless of\n` +
          `status. Clears every task_blockers row mentioning <id> on either\n` +
          `side, and nulls out any sibling row's fix_for_task_id that\n` +
          `pointed at <id> so the row can be deleted cleanly.\n\n` +
          `Refuses if the task is currently dispatched (running, verifying,\n` +
          `merging, or held by a live worker-pool slot) unless --force is\n` +
          `passed. --force does NOT kill the underlying claude subprocess;\n` +
          `the workflow will continue to its natural end, but the row, the\n` +
          `worktree, and the branch are removed immediately.`,
      )
      return { code: 2 }
    }
    const force = hasFlag(args, '--force')
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        const data = (await deps.daemon.sendRequest({ op: 'drop', id, force })) as {
          taskId: string
          previousStatus: string
          edgesRemoved: { incoming: number; outgoing: number }
          cascadedFixTaskIds: string[]
          worktreeRemoved: boolean
          branchDeleted: boolean
        }
        const parts = [
          `dropped ${data.taskId} (was ${data.previousStatus})`,
          `worktree=${data.worktreeRemoved ? 'removed' : 'absent'}`,
          `branch=${data.branchDeleted ? 'deleted' : 'absent'}`,
          `edges=${data.edgesRemoved.incoming}in/${data.edgesRemoved.outgoing}out`,
        ]
        if (data.cascadedFixTaskIds.length > 0) {
          parts.push(`cascaded fix tasks: ${data.cascadedFixTaskIds.join(', ')}`)
        }
        deps.out(parts.join('; '))
        succeeded++
      } catch (err) {
        deps.err(`${id}: ${errorMessage(err)}`)
        failed++
      }
    }
    if (ids.length > 1) {
      deps.out(`drop complete: ${succeeded} succeeded, ${failed} failed`)
    }
    return { code: failed > 0 ? 1 : 0 }
  },
}

const block: Command = {
  path: 'block',
  summary: 'add task->task blocker edges',
  usage: 'usage: mars block <task-id> <blocker-id> [<blocker-id> ...]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const blockerArgs = args.positional.slice(1)
    if (!id || blockerArgs.length === 0) {
      deps.err('usage: mars block <task-id> <blocker-id> [<blocker-id> ...]')
      return { code: 2 }
    }
    if (blockerArgs.some((b) => b === id)) {
      deps.err(`task ${id} cannot block itself`)
      return { code: 2 }
    }
    const data = (await deps.daemon.sendRequest({
      op: 'block',
      id,
      blockerIds: blockerArgs,
    })) as { taskId: string; blockerIds: string[] }
    deps.out(`blocked ${data.taskId} by: ${data.blockerIds.join(', ')}`)
    return { code: 0 }
  },
}

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  'draft',
  'triaging',
  'queued',
  'running',
  'verifying',
  'awaiting-validation',
  'merging',
  'vega-reconciling',
  'done',
  'failed',
  'dropped',
  'blocked',
])

const LIST_DEFAULT_LIMIT = 10

const list: Command = {
  path: 'list',
  summary: 'list tasks (optionally filtered by status)',
  usage: 'usage: mars list [<status> | --status <status>] [--limit <n>] [--all]',
  run: async (args, deps) => {
    const positionals = args.positional.filter((a) => !a.startsWith('--'))

    const flagStatus = args.flags['--status']
    const positionalStatus = positionals[0]

    // Reject conflicting forms supplied simultaneously with different values.
    if (
      flagStatus !== undefined &&
      positionalStatus !== undefined &&
      flagStatus !== positionalStatus
    ) {
      deps.err(
        `conflicting status values: --status '${flagStatus}' vs positional '${positionalStatus}'; use one form only`,
      )
      return { code: 2 }
    }

    const statusArg = flagStatus ?? positionalStatus
    if (statusArg !== undefined && !VALID_TASK_STATUSES.has(statusArg)) {
      deps.err(
        `unknown status '${statusArg}'; valid values: ${[...VALID_TASK_STATUSES].join(', ')}`,
      )
      return { code: 2 }
    }

    const showAll = hasFlag(args, '--all')

    // --limit <n> is parsed into args.flags by parseArgs (it's in FLAGS_WITH_VALUES).
    let limit: number | undefined
    if (showAll) {
      limit = undefined
    } else if (args.flags['--limit'] !== undefined) {
      const limitRaw = args.flags['--limit']
      const parsed = Number(limitRaw)
      if (!Number.isInteger(parsed) || parsed < 1) {
        deps.err(`--limit must be a positive integer; got '${limitRaw}'`)
        return { code: 2 }
      }
      limit = parsed
    } else {
      limit = LIST_DEFAULT_LIMIT
    }

    const { tasks, total } = await deps.store.listTasksPaged(
      statusArg as TaskStatus,
      limit,
    )

    for (const t of tasks) {
      deps.out(`${t.id}\t${t.status}\tP${t.priority ?? 0}\t${t.prompt.slice(0, 60)}`)
    }

    const showing = tasks.length
    if (showing < total) {
      deps.out(
        `\nShowing ${showing} of ${total} tasks  (use --limit <n> or --all to see more)`,
      )
    } else {
      deps.out(`\n${total} task${total !== 1 ? 's' : ''} total`)
    }

    return { code: 0 }
  },
}

const update: Command = {
  path: 'update',
  summary: 'refresh framework files; diff (never clobber) user-owned workflows',
  usage: 'usage: mars update [--force] [--yes | --accept-all] [--verbose]',
  run: async (args, deps) => {
    const { existsSync } = await import('node:fs')
    const force = hasFlag(args, '--force')
    const yes = hasFlag(args, '--yes') || hasFlag(args, '--no-edit')
    const acceptAll = hasFlag(args, '--accept-all')
    const verbose = hasFlag(args, '--verbose')

    if (yes && acceptAll) {
      deps.err(
        'error: --yes (keep your edits) and --accept-all (take new templates) are mutually exclusive',
      )
      return { code: 2 }
    }

    // Update mutates these repository-owned harness files. Check before the
    // daemon-routed init or workflow reconciliation so a missing --force never
    // leaves the repository half-updated.
    if (!force) {
      const existingHarnesses = ['CLAUDE.md', '.mcp.json', '.gitignore'].filter(
        (rel) => existsSync(resolve(deps.ctx.repoRoot, rel)),
      )
      if (existingHarnesses.length > 0) {
        deps.err(
          `refusing to overwrite existing harness files (pass --force to replace):\n${existingHarnesses
            .map((rel) => `  - ${rel}`)
            .join('\n')}`,
        )
        return { code: 1 }
      }
    }

    // Phase 1: refresh the framework-owned files (CLAUDE.md, …) via the
    // daemon-routed init workflow. `--force` is the only authorization for an
    // existing harness; a fresh harness needs no overwrite permission. Its
    // scaffold-workflows step never clobbers user-owned workflows (it runs
    // force:false) — those are reconciled in phase 2. Running init through the
    // daemon preserves the single-writer guard so the manifest is never
    // corrupted by a concurrent write.
    type InitResult = Awaited<
      ReturnType<typeof import('../../workflows/init-workflow').runInit>
    >
    const initResult = (await deps.daemon.sendRequest({
      op: 'init',
      opts: { force, dryRun: false, verbose },
    })) as InitResult

    if (
      initResult.status === 'aborted-existing' ||
      initResult.status === 'aborted-conflict'
    ) {
      deps.err(initResult.message)
      return { code: 1 }
    }

    deps.out('refreshed framework files:')
    for (const w of initResult.written ?? []) deps.out(`  ${w}`)

    // Phase 2: reconcile user-owned workflows. Identical files refresh
    // silently; diverged owned files show a unified diff and prompt accept/skip
    // (--yes / --no-edit defaults to skip-on-conflict for CI).
    const { updateWorkflows, realLineReader } = await import(
      '../../init/update'
    )
    const result = await updateWorkflows({
      repoRoot: deps.ctx.repoRoot,
      stateDir: deps.ctx.stateDir,
      yes,
      acceptAll,
      readLine: realLineReader,
      out: (s: string): void => deps.out(s),
    })

    const { created, updated, kept, unowned } = result.summary
    deps.out(
      `workflows: ${created} created, ${updated} updated, ` +
        `${kept} kept, ${unowned} unowned`,
    )
    return { code: 0 }
  },
}

const land: Command = {
  path: 'land',
  summary: "land a worktree-ahead task's commits onto the integration branch",
  usage: 'usage: mars land <task-id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars land <task-id>')
      return { code: 2 }
    }

    deps.out(`landing task ${id}…`)

    const { migrateQueueSchema } = await import('../../core/queue')
    await migrateQueueSchema()

    const { landTask } = await import('../../core/land-task')
    const result = await landTask(id)

    switch (result.outcome) {
      case 'landed':
        deps.out(`✓ ${result.message}`)
        return { code: 0 }

      case 'verify-failed':
        deps.err(`verify gate failed — branch left intact`)
        if (result.verifyOutput) deps.err(result.verifyOutput)
        return { code: 1 }

      case 'conflict':
        deps.err(result.message)
        return { code: 1 }

      case 'not-ahead':
        deps.err(result.message)
        return { code: 1 }

      case 'task-not-found':
        deps.err(result.message)
        return { code: 1 }

      case 'no-worktree':
        deps.err(result.message)
        return { code: 1 }

      default: {
        const _exhaustive: never = result.outcome
        deps.err(`unexpected outcome: ${String(_exhaustive)}`)
        return { code: 1 }
      }
    }
  },
}

const release: Command = {
  path: 'release',
  summary: 'release the lease on an awaiting-human task and resume the pipeline',
  usage: 'usage: mars release <task-id> [--abort] [--note <text>]',
  run: async (args, deps) => {
    // --note is in FLAGS_WITH_VALUES so the arg parser stores it in args.flags,
    // not args.positional. --abort is a bare flag and appears in positional.
    const positionals = args.positional
    const abort = positionals.includes('--abort')
    const note: string | undefined = args.flags['--note'] ?? undefined
    const id = positionals.filter((a) => !a.startsWith('--'))[0]

    if (!id) {
      deps.err('usage: mars release <task-id> [--abort] [--note <text>]')
      return { code: 1 }
    }

    // Read task to validate status and find the worktree path for the dirty check.
    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`task ${id} not found`)
      return { code: 1 }
    }
    if (task.status !== 'awaiting-human') {
      deps.err(
        `task ${id} is ${task.status}; can only release an 'awaiting-human' task`,
      )
      return { code: 1 }
    }
    if (task.leaseOwner === null) {
      deps.err(`task ${id} has no active lease`)
      return { code: 1 }
    }

    // Uncommitted-changes guard: refuse if the worktree has staged or
    // unstaged changes. The pipeline's has-diff/commits-ahead checks treat
    // uncommitted work as invisible — the same rule that binds Workers binds
    // humans.
    const worktreePath = task.worktreePath
    if (worktreePath) {
      const gitResult = spawnSync(
        'git',
        ['-C', worktreePath, 'status', '--porcelain'],
        { encoding: 'utf8', timeout: 5000 },
      )
      if (gitResult.status === 0 && (gitResult.stdout ?? '').trim() !== '') {
        deps.err(`worktree ${worktreePath} has uncommitted changes`)
        deps.err(
          'commit your changes before releasing the lease, or restore individual paths with `git checkout <ref> -- <paths>` (never `git stash` — the stash is shared by every worktree in this repo)',
        )
        return { code: 1 }
      }
    }

    // On abort, tear down the preview process before emitting the abort so
    // the dev server does not linger after the task leaves awaiting-human.
    // Best-effort: swallow errors — the preview may not be registered.
    if (abort) {
      try {
        await deps.daemon.sendRequest({ op: 'preview.teardown', taskId: id })
      } catch {
        // preview may not be registered — that is fine
      }
    }

    try {
      await deps.daemon.sendRequest({ op: 'release-lease', id, abort, note })
    } catch (err) {
      deps.err(`${id}: ${errorMessage(err)}`)
      return { code: 1 }
    }

    if (abort) {
      deps.out(`${id}: lease released — task routed to failure path`)
    } else {
      deps.out(`${id}: lease released — task re-queued for pipeline continuation`)
    }
    return { code: 0 }
  },
}

export const lifecycleCommands: readonly Command[] = [
  show,
  makeSetPlan('functional'),
  makeSetPlan('technical'),
  makeContinueRestart('continue'),
  makeContinueRestart('restart'),
  remerge,
  land,
  purge,
  unblock,
  recover,
  sync,
  drop,
  block,
  list,
  update,
  release,
]
