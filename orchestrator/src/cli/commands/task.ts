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
  hasFlag,
  resolvePlanText,
  resolvePromptSource,
  type TaskSpec,
} from '../args'
import type { Command, CommandDeps, CommandResult } from '../command'
import { errorMessage, spawnNoticeErr } from './shared'

const TASK_ADD_USAGE =
  'usage: mars task add ("<prompt>" | @<file> | --prompt-file <path> | -) [--intent <text>] [--author kind:name] [--blocked-by <id> ...] [--priority 0..3] [--tag coder] [--files <path> ...] [--verify "<cmd>"] [--done "<criterion>" ...] [--merge auto|gated] [--workflow <name>] [--live (disabled)] [--supersede <task-id>] [--qa auto|manual] [plan flags]'

interface EnqueueParams {
  prompt: string
  skipTriage: boolean
  intent?: string
  blockerIds?: readonly string[]
  priority?: number
  tags?: string[]
  spec?: TaskSpec
  /** Pipeline selection: `.mars/workflows/<workflow>-workflow.js`. */
  workflow?: string
  /**
   * Task id this new task supersedes. Only set after CLI validation confirms
   * the referenced task exists and is in status 'failed'.
   * TODO(supersede-execution): consumed by slice N of PRD 94e2a82a.
   */
  supersedes?: string
  /** QA mode for the review step: 'auto' (default) or 'manual'. */
  qa?: 'auto' | 'manual'
  /** When true, the usage-aware scheduler may defer this task. */
  deferrable?: boolean
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
      `[mars] refusing to enqueue: prompt declares it produces no source-code change (matched: ${marker.slice(0, 80)}).`,
    )
    deps.err(
      `[mars] such tasks are typically read-only queries or scripts — run them manually rather than routing through Mars.`,
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
      ...(params.workflow !== undefined ? { workflow: params.workflow } : {}),
      ...(params.supersedes !== undefined ? { supersedes: params.supersedes } : {}),
      ...(params.qa !== undefined ? { qa: params.qa } : {}),
      ...(params.deferrable === true ? { deferrable: true } : {}),
    },
    { onSpawnNotice: spawnNoticeErr(deps.err) },
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
  flags: [
    { syntax: '--intent <text>', description: 'one-line task summary; derived from the prompt when omitted' },
    { syntax: '--files <path>', description: 'focus files for the worker (repeatable)' },
    { syntax: '--verify <cmd>', description: 'verification command run by the orchestrator' },
    { syntax: '--done <criterion>', description: 'acceptance criterion (repeatable)' },
    { syntax: '--merge auto|gated', description: 'merge automatically or pause for review' },
    { syntax: '--blocked-by <id>', description: 'wait for a task to finish (repeatable)' },
    { syntax: '--workflow <name>', description: 'select the dispatch pipeline' },
  ],
  run: async (args, deps) => {
    const live = hasFlag(args, '--live')
    const deferrableFlag = hasFlag(args, '--deferrable')
    const positional = args.positional
    const unknownFlag = positional.find((arg) => arg.startsWith('--'))
    if (unknownFlag !== undefined) {
      deps.err(`[mars] error: unknown flag ${unknownFlag}; use --merge auto|gated`)
      return { code: 2 }
    }
    const workflowFlag = args.flags['--workflow']?.trim()
    if (live && workflowFlag !== undefined && workflowFlag !== 'live') {
      deps.err(
        `--live is sugar for --workflow live; it conflicts with --workflow ${workflowFlag}`,
      )
      return { code: 1 }
    }
    const workflow = workflowFlag ?? (live ? 'live' : undefined)
    if (workflow === 'live') {
      deps.err(
        'the live pipeline is disabled while HITL is being refined; enqueue without --live/--workflow live',
      )
      return { code: 2 }
    }
    const promptResult = resolvePromptSource(positional, args.flags)
    if (!promptResult.ok) {
      deps.err(promptResult.message)
      return { code: 2 }
    }
    const prompt = promptResult.value
    if (!prompt) {
      deps.err(TASK_ADD_USAGE)
      return { code: 2 }
    }
    const priorityRaw = args.flags['--priority']
    let priority: number | undefined
    if (priorityRaw !== undefined) {
      const parsed = parsePriority(priorityRaw)
      if (!parsed.ok) {
        deps.err(parsed.message)
        return { code: 2 }
      }
      priority = parsed.value
    }
    const specResult = parseTaskSpec(args)
    if (!specResult.ok) {
      deps.err(specResult.message)
      return { code: 2 }
    }
    const intentFlag = args.flags['--intent']?.trim()
    const intent = intentFlag
      ? intentFlag.slice(0, 200)
      : (prompt.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? prompt).slice(0, 200)

    // --supersede <task-id>: validate the referenced task exists and is failed.
    const supersedesRaw = args.flags['--supersede']?.trim()
    let supersedes: string | undefined
    if (supersedesRaw !== undefined) {
      const supersedesTask = await deps.store.getTask(supersedesRaw)
      if (supersedesTask === null) {
        deps.err(`error: --supersede ${supersedesRaw}: task not found`)
        return { code: 1 }
      }
      if (supersedesTask.status !== 'failed') {
        deps.err(
          `error: --supersede ${supersedesRaw}: task must be in status 'failed' (was '${supersedesTask.status}')`,
        )
        return { code: 1 }
      }
      supersedes = supersedesRaw
    }

    // --qa <auto|manual>: validate and default to 'auto'.
    const qaRaw = args.flags['--qa']?.trim()
    let qa: 'auto' | 'manual' | undefined
    if (qaRaw !== undefined) {
      if (qaRaw !== 'auto' && qaRaw !== 'manual') {
        deps.err(
          `error: --qa must be 'auto' or 'manual'; got '${qaRaw}'`,
        )
        return { code: 2 }
      }
      qa = qaRaw
    }

    const deferrable = hasFlag(args, '--deferrable') ? true : undefined

    return enqueueViaDaemon(deps, args.flags, {
      prompt,
      skipTriage: true,
      intent,
      blockerIds: parseBlockedBy(args),
      priority,
      tags: parseTags(args),
      spec: specResult.value,
      ...(workflow !== undefined ? { workflow } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(qa !== undefined ? { qa } : {}),
      ...(deferrable !== undefined ? { deferrable } : {}),
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
  if (task.workflow !== null) {
    deps.out(`workflow:   ${task.workflow}`)
  }
  if (task.currentStepName !== null) {
    deps.out(`step:`)
    deps.out(`  name:  ${task.currentStepName}`)
    deps.out(`  mode:  manual`)
    if (task.currentStepGuide !== null) {
      deps.out(`  guide: ${task.currentStepGuide}`)
    }
  }
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
    if (task.spec.doneCriteria.length > 0) {
      const { Arc } = await import('../../core/arc')
      const journalEntries = await Arc.listProgress(task.id, undefined, deps.store)
      const checklist = Arc.deriveChecklist(journalEntries, task.spec.doneCriteria)
      deps.out(`doneCriteria:`)
      for (const { criterion, checked } of checklist) {
        deps.out(`  - [${checked ? 'x' : ' '}] ${criterion}`)
      }
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
  usage: 'usage: mars task show <id> [--json]',
  run: async (args, deps) => {
    const emitJson = hasFlag(args, '--json')
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars task show <id> [--json]')
      return { code: 2 }
    }
    const task = await deps.store.getTask(id)
    if (!task) {
      deps.err(`no task matching ${id}`)
      return { code: 1 }
    }
    if (emitJson) {
      deps.out(
        JSON.stringify(
          {
            ...task,
            current_step_name: task.currentStepName,
            current_step_mode: task.currentStepName !== null ? 'manual' : null,
            current_step_guide: task.currentStepGuide,
          },
          null,
          2,
        ),
      )
      return { code: 0 }
    }
    await renderTaskDetail(deps, task, 'task')
    const { Arc } = await import('../../core/arc')
    const journal = await Arc.listProgress(id, undefined, deps.store)
    if (journal.length > 0) {
      const tail = journal.slice(-10)
      deps.out(`--- journal (last ${tail.length}) ---`)
      for (const entry of tail) {
        const ts = entry.createdAt
        const kindLabel = entry.kind === 'note'
          ? 'note'
          : entry.kind === 'check'
          ? `check #${entry.criterionIndex}`
          : `uncheck #${entry.criterionIndex}`
        const bodyPart = entry.body.length > 0 ? `: ${entry.body}` : ''
        deps.out(`${ts} [${kindLabel}] ${entry.author}${bodyPart}`)
      }
    }
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
      return { code: 2 }
    }
    const parsed = parsePriority(valueRaw)
    if (!parsed.ok) {
      deps.err(parsed.message)
      return { code: 2 }
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

export const taskNote: Command = {
  path: 'task note',
  summary: 'append a progress note to a task',
  usage: 'usage: mars task note <id> "<text>"',
  run: async (args, deps) => {
    const id = args.positional[0]
    const body = args.positional[1]
    if (!id || !body) {
      deps.err('usage: mars task note <id> "<text>"')
      return { code: 1 }
    }
    const author = detectOriginSession() ?? 'cli'
    try {
      const entry = (await deps.daemon.sendRequest({
        op: 'task.note',
        id,
        body,
        author,
      })) as { id: string }
      deps.out(`noted ${entry.id}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

export const taskCheck: Command = {
  path: 'task check',
  summary: 'toggle a done-criterion check state (1-based index)',
  usage: 'usage: mars task check <id> <n> [--uncheck]',
  run: async (args, deps) => {
    const flagSet = new Set(args.positional.filter((a) => a.startsWith('--')))
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    const id = positionals[0]
    const indexRaw = positionals[1]
    if (!id || indexRaw === undefined) {
      deps.err('usage: mars task check <id> <n> [--uncheck]')
      return { code: 1 }
    }
    const criterionIndex = parseInt(indexRaw, 10)
    if (!Number.isInteger(criterionIndex) || criterionIndex < 1) {
      deps.err(`criterion index must be a positive integer; got ${indexRaw}`)
      return { code: 1 }
    }
    const uncheck = flagSet.has('--uncheck')
    const author = detectOriginSession() ?? 'cli'
    try {
      await deps.daemon.sendRequest({
        op: 'task.check',
        id,
        criterionIndex,
        uncheck,
        author,
      })
      deps.out(`${uncheck ? 'unchecked' : 'checked'} criterion ${criterionIndex} on ${id}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

/**
 * `task ask` — raise a question to the operator from within a worker task run.
 *
 * Workers (Coder/Fixer) call this via `Bash(mars task ask <taskId> "<question>")`.
 * The command emits a `task.question` event to the outbox; the question-raise
 * subscriber converts it to a `coder-question` action-queue item the operator
 * resolves. Read-only workers (Planner, Slicer, Triager, BehaviourVerifier,
 * Scorer) have this Bash pattern in their disallowedTools and cannot use it.
 */
export const taskAsk: Command = {
  path: 'task ask',
  summary: 'raise a question to the operator from within a task run',
  usage: 'usage: mars task ask <task-id> "<question>"',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    const question = args.positional[1]
    if (!taskId || !question) {
      deps.err('usage: mars task ask <task-id> "<question>"')
      return { code: 1 }
    }
    try {
      const { resolveStateClient } = await import('../../core/store/state-client')
      const { buildEventInsert, withWriteTx } = await import('../../core/lib/outbox')
      const client = resolveStateClient()
      await withWriteTx(client, async (tx) => {
        await tx.execute(buildEventInsert('task.question', { taskId, question }))
      })
      deps.out(`[mars] question raised for task ${taskId} — visible in action queue`)
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
  usage: 'usage: mars task <add|ask|show|priority|note|check> ...',
  run: (_args, deps) => {
    deps.err('usage: mars task <add|ask|show|priority|note|check> ...')
    return { code: 2 }
  },
}

export const taskCommands: readonly Command[] = [
  taskAdd,
  taskAsk,
  taskShow,
  taskPriority,
  taskNote,
  taskCheck,
  taskGroup,
]
