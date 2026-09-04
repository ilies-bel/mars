/**
 * `task` command group: `task add`, `task show`, `task priority`, plus the
 * group-usage fallback ('task' with no/unknown subcommand).
 *
 * Daemon-routed mutations (`add`, `priority`) go through `deps.daemon`; reads
 * (`show`) go through `deps.store`. The shared `enqueueViaDaemon` helper backs
 * `task add`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { resolveAuthor, formatAuthor, detectOriginSession, type Author } from '../../core/author'
import { detectNoCommitMarker } from '../../core/lib/no-commit-marker'
import { causeForSignature } from '../../core/lib/failure-signature'
import { taskDisplayTitle } from '../../core/lib/task-display-title'
import { parseVerifyOutput, verifyFailureLine } from '../../core/lib/parse-verify-output'
import { getProposal } from '../../core/proposals'
import { planWorkflowCopies } from '../../init/scaffold-workflows'
import { readWorkflowProvenance } from '../../workflows/agent-draft'
import {
  parsePriority,
  parseTaskSpec,
  containsAbsoluteRepoPath,
  isFullSuiteVerifyCmd,
  isNoOpVerifyCmd,
  detectNonexistentNpmScript,
  detectNonexistentVitestPath,
  findAtPathToken,
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
  'usage: mars task add ("<prompt>" | @<file> | --prompt-file <path> | -) [--intent <text>] [--author kind:name] [--blocked-by <id> ...] [--priority 0..3] [--tag <label>] [--files <path> ...] [--verify "<cmd>"] [--done "<criterion>" ...] [--merge auto|gated] [--workflow <name>] [--live] [--supersede <task-id>] [--qa auto|manual] [--implement] [plan flags]'

/**
 * Regex that matches research/investigation-shaped prompt language.
 * When the default implement pipeline is selected and none of --verify/--done
 * prove a concrete deliverable, a prompt matching this is refused with a
 * pointer to --workflow report.  --implement overrides the guard.
 */
const RESEARCH_MARKERS =
  /\b(?:investigate|root[\s-]cause|diagnose|identify\s+the\s+cause|research|audit|report\s+on|find\s+out\s+why|reproduce\s+and\s+identify)\b/i

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
   * the referenced task exists and is in status 'failed'. Forwarded to the
   * daemon's `add` RPC, which executes the supersede sequence in
   * `Arc.createOrigin` (drops the superseded task, inherits its branch).
   */
  supersedes?: string
  /** QA mode for the review step: 'auto' (default) or 'manual'. */
  qa?: 'auto' | 'manual'
  /** When true, the usage-aware scheduler may defer this task. */
  deferrable?: boolean
}

/**
 * Returns true when `cmd` looks like a build / typecheck / test command.
 * Used to decide whether `--verify` constitutes structural evidence of a
 * source-code change, which overrides the no-commit text heuristic.
 */
const isBuildLikeVerifyCmd = (cmd: string): boolean =>
  /\b(?:tsc|vitest|jest|mocha|ava|tap|jasmine|karma|cypress|playwright|puppeteer|npm\s+(?:test|run)|yarn\s+(?:test|run)|pnpm\s+(?:test|run)|npx|bunx|bun\s+test|cargo\s+(?:test|build|check)|go\s+(?:test|build)|make|gradle|mvn)\b/i.test(
    cmd,
  )

/**
 * Shared enqueue path for `task add` (skipTriage=true) and the deprecated
 * `add` (skipTriage=false). Returns a CommandResult; prints via deps sinks.
 */
