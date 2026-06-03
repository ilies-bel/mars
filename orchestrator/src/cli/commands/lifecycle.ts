/**
 * Task-lifecycle and top-level query commands: `show`, `set-functional`,
 * `set-technical`, `retry`, `continue`, `restart`, `purge`, `unblock`,
 * `recover`, `sync`, `drop`, `block`, `list`, `watch`.
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

const show: Command = {
  path: 'show',
  summary: 'show a task or proposal by id',
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
    deps.err(`no task or proposal matching ${id}`)
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

const retry: Command = {
  path: 'retry',
  summary: '(removed) use continue/restart',
  usage: "use 'mars continue <id>' or 'mars restart <id>'",
  run: (_args, deps) => {
    deps.err(
      `unknown command: retry. Use 'mars continue <id> [<id> ...]' to resume on the existing worktree, or 'mars restart <id> [<id> ...]' to wipe and re-run.`,
    )
    return { code: 1 }
  },
}

const makeContinueRestart = (verb: 'continue' | 'restart'): Command => ({
  path: verb,
  summary:
    verb === 'continue'
      ? 'resume failed tasks on their existing worktree'
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
        { autoSpawn: false },
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
      fixForRefsCleared: string[]
      worktreeRemoved: boolean
      branchDeleted: boolean
    }
    const parts = [
      `dropped ${data.taskId} (was ${data.previousStatus})`,
      `worktree=${data.worktreeRemoved ? 'removed' : 'absent'}`,
      `branch=${data.branchDeleted ? 'deleted' : 'absent'}`,
      `edges=${data.edgesRemoved.incoming}in/${data.edgesRemoved.outgoing}out`,
    ]
    if (data.fixForRefsCleared.length > 0) {
      parts.push(`fixForRefs cleared on: ${data.fixForRefsCleared.join(', ')}`)
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

const watch: Command = {
  path: 'watch',
  summary: '(renamed) use mars daemon',
  usage: 'use `mars daemon --help`',
  run: (_args, deps) => {
    deps.err(
      'mars watch has been renamed to mars daemon — run `mars daemon --help` for usage.',
    )
    return { code: 2 }
  },
}

export const lifecycleCommands: readonly Command[] = [
  show,
  makeSetPlan('functional'),
  makeSetPlan('technical'),
  retry,
  makeContinueRestart('continue'),
  makeContinueRestart('restart'),
  purge,
  unblock,
  recover,
  sync,
  drop,
  block,
  list,
  watch,
]
