/**
 * `task` command group: `task add`, `task show`, `task priority`, plus the
 * group-usage fallback ('task' with no/unknown subcommand).
 *
 * Daemon-routed mutations (`add`, `priority`) go through `deps.daemon`; reads
 * (`show`) go through `deps.store`. The shared `enqueueViaDaemon` helper backs
 * `task add`.
 */

import { resolveAuthor, formatAuthor, detectOriginSession, type Author } from '../../core/author'
import { detectNoCommitMarker } from '../../core/lib/no-commit-marker'
import { causeForSignature } from '../../core/lib/failure-signature'
import { getProposal } from '../../core/proposals'
import {
  parsePriority,
  parseTaskSpec,
  parseBlockedBy,
  parseTags,
  resolvePlanText,
  resolvePromptSource,
  type TaskSpec,
} from '../args'
import type { Command, CommandDeps, CommandResult } from '../command'
import { errorMessage, spawnNoticeOut } from './shared'

const TASK_ADD_USAGE =
  'usage: mars task add ("<prompt>" | @<file> | --prompt-file <path> | -) [--intent <text>] [--author kind:name] [--blocked-by <id> ...] [--priority 0..3] [--tag coder] [--files <path> ...] [--verify "<cmd>"] [--preview "<cmd>"] [--done "<criterion>" ...] [--type auto|checkpoint] [plan flags]'

interface EnqueueParams {
  prompt: string
  skipTriage: boolean
  intent?: string
  blockerIds?: readonly string[]
  priority?: number
  tags?: string[]
  spec?: TaskSpec
}

/**
 * Shared enqueue path for `task add` (skipTriage=true) and the deprecated
 * `add` (skipTriage=false). Returns a CommandResult; prints via deps sinks.
 */
const enqueueViaDaemon = async (
  deps: CommandDeps,
  flags: Record<string, string>,
  params: EnqueueParams,
): Promise<CommandResult> => {
  const marker = detectNoCommitMarker(params.prompt)
  if (marker !== null) {
    deps.err(
      `[mars] refusing to enqueue: prompt declares it produces no commit (matched: ${marker.slice(0, 80)}).`,
    )
    deps.err(
      `[mars] the orchestrator's verify step requires at least one commit ahead of the integration branch;`,
    )
    deps.err(
      `[mars] running this through Mars would loop forever. Run the operation manually instead.`,
    )
    return { code: 1 }
  }
  const functional = resolvePlanText(
    flags,
    ['--functional', '--func'],
    '--functional-file',
  )
  const technical = resolvePlanText(
    flags,
    ['--technical', '--tech'],
    '--technical-file',
  )
  const plan =
    functional !== undefined || technical !== undefined
      ? { functional: functional ?? '', technical: technical ?? '' }
      : undefined
  const author: Author = resolveAuthor(flags['--author'])
  const originSessionId = detectOriginSession()
  const task = (await deps.daemon.sendRequest(
    {
      op: 'add',
      prompt: params.prompt,
      plan,
      skipTriage: params.skipTriage,
      author,
      ...(params.blockerIds && params.blockerIds.length > 0
        ? { blockerIds: params.blockerIds }
        : {}),
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.spec !== undefined ? { spec: params.spec } : {}),
      ...(params.intent !== undefined ? { intent: params.intent } : {}),
      ...(originSessionId !== null ? { originSessionId } : {}),
    },
    { onSpawnNotice: spawnNoticeOut(deps.out) },
  )) as { id: string; status: string }
  const verb = task.status
  const suffix =
    params.blockerIds && params.blockerIds.length > 0
      ? ` (blocked by: ${params.blockerIds.join(', ')}; author: ${formatAuthor(author)})`
      : ` (author: ${formatAuthor(author)})`
  deps.out(`${verb} ${task.id}${suffix}`)
  return { code: 0 }
}

export const taskAdd: Command = {
  path: 'task add',
  summary: 'enqueue a runnable task directly (skips triage)',
  usage: TASK_ADD_USAGE,
  run: async (args, deps) => {
    const promptResult = resolvePromptSource(args.positional, args.flags)
    if (!promptResult.ok) {
      deps.err(promptResult.message)
      return { code: 1 }
    }
    const prompt = promptResult.value
    if (!prompt) {
      deps.err(TASK_ADD_USAGE)
      return { code: 1 }
    }
    const priorityRaw = args.flags['--priority']
    let priority: number | undefined
    if (priorityRaw !== undefined) {
      const parsed = parsePriority(priorityRaw)
      if (!parsed.ok) {
        deps.err(parsed.message)
        return { code: 1 }
      }
      priority = parsed.value
    }
    const specResult = parseTaskSpec(args)
    if (!specResult.ok) {
      deps.err(specResult.message)
      return { code: 1 }
    }
    const intentFlag = args.flags['--intent']?.trim()
    const intent = intentFlag
      ? intentFlag.slice(0, 200)
      : (prompt.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? prompt).slice(0, 200)
    return enqueueViaDaemon(deps, args.flags, {
      prompt,
      skipTriage: true,
      intent,
      blockerIds: parseBlockedBy(args),
      priority,
      tags: parseTags(args),
      spec: specResult.value,
    })
  },
}

