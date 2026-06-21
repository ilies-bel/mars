/**
 * Task-lifecycle and top-level query commands: `show`, `set-functional`,
 * `set-technical`, `continue`, `restart`, `purge`, `unblock`,
 * `recover`, `sync`, `drop`, `block`, `list`, `update`.
 *
 * Mutations route through `deps.daemon`; reads through `deps.store`.
 */

import { resolveProposalId, getProposal } from '../../core/proposals'
import { readMaybeFile } from '../args'
import type { TaskStatus } from '../../core/queue'
import type { ReconcileSummary } from '../../core/daemon/startup-reconcile'
import type { Command, CommandDeps } from '../command'
import { renderTaskDetail } from './task'
import { renderProposalDetail } from './proposal'
import { errorMessage } from './shared'
import {
  readDaemonPort,
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
      return { code: 1 }
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
      return { code: 1 }
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
      ? 'resume failed tasks on their existing worktree (code-phase failures auto-commit wip and re-enter code; verify/merge failures re-run from the failed step; refuses when worktree is missing or no phase was recorded)'
      : 'wipe and re-run failed tasks from setup',
  usage: `usage: mars ${verb} <id> [<id> ...]`,
  run: async (args, deps) => {
    const ids = args.positional.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      deps.err(`usage: mars ${verb} <id> [<id> ...]`)
      return { code: 1 }
    }
    for (const id of ids) {
      let res: unknown
      try {
        res = await deps.daemon.sendRequest({ op: verb, id })
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
        (res as { codePhaseResume?: boolean }).codePhaseResume === true
      ) {
        note = `queued ${id} to continue from code phase — prior work in worktree preserved (run 'git log' in the worktree to review)`
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

const purge: Command = {
  path: 'purge',
  summary: 'purge tasks (worktree + branch + row)',
  usage: 'usage: mars purge <id> [<id> ...] [--force]',
  run: async (args, deps) => {
    const flagSet = new Set(args.positional.filter((a) => a.startsWith('--')))
    const ids = args.positional.filter((a) => !a.startsWith('--'))
    if (ids.length === 0) {
      deps.err('usage: mars purge <id> [<id> ...] [--force]')
      return { code: 1 }
    }
    const force = flagSet.has('--force')
    for (const id of ids) {
      try {
        await deps.daemon.sendRequest({ op: 'purge', id, force })
      } catch (err) {
        deps.err(`${id}: ${errorMessage(err)}`)
        return { code: 1 }
      }
      deps.out(`purged ${id}`)
    }
    return { code: 0 }
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
        `usage: mars unblock <id>                       (phantom-recovery: clears all task_blockers, flips 'blocked' or 'queued' -> 'failed' so the row can then be 'mars purge'd)\n       mars unblock <id> <blocker-id> [<blocker-id> ...]  (edge-removal: removes specific edges, status unchanged)`,
      )
      return { code: 1 }
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
  summary: 'delete any task entirely regardless of status',
  usage: 'usage: mars drop <id> [--force]',
  run: async (args, deps) => {
    const flagSet = new Set(args.positional.filter((a) => a.startsWith('--')))
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    const id = positionals[0]
    if (!id) {
      deps.err(
        `usage: mars drop <id> [--force]\n\n` +
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
      return { code: 1 }
    }
    const force = flagSet.has('--force')
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
    return { code: 0 }
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
      return { code: 1 }
    }
    if (blockerArgs.some((b) => b === id)) {
      deps.err(`task ${id} cannot block itself`)
      return { code: 1 }
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

const list: Command = {
  path: 'list',
  summary: 'list tasks (optionally filtered by status)',
  usage: 'usage: mars list [<status>]',
  run: async (args, deps) => {
    const tasks = await deps.store.listTasks(args.positional[0] as TaskStatus)
    for (const t of tasks) {
      const prio = t.priority > 0 ? `\tP${t.priority}` : ''
      deps.out(`${t.id}\t${t.status}${prio}\t${t.prompt.slice(0, 60)}`)
    }
    return { code: 0 }
  },
}

const update: Command = {
  path: 'update',
  summary: 'refresh framework files; diff (never clobber) user-owned workflows',
  usage: 'usage: mars update [--yes | --accept-all] [--verbose] [-f|--config <path>]',
  run: async (args, deps) => {
    const boolFlags = new Set(args.positional.filter((a) => a.startsWith('--')))
    const yes =
      boolFlags.has('--yes') ||
      args.positional.includes('-y') ||
      boolFlags.has('--no-edit')
    const acceptAll = boolFlags.has('--accept-all')
    const verbose = boolFlags.has('--verbose')
    const configPath = args.flags['--config']

    if (yes && acceptAll) {
      deps.err(
        'error: --yes (keep your edits) and --accept-all (take new templates) are mutually exclusive',
      )
      return { code: 1 }
    }

    // Phase 1: refresh the framework-owned files (CLAUDE.md, supervisors, …)
    // via the daemon-routed init workflow with force overwrite. Its
    // scaffold-workflows step never clobbers user-owned workflows (it runs
    // force:false) — those are reconciled in phase 2. Running init through the
    // daemon preserves the single-writer guard so the manifest is never
    // corrupted by a concurrent write.
    type InitResult = Awaited<
      ReturnType<typeof import('../../workflows/init-workflow').runInit>
    >
    let initResult: InitResult
    try {
      initResult = (await deps.daemon.sendRequest({
        op: 'init',
        opts: { force: true, dryRun: false, verbose, ...(configPath ? { configPath } : {}) },
      })) as InitResult
    } catch (err: unknown) {
      const e = err as Error & { code?: string }
      if (e.code?.startsWith('init-config:')) {
        deps.err(`error: ${e.message}`)
        deps.err(`  config: ${e.code.slice('init-config:'.length)}`)
        return { code: 1 }
      }
      if (e.code?.startsWith('nested-tech:')) {
        const [outer, inner] = e.code.slice('nested-tech:'.length).split('::')
        deps.err(`error: ${e.message}`)
        deps.err(`  outer: ${outer}`)
        deps.err(`  inner: ${inner}`)
        return { code: 1 }
      }
      if (e.code?.startsWith('walk-access:')) {
        deps.err(`error: ${e.message}`)
        deps.err(`  path:  ${e.code.slice('walk-access:'.length)}`)
        return { code: 1 }
      }
      throw err
    }

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

    const created = result.records.filter((r) => r.outcome === 'created')
    const accepted = result.records.filter((r) => r.outcome === 'accepted')
    const skipped = result.records.filter((r) => r.outcome === 'skipped')
    const untouched = result.records.filter((r) => r.outcome === 'untouched')
    deps.out(
      `workflows: ${created.length} created, ${accepted.length} updated, ` +
        `${skipped.length} kept, ${untouched.length} unowned`,
    )
    return { code: 0 }
  },
}

export const lifecycleCommands: readonly Command[] = [
  show,
  makeSetPlan('functional'),
  makeSetPlan('technical'),
  makeContinueRestart('continue'),
  makeContinueRestart('restart'),
  purge,
  unblock,
  recover,
  sync,
  drop,
  block,
  list,
  update,
]