const enqueueViaDaemon = async (
  deps: CommandDeps,
  flags: Record<string, string>,
  params: EnqueueParams,
): Promise<CommandResult> => {
  // Structural evidence of a code change bypasses the no-commit text heuristic:
  //   --files    → the caller is explicitly declaring target source files.
  //   --verify   → a build/typecheck/test command implies a source change exists.
  // Without this bypass, quoting git output ("nothing to commit") in a bug
  // title or fenced block falsely triggers the guard even on well-formed tasks.
  const hasStructuralEvidence =
    (params.spec?.files?.length ?? 0) > 0 ||
    (params.spec?.verifyCmd != null && isBuildLikeVerifyCmd(params.spec.verifyCmd))

  if (!hasStructuralEvidence) {
    const marker = detectNoCommitMarker(params.prompt)
    if (marker !== null) {
      deps.err(
        `[mars] refusing to enqueue: prompt declares it produces no source-code change (matched: ${marker.slice(0, 80)}).`,
      )
      deps.err(
        `[mars] such tasks are typically read-only queries or scripts — run them manually rather than routing through Mars.`,
      )
      deps.err(
        `[mars] to override: pass --files <path> to declare a source change, or add a --verify build/test command.`,
      )
      return { code: 1 }
    }
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
  const authorExplicit = flags['--author'] !== undefined
  const hasBlockers = params.blockerIds && params.blockerIds.length > 0
  const parts = [
    hasBlockers ? `blocked by: ${params.blockerIds!.join(', ')}` : '',
    authorExplicit ? `author: ${formatAuthor(author)}` : '',
  ].filter(Boolean)
  const suffix = parts.length > 0 ? ` (${parts.join('; ')})` : ''
  deps.out(`${verb} ${task.id}${suffix}`)
  return { code: 0 }
}

const taskAdd: Command = {
  path: 'task add',
  summary: 'enqueue a runnable task directly (skips triage)',
  usage: TASK_ADD_USAGE,
  flags: [
    { syntax: '--intent <text>', description: 'one-line task summary; derived from the prompt when omitted' },
    { syntax: '--author <kind:name>', description: 'task author; defaults to the detected session identity' },
    { syntax: '--priority 0..3', description: 'task priority; 0 = lowest, 3 = highest (default 1)' },
    { syntax: '--tag <label>', description: 'tag label attached to the task (repeatable)' },
    { syntax: '--files <path>', description: 'focus files for the worker (repeatable)' },
    { syntax: '--verify <cmd>', description: 'verification command run by the orchestrator' },
    { syntax: '--done <criterion>', description: 'acceptance criterion (repeatable)' },
    { syntax: '--merge auto|gated', description: 'merge automatically or pause for review' },
    { syntax: '--blocked-by <id>', description: 'wait for a task to finish (repeatable)' },
    { syntax: '--workflow <name>', description: 'select the dispatch pipeline' },
    { syntax: '--supersede <task-id>', description: 'replace a task that must already be in status \'failed\'' },
    { syntax: '--qa auto|manual', description: 'QA mode for the review step; auto (default) or manual' },
    { syntax: '--implement', description: 'override the research-prompt guard; forces the implement pipeline even for investigation-shaped prompts' },
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
    // Validate --workflow against the registry — same source as `mars workflow list`.
    // Bundled template names are always valid; user-defined custom workflows in
    // .mars/workflows/ are valid when not pending operator approval (agent-draft).
    // Rejecting here keeps bogus values out of the tasks.workflow column entirely;
    // without this guard the task is queued, dispatched, then hard-failed at
    // dispatch:workflow-load — minutes later, with no link back to the typo.
    if (workflow !== undefined) {
      const validKinds = new Set<string>()
      for (const copy of planWorkflowCopies(deps.ctx.repoRoot)) {
        validKinds.add(basename(copy.src).replace(/-workflow\.js$/, ''))
      }
      const wfDir = resolve(deps.ctx.stateDir, 'workflows')
      if (existsSync(wfDir)) {
        for (const filename of readdirSync(wfDir).filter((n) => n.endsWith('.js'))) {
          const content = readFileSync(resolve(wfDir, filename), 'utf8')
          if (!readWorkflowProvenance(content).pendingApproval) {
            validKinds.add(filename.replace(/-workflow\.js$/, ''))
          }
        }
      }
      if (!validKinds.has(workflow)) {
        const sorted = [...validKinds].sort().join(', ')
        deps.err(`workflow must be one of ${sorted}; got '${workflow}'`)
        return { code: 2 }
      }
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
    // Reject --verify values that embed absolute repo-root paths. Such commands
    // bypass worktree isolation: when the orchestrator's verify step runs them,
    // they operate on the integration branch (main's tree), not on the task
    // branch — producing false-green verifies or verifies that can never pass.
    if (specResult.value?.verifyCmd) {
      if (containsAbsoluteRepoPath(specResult.value.verifyCmd, deps.ctx.repoRoot)) {
        deps.err(
          `[mars] --verify contains an absolute path under the repo root (${deps.ctx.repoRoot}).`,
        )
        deps.err(
          `[mars] absolute paths in --verify run against the integration branch, not the task worktree — use relative paths instead.`,
        )
        deps.err(
          `[mars] example: --verify 'cd orchestrator && npx vitest run src/path/to/your.test.ts'  (not --verify 'cd ${deps.ctx.repoRoot}/orchestrator && npm test')`,
        )
        return { code: 2 }
      }
      // Reject --verify values that run the whole test suite. The full suite
      // is known-red and reliably exceeds the verify step's wall-clock
      // budget, so a full-suite spec times out rather than passing or
      // failing on the task's own changes — see CLAUDE.md for the incident
      // (two arcs each burned 900s and their sole recovery attempt on this).
      if (isFullSuiteVerifyCmd(specResult.value.verifyCmd)) {
        deps.err(
          `[mars] --verify runs the whole test suite, which is known-red here and exceeds the verify timeout.`,
        )
        deps.err(
          `[mars] scope it to the files you touch, e.g.: --verify 'cd orchestrator && npx vitest run src/path/to/your.test.ts'`,
        )
        return { code: 2 }
      }
      // Reject --verify values that name an npm script absent from the resolved
      // package.json, or whose body unconditionally passes. A missing script
      // (e.g. `cd orchestrator && npm run arch` when `arch` only exists in the
      // root package.json) fails immediately with "Missing script: arch", burning
      // a coder run and its sole recovery attempt without ever checking anything.
      const scriptErr = detectNonexistentNpmScript(
        specResult.value.verifyCmd,
        deps.ctx.repoRoot,
      )
      if (scriptErr !== null) {
        deps.err(scriptErr)
        return { code: 2 }
      }
      // Reject --verify commands that are structurally no-op: they can never
      // report a failure regardless of what the underlying tool finds.
      const noOpErr = isNoOpVerifyCmd(specResult.value.verifyCmd)
      if (noOpErr !== null) {
        deps.err(noOpErr)
        return { code: 2 }
      }
      // Hard-error when --verify names a literal vitest test file that does
      // not exist AND is not declared in --files (meaning the task will not
      // create it). A missing file not in --files can never pass at verify
      // time — reject early so no coder run is wasted on a structurally
      // doomed spec.
      //
      // When the path IS in --files, the task is about to create it; emit a
      // warning and proceed so the coder can write the file first.
      if (deps.ctx.repoRoot) {
        const filesAbsSet = new Set(
          (specResult.value.files ?? []).map((f) => join(deps.ctx.repoRoot, f)),
        )
        let verCwd = '.'
        outer: for (const raw of specResult.value.verifyCmd.split(/&&|\|\||;/)) {
          const tokens = raw.trim().split(/\s+/).filter(Boolean)
          if (tokens.length === 0) continue
          if (tokens[0] === 'cd' && tokens[1]) {
            verCwd = tokens[1]
            continue
          }
          const vitestIdx = tokens.indexOf('vitest')
          if (vitestIdx === -1 || tokens[vitestIdx + 1] !== 'run') continue
          for (const p of tokens.slice(vitestIdx + 2).filter((t) => !t.startsWith('-'))) {
            if (p.includes('*') || p.includes('?') || p.includes('{')) continue
            const resolvedDir =
              verCwd === '.' ? deps.ctx.repoRoot : join(deps.ctx.repoRoot, verCwd)
            const absPath = join(resolvedDir, p)
            if (!existsSync(absPath)) {
              const cwdDesc = verCwd === '.' ? 'the repo root' : `${verCwd}/`
              if (filesAbsSet.has(absPath)) {
                deps.err(
                  `[mars] --verify names test file '${p}' in ${cwdDesc} which does not exist yet. ` +
                    `It is listed in --files so the task will create it — proceeding.`,
                )
              } else {
                deps.err(
                  `[mars] --verify names test file '${p}' in ${cwdDesc} which does not exist. ` +
                    `Add it to --files if this task will create it, or correct the path.`,
                )
                return { code: 2 }
              }
              break outer
            }
          }
        }
      }
    }
    const intentFlag = args.flags['--intent']?.trim()
    // Reject @<path> tokens in --intent — it is a short label, not a body field.
    if (intentFlag !== undefined) {
      const atToken = findAtPathToken(intentFlag)
      if (atToken !== null) {
        deps.err(
          `mars task add: --intent contains '${atToken}', which looks like a body-file reference.\n` +
            `Pass the body as the prompt argument instead:\n` +
            `  mars task add ${atToken} --intent "<short summary>"`,
        )
        return { code: 2 }
      }
    }
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

    // Research-prompt guard: when the default implement pipeline is selected
    // (no --workflow / --live) and the prompt matches investigation/research
    // language without a concrete deliverable (--verify or --done), refuse with
    // a pointer to the report pipeline.  --implement overrides the guard.
    if (!hasFlag(args, '--implement') && workflow === undefined) {
      const hasConcreteDeliverable =
        specResult.value?.verifyCmd != null ||
        (specResult.value?.doneCriteria.length ?? 0) > 0
      if (
        !hasConcreteDeliverable &&
        (RESEARCH_MARKERS.test(prompt) ||
          (intentFlag != null && RESEARCH_MARKERS.test(intentFlag)))
      ) {
        deps.err(
          `[mars] refusing to enqueue: prompt looks like investigation/research work.`,
        )
        deps.err(
          `[mars] research and root-cause tasks belong on the report pipeline, which runs read-only and persists a transcript.`,
        )
        deps.err(`[mars] re-run with: --workflow report`)
        deps.err(
          `[mars] to override and land on the implement pipeline: add --implement.`,
        )
        deps.err(
          `[mars] to prove a concrete deliverable: add --verify <cmd> or --done <criterion>.`,
        )
        return { code: 1 }
      }
    }

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
  deps.out(`title:      ${taskDisplayTitle(task)}`)
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
      deps.out(`doneCriteria:`)
      // Use task_acceptance (4-state: met ✓, not-met ✗, cannot-verify ?, pending  )
      // when rows exist (new tasks seeded at creation). Fall back to legacy task_progress
      // fold ([x]/[ ]) for pre-existing tasks that have no task_acceptance rows.
      const acceptances = await Arc.listAcceptance(task.id, deps.store)
      if (acceptances.length > 0) {
        const acceptanceByPosition = new Map(acceptances.map((a) => [a.position, a]))
        for (let i = 0; i < task.spec.doneCriteria.length; i++) {
          const criterion = task.spec.doneCriteria[i]
          const acc = acceptanceByPosition.get(i)
          const status = acc?.status ?? 'pending'
          const symbol =
            status === 'met' ? '✓'
            : status === 'not-met' ? '✗'
            : status === 'cannot-verify' ? '?'
            : ' '
          deps.out(`  - [${symbol}] ${criterion}`)
        }
      } else {
        // Legacy path: fold task_progress check/uncheck journal
        const journalEntries = await Arc.listProgress(task.id, undefined, deps.store)
        const checklist = Arc.deriveChecklist(journalEntries, task.spec.doneCriteria)
        for (const { criterion, checked } of checklist) {
          deps.out(`  - [${checked ? 'x' : ' '}] ${criterion}`)
        }
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
  if (task.recoverySpawnedCount > 0) {
    // Show whether the one-shot recovery slot was consumed and by which fix task.
    // Query self_heal_attempts (append-only; survives fix-task purge) to find the
    // fix task id — task.recoverySpawnedCount alone can't tell us which task.
    const healRow = await deps.store.query({
      sql: `SELECT fix_task_id FROM self_heal_attempts
             WHERE parent_task_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
      args: [task.id],
    })
    const fixTaskId = (healRow.rows[0] as Record<string, unknown> | undefined)?.fix_task_id
    if (fixTaskId) {
      deps.out(`recoverySlot: spent (fix: ${fixTaskId})`)
    } else {
      deps.out(`recoverySlot: spent (fix task not found in ledger)`)
    }
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
      // Proposal titles are single-line by construction: createProposal splits
      // incoming prose into title + body, and migration 0037 backfilled the
      // legacy blob rows. No first-line extraction needed.
      const title = originIdea.title.trim()
      const titleSuffix = title.length > 0 ? ` ${title}` : ''
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

const taskShow: Command = {
  path: 'task show',
  summary: 'show a single task',
  usage: 'usage: mars task show <id> [--json] [--verify-output]',
  flags: [
    { syntax: '--json', description: 'emit the raw task row as JSON' },
    {
      syntax: '--verify-output',
      description: 'print the full raw verify commandOutput for a failed verify task',
    },
  ],
  run: async (args, deps) => {
    const emitJson = hasFlag(args, '--json')
    const showVerifyOutput = hasFlag(args, '--verify-output')
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars task show <id> [--json] [--verify-output]')
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

    // -- Fetch verify commandOutput for failed verify-phase tasks -----------
    // Query the last step_ended trace event that recorded commandOutput for
    // the verify phase. This is best-effort: if the daemon is down or the
    // row is missing we continue without it.
    let verifyCommandOutput: string | undefined
    if (task.status === 'failed' && (task as { failedPhase?: string | null }).failedPhase === 'verify') {
      try {
        const { openTraceEventStore } = await import('../../core/lib/trace-events-store')
        const { resolveDbTarget } = await import('../../core/context')
        const traceStore = await openTraceEventStore(resolveDbTarget())
        const events = await traceStore.query({
          taskId: task.id,
          phase: ['verify'],
          kind: ['step_ended'],
          limit: 1,
        })
        const raw = events[0]?.payload?.commandOutput
        if (typeof raw === 'string' && raw.length > 0) {
          verifyCommandOutput = raw
        }
      } catch {
        // Best-effort — daemon may be unreachable; continue without it.
      }
    }

    await renderTaskDetail(deps, task, 'task')

    // -- Render verify failure section (the "which gate failed?" answer) ---
    if (verifyCommandOutput !== undefined) {
      if (showVerifyOutput) {
        deps.out(`--- verify output (raw) ---`)
        deps.out(verifyCommandOutput)
      } else {
        const parsed = parseVerifyOutput(verifyCommandOutput)
        const failLine = verifyFailureLine(parsed)
        if (failLine !== null) {
          deps.out(`--- verify failure ---`)
          deps.out(`failing: ${failLine}`)
          // Show each failing gate's output excerpt (up to 2 000 chars per gate).
          for (const s of parsed.failingSections) {
            const excerpt =
              s.output.length > 2000 ? `${s.output.slice(0, 2000)}\n… (truncated)` : s.output
            deps.out(`\n[${s.name}]`)
            deps.out(excerpt)
          }
          deps.out(`\n(run \`mars task show ${task.id} --verify-output\` for the full raw output)`)
        }
      }
    }

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

const taskPriority: Command = {
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

const taskNote: Command = {
  path: 'task note',
  summary: 'append a progress note to a task',
  usage: 'usage: mars task note <id> ("<text>" | @<file> | -)',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars task note <id> ("<text>" | @<file> | -)')
      return { code: 1 }
    }
    const bodyResult = resolvePromptSource(args.positional.slice(1), args.flags)
    if (!bodyResult.ok) {
      deps.err(bodyResult.message)
      return { code: 2 }
    }
    const body = bodyResult.value
    if (!body) {
      deps.err('usage: mars task note <id> ("<text>" | @<file> | -)')
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

const taskCheck: Command = {
  path: 'task check',
  summary: 'toggle a done-criterion check state (1-based index)',
  usage: 'usage: mars task check <id> <n> [--uncheck]',
  run: async (args, deps) => {
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    const id = positionals[0]
    const indexRaw = positionals[1]
    if (!id || indexRaw === undefined) {
      deps.err('usage: mars task check <id> <n> [--uncheck]')
      return { code: 1 }
    }
    // On any invalid-index error (bad argument here, or out-of-range from the
    // daemon below), print the task's numbered done-criteria so the operator
    // doesn't have to make a second round-trip (`task show`) to find the
    // right index.
    const printCriteriaList = async () => {
      const task = await deps.store.getTask(id)
      const criteria = task?.spec?.doneCriteria ?? []
      if (criteria.length === 0) return
      deps.err('done criteria:')
      criteria.forEach((c, i) => deps.err(`  ${i + 1}. ${c}`))
    }
    const criterionIndex = parseInt(indexRaw, 10)
    if (!Number.isInteger(criterionIndex) || criterionIndex < 1) {
      deps.err(`criterion index must be a positive integer; got ${indexRaw}`)
      await printCriteriaList()
      return { code: 1 }
    }
    const uncheck = hasFlag(args, '--uncheck')
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
      const message = errorMessage(error)
      deps.err(message)
      if (/out of range/.test(message)) {
        await printCriteriaList()
      }
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const taskStop: Command = {
  path: 'task stop',
  summary: 'stop running tasks while preserving their worktrees',
  usage: 'usage: mars task stop <id> [<id> ...]',
  helpBody: `mars task stop <id> [<id> ...]

Stops each currently in-flight task, terminating its provider subprocess while
preserving its worktree, branch, and commits. Stopped tasks are marked failed
with a cancellation reason and can be resumed with \`mars continue <id>\`.
Stops at the first error.`,
  run: async (args, deps) => {
    const ids = args.positional.filter((arg) => !arg.startsWith('--'))
    if (ids.length === 0) {
      deps.err('usage: mars task stop <id> [<id> ...]')
      return { code: 2 }
    }
    for (const id of ids) {
      try {
        await deps.daemon.sendRequest({ op: 'stop-task', id })
      } catch (error: unknown) {
        deps.err(`${id}: ${errorMessage(error)}`)
        return { code: 1 }
      }
      deps.out(`stopped ${id}; worktree and branch preserved — run 'mars continue ${id}' to resume`)
    }
    return { code: 0 }
  },
}

/**
 * `task ask` — raise a question to the operator from within a worker task run.
 *
 * Workers (Coder/Fixer) call this via `Bash(mars task ask <taskId> "<question>")`.
 * The command calls the daemon's `POST /tasks/:id/question` HTTP route (via
 * `core/daemon/client`'s `raiseTaskQuestion`), which emits a `task.question`
 * event to the outbox server-side; the question-raise subscriber converts it
 * to a `coder-question` action-queue item the operator resolves. Read-only
 * workers (Planner, Slicer, Triager, BehaviourVerifier, Scorer) have this
 * Bash pattern in their disallowedTools and cannot use it.
 *
 * The CLI process never opens its own write transaction on the outbox — the
 * daemon is the single writer (modular-core: "move the CLI's outbox publish
 * behind a daemon API").
 */
const taskAsk: Command = {
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
      const { raiseTaskQuestion } = await import('../../core/daemon/client')
      await raiseTaskQuestion(taskId, question, { repo: deps.ctx.repoRoot })
      deps.out(`[mars] question raised for task ${taskId} — visible in action queue`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const taskSetVerify: Command = {
  path: 'task set-verify',
  summary: 'update the verify command for a task',
  usage: 'usage: mars task set-verify <id> "<cmd>"',
  helpBody: `mars task set-verify <id> "<cmd>"

Update the verify command stored for a task. Applies the same validation as
'mars task add --verify': absolute repo-root paths are rejected because they
bypass worktree isolation, and whole-suite commands ('npm test', bare
'vitest run') are rejected because the full suite is known-red here and
exceeds the verify timeout.

Allowed for non-done, non-dropped tasks (including failed tasks whose verify
spec needs repair before re-try). The change is journaled as a task note.

Use this to fix legacy specs that fail with "npm error Missing script" because
the command was authored without a 'cd <subdir> &&' prefix:

  mars task set-verify <id> 'cd orchestrator && npx vitest run src/path/to/your.test.ts'`,
  run: async (args, deps) => {
    const id = args.positional[0]
    const cmd = args.positional[1]
    if (!id || cmd === undefined) {
      deps.err('usage: mars task set-verify <id> "<cmd>"')
      return { code: 2 }
    }
    if (containsAbsoluteRepoPath(cmd, deps.ctx.repoRoot)) {
      deps.err(
        `[mars] --verify contains an absolute path under the repo root (${deps.ctx.repoRoot}).`,
      )
      deps.err(
        `[mars] absolute paths in --verify run against the integration branch, not the task worktree — use relative paths instead.`,
      )
      deps.err(
        `[mars] example: mars task set-verify ${id} 'cd orchestrator && npx vitest run src/path/to/your.test.ts'`,
      )
      return { code: 2 }
    }
    // Same full-suite rejection as `task add --verify` — a spec that runs the
    // whole suite is known-red here and reliably times out.
    if (isFullSuiteVerifyCmd(cmd)) {
      deps.err(
        `[mars] --verify runs the whole test suite, which is known-red here and exceeds the verify timeout.`,
      )
      deps.err(
        `[mars] scope it to the files you touch, e.g.: mars task set-verify ${id} 'cd orchestrator && npx vitest run src/path/to/your.test.ts'`,
      )
      return { code: 2 }
    }
    // Same nonexistent-script rejection as `task add --verify`.
    const scriptErrSetVerify = detectNonexistentNpmScript(cmd, deps.ctx.repoRoot)
    if (scriptErrSetVerify !== null) {
      deps.err(scriptErrSetVerify)
      return { code: 2 }
    }
    // Same no-op rejection as `task add --verify`.
    const noOpErrSetVerify = isNoOpVerifyCmd(cmd)
    if (noOpErrSetVerify !== null) {
      deps.err(noOpErrSetVerify)
      return { code: 2 }
    }
    // Same vitest-path warning as `task add --verify`.
    const vitestPathWarnSetVerify = detectNonexistentVitestPath(cmd, deps.ctx.repoRoot)
    if (vitestPathWarnSetVerify !== null) {
      deps.err(vitestPathWarnSetVerify)
    }
    try {
      const result = (await deps.daemon.sendRequest({
        op: 'task.set-verify',
        id,
        verifyCmd: cmd || null,
      })) as { id: string; verifyCmd: string | null }
      deps.out(
        `updated verify for ${result.id}: ${result.verifyCmd === null ? '(cleared)' : result.verifyCmd}`,
      )
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

/** `task` with no/unknown subcommand. */
const taskGroup: Command = {
  path: 'task',
  summary: 'task subcommands',
  usage: 'usage: mars task <add|ask|show|priority|note|check|set-verify|stop> ...',
  run: (_args, deps) => {
    deps.err('usage: mars task <add|ask|show|priority|note|check|set-verify|stop> ...')
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
  taskSetVerify,
  taskStop,
  taskGroup,
]