/** Render the full detail view for a task (shared by `task show` and `show`). */
export const renderTaskDetail = async (
  deps: CommandDeps,
  task: NonNullable<Awaited<ReturnType<CommandDeps['store']['getTask']>>>,
  kindLabel: string,
): Promise<void> => {
  deps.out(`kind:       ${kindLabel}`)
  deps.out(`id:         ${task.id}`)
  deps.out(`Status:     ${task.status}`)
  deps.out(`tags:       ${(task.tags ?? ['coder']).join(', ')}`)
  deps.out(`author:     ${formatAuthor(task.author)}`)
  deps.out(`branch:     ${task.branch ?? '-'}`)
  deps.out(`worktree:   ${task.worktreePath ?? '-'}`)
  if (task.devServerUrl) {
    deps.out(`preview:    ${task.devServerUrl} (validate or reject in the action queue)`)
  }
  deps.out(`createdAt:  ${task.createdAt}`)
  deps.out(`updatedAt:  ${task.updatedAt}`)
  deps.out(`prompt:`)
  deps.out(task.prompt)
  deps.out(`functional:`)
  deps.out(task.plan?.functional ?? '(empty)')
  deps.out(`technical:`)
  deps.out(task.plan?.technical ?? '(empty)')
  if (task.spec) {
    if (task.spec.files.length > 0) {
      deps.out(`files:`)
      for (const f of task.spec.files) deps.out(`  - ${f}`)
    }
    const readFirst = task.spec.readFirst ?? []
    if (readFirst.length > 0) {
      deps.out(`readFirst:`)
      readFirst.forEach((f, i) => deps.out(`  ${i + 1}. ${f}`))
    }
    const prescriptiveAction = task.spec.prescriptiveAction ?? null
    if (prescriptiveAction) {
      deps.out(`prescriptiveAction:`)
      deps.out(prescriptiveAction)
    }
    if (task.spec.verifyCmd) {
      deps.out(`verifyCmd: ${task.spec.verifyCmd}`)
    }
    if (task.spec.previewCmd) {
      deps.out(`previewCmd: ${task.spec.previewCmd}`)
    }
    if (task.spec.doneCriteria.length > 0) {
      deps.out(`doneCriteria:`)
      for (const c of task.spec.doneCriteria) deps.out(`  - [ ] ${c}`)
    }
  }
  if (task.error) {
    deps.out(`error:`)
    deps.out(task.error)
  }
  if (task.dropReason) {
    deps.out(`dropReason: ${task.dropReason}`)
  }
  if (task.failureReason) {
    deps.out(`failureReason: ${task.failureReason}`)
  }
  if (task.retryCount > 0) {
    deps.out(`retryCount: ${task.retryCount}`)
  }
  if (task.fixForTaskId) {
    deps.out(`fixForTask: ${task.fixForTaskId}`)
  }
  if (task.failureSignature) {
    deps.out(`failureSig: ${task.failureSignature}`)
    const cause = causeForSignature(task.failureSignature, task.id)
    if (cause) {
      deps.out(`cause:      ${cause}`)
    }
  }
  const blockerTaskIds = await deps.store.listBlockers(task.id)
  if (blockerTaskIds.length > 0) {
    deps.out(`blockedBy:  ${blockerTaskIds.join(', ')}`)
  }
  if (task.originSessionId) {
    deps.out(`origin session: ${task.originSessionId}`)
  }
  if (task.originId && task.originId !== task.id) {
    const originIdea = await getProposal(task.originId).catch(() => null)
    if (originIdea) {
      const firstLine = originIdea.title.split('\n')[0]?.trim() ?? ''
      const titleSuffix = firstLine.length > 0 ? ` ${firstLine}` : ''
      deps.out(`origin:     proposal ${originIdea.id}${titleSuffix}`)
    } else {
      deps.out(`origin:     task ${task.originId}`)
    }
    const siblings = await deps.store.listSiblings(task.originId, task.id)
    if (siblings.length > 0) {
      deps.out(`siblings:   ${siblings.join(', ')}`)
    }
  }
}

export const taskShow: Command = {
  path: 'task show',
  summary: 'show a single task',
  usage: 'usage: mars task show <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars task show <id>')
      return { code: 1 }
    }
    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`no task matching ${id}`)
      return { code: 1 }
    }
    await renderTaskDetail(deps, task, 'task')
    return { code: 0 }
  },
}

export const taskPriority: Command = {
  path: 'task priority',
  summary: 'set a task priority (0..3)',
  usage: 'usage: mars task priority <id> <0..3>',
  run: async (args, deps) => {
    const id = args.positional[0]
    const valueRaw = args.positional[1]
    if (!id || valueRaw === undefined) {
      deps.err('usage: mars task priority <id> <0..3>')
      return { code: 1 }
    }
    const parsed = parsePriority(valueRaw)
    if (!parsed.ok) {
      deps.err(parsed.message)
      return { code: 1 }
    }
    try {
      const task = (await deps.daemon.sendRequest({
        op: 'task.priority',
        id,
        priority: parsed.value,
      })) as { id: string; priority: number }
      deps.out(`set priority of ${task.id} to ${task.priority}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

/** `task` with no/unknown subcommand. */
export const taskGroup: Command = {
  path: 'task',
  summary: 'task subcommands',
  usage: 'usage: mars task <add|show|priority> ...',
  run: (_args, deps) => {
    deps.err('usage: mars task <add|show|priority> ...')
    return { code: 1 }
  },
}

export const taskCommands: readonly Command[] = [
  taskAdd,
  taskShow,
  taskPriority,
  taskGroup,
]
