/**
 * `proposal` command group — 18 leaves over the Mars database (proposals)
 * plus the planning-graph and cross-graph blocker edges.
 *
 * Local reads/writes go through the `core/proposals` module and `deps.store`;
 * the two daemon-routed verbs (`promote`, `slice`) go through `deps.daemon`.
 */

import { resolveAuthor, formatAuthor, detectOriginSession } from '../../core/author'
import {
  createProposal,
  getProposal,
  resolveProposalId,
  setProposalField,
  addProposalUserStory,
  removeProposalUserStory,
  dismissProposal,
  deleteProposal,
  listProposals,
  addProposalDependencies,
  removeProposalDependency,
  listProposalDependencies,
  validateProposalShaped,
  setProposalCoordinated,
  VALID_SOURCES,
  isProposalSource,
  type ProposalSource,
} from '../../core/proposals'
import { isDaemonReachable } from '../../core/daemon/paths'
import { getDefaultTaskStore } from '../../core/store/task-store'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Command, CommandDeps } from '../command'
import { errorMessage, spawnNoticeErr } from './shared'
import { parsePriority } from '../args'

const execFileAsync = promisify(execFile)

/** Render a proposal detail body (shared by `proposal show` and `show`). */
export const renderProposalDetail = async (
  deps: CommandDeps,
  idea: NonNullable<Awaited<ReturnType<typeof getProposal>>>,
  withKind: boolean,
): Promise<void> => {
  if (withKind) deps.out(`kind:       proposal`)
  deps.out(`id:         ${idea.id}`)
  deps.out(`status:     ${idea.status}`)
  deps.out(`source:     ${idea.source}`)
  deps.out(`author:     ${formatAuthor(idea.author)}`)
  deps.out(`createdAt:  ${new Date(idea.createdAt).toISOString()}`)
  deps.out(`updatedAt:  ${new Date(idea.updatedAt).toISOString()}`)
  deps.out(`title:`)
  deps.out(idea.title)
  if (idea.problem.trim().length > 0) {
    deps.out(`problem:`)
    deps.out(idea.problem)
  }
  if (idea.solution.trim().length > 0) {
    deps.out(`solution:`)
    deps.out(idea.solution)
  }
  if (idea.userStories.length > 0) {
    deps.out(`user stories:`)
    idea.userStories.forEach((s, i) => deps.out(`  [${i}] ${s}`))
  }
  if (idea.outOfScope.trim().length > 0) {
    deps.out(`out of scope:`)
    deps.out(idea.outOfScope)
  }
  if (idea.notes.trim().length > 0) {
    deps.out(`notes:`)
    deps.out(idea.notes)
  }
  const proposalTasks = await deps.store.listTasksForProposal(idea.id)
  if (proposalTasks.length > 0) {
    deps.out(
      `tasks:      ${proposalTasks.map((t) => `${t.id} (${t.status})`).join(', ')}`,
    )
    // Show slice dependency edges with provenance so operators can see which
    // edges were forced by file overlap vs proposed by an LLM.
    try {
      const edgeResult = await deps.store.query({
        sql: `SELECT tb.task_id, tb.blocker_task_id, tb.provenance,
                     t1.slice_index AS depender_slice, t2.slice_index AS blocker_slice
              FROM task_blockers tb
              JOIN tasks t1 ON tb.task_id = t1.id
              JOIN tasks t2 ON tb.blocker_task_id = t2.id
              WHERE t1.parent_proposal_id = ?
                AND t2.parent_proposal_id = ?
                AND tb.provenance IN ('file-overlap', 'inferred')
              ORDER BY t2.slice_index, t1.slice_index`,
        args: [idea.id, idea.id],
      })
      if (edgeResult.rows.length > 0) {
        deps.out(`slice-deps:`)
        for (const row of edgeResult.rows) {
          const r = row as unknown as {
            blocker_task_id: string
            task_id: string
            provenance: string
            blocker_slice: number | null
            depender_slice: number | null
          }
          deps.out(
            `  ${r.blocker_task_id} (slice ${r.blocker_slice ?? '?'}) → ${r.task_id} (slice ${r.depender_slice ?? '?'}) [${r.provenance}]`,
          )
        }
      }
    } catch {
      // Best-effort: provenance query failures must not break proposal show.
    }
  }
}

const proposalAdd: Command = {
  path: 'proposal add',
  summary: 'create a proposal/plan (author detected from env/git)',
  usage: 'usage: mars proposal add "<goal>" [--author kind:name]',
  run: async (args, deps) => {
    const goal = args.positional.join(' ')
    if (!goal) {
      deps.err('usage: mars proposal add "<goal>" [--author kind:name]')
      return { code: 2 }
    }
    const author = resolveAuthor(args.flags['--author'])
    const originSessionId = detectOriginSession()
    try {
      const idea = await createProposal(goal, { author, originSessionId })
      deps.out(`${idea.id} (author: ${formatAuthor(author)})`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalShow: Command = {
  path: 'proposal show',
  summary: 'show a proposal',
  usage: 'usage: mars proposal show <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal show <id>')
      return { code: 2 }
    }
    const resolved = await resolveProposalId(id)
    if (resolved.kind === 'ambiguous') {
      deps.err(`ambiguous prefix '${id}' matches ${resolved.count} proposals`)
      return { code: 1 }
    }
    const idea = resolved.kind === 'unique' ? await getProposal(resolved.id) : null
    if (!idea) {
      deps.err(`proposal ${id} not found`)
      return { code: 1 }
    }
    await renderProposalDetail(deps, idea, false)
    return { code: 0 }
  },
}

const proposalSet: Command = {
  path: 'proposal set',
  summary: 'update a single field on a proposal',
  usage:
    'usage: mars proposal set <id> <title|problem|solution|out-of-scope|notes|status> "<text>"',
  run: async (args, deps) => {
    const id = args.positional[0]
    const field = args.positional[1]
    const value = args.positional.slice(2).join(' ')
    if (!id || !field || value.length === 0) {
      deps.err(
        'usage: mars proposal set <id> <title|problem|solution|out-of-scope|notes|status> "<text>"',
      )
      return { code: 2 }
    }
    if (
      field !== 'title' &&
      field !== 'problem' &&
      field !== 'solution' &&
      field !== 'out-of-scope' &&
      field !== 'notes' &&
      field !== 'status'
    ) {
      deps.err(
        `unknown field '${field}'; expected one of title|problem|solution|out-of-scope|notes|status`,
      )
      return { code: 2 }
    }
    try {
      await setProposalField(id, field, value)
      deps.out(`updated ${id}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalAddUserStory: Command = {
  path: 'proposal add-user-story',
  summary: 'append a user story to the proposal PRD',
  usage: 'usage: mars proposal add-user-story <id> "<text>"',
  run: async (args, deps) => {
    const id = args.positional[0]
    const story = args.positional.slice(1).join(' ')
    if (!id || story.length === 0) {
      deps.err('usage: mars proposal add-user-story <id> "<text>"')
      return { code: 2 }
    }
    try {
      const idea = await addProposalUserStory(id, story)
      deps.out(`added user story [${idea.userStories.length - 1}] to ${id}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalRemoveUserStory: Command = {
  path: 'proposal remove-user-story',
  summary: 'remove a 0-based user story (positions repack)',
  usage: 'usage: mars proposal remove-user-story <id> <index>',
  run: async (args, deps) => {
    const id = args.positional[0]
    const idxRaw = args.positional[1]
    if (!id || idxRaw === undefined) {
      deps.err('usage: mars proposal remove-user-story <id> <index>')
      return { code: 2 }
    }
    const idx = Number(idxRaw)
    if (!Number.isInteger(idx) || idx < 0) {
      deps.err(`index must be a non-negative integer; got '${idxRaw}'`)
      return { code: 2 }
    }
    try {
      await removeProposalUserStory(id, idx)
      deps.out(`removed user story [${idx}] from ${id}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

/**
 * Land a skill-forge proposal: write the embedded SKILL.md into the template
 * tree and remind the operator to refresh the bundle.
 *
 * Returns a code-only result so callers can `return landSkillProposal(...)`.
 */
function landSkillProposal(
  proposal: NonNullable<Awaited<ReturnType<typeof getProposal>>>,
  deps: CommandDeps,
): { code: number } {
  const match = proposal.solution.match(/^name:\s+(\S+)/m)
  if (!match || !match[1]) {
    deps.err(
      `skill-forge proposal ${proposal.id} has no 'name:' field in frontmatter`,
    )
    return { code: 1 }
  }
  const slug = match[1]
  const target = join(
    deps.ctx.repoRoot,
    'orchestrator/src/init/templates/claude/skills',
    slug,
    'SKILL.md',
  )
  if (existsSync(target)) {
    deps.err(
      `skill already exists at ${target}; remove it first or choose a different name`,
    )
    return { code: 1 }
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, proposal.solution)
  deps.out(`skill ${slug} written to ${target}`)
  deps.out(
    'next: run `npm run mars:bundle:refresh` from orchestrator/ to bundle the new skill',
  )
  return { code: 0 }
}

const proposalPromote: Command = {
  path: 'proposal promote',
  summary: 'mark a shaped draft proposal as PRD-ready and start its slices',
  usage: 'usage: mars proposal promote <id> [--priority 0..3] [--coordinated] [--hold]',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal promote <id> [--priority 0..3] [--coordinated] [--hold]')
      return { code: 2 }
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
    // Resolve the proposal locally so we can branch on source before routing
    // to the daemon (skill-forge proposals are handled entirely client-side).
    const resolved = await resolveProposalId(id)
    if (resolved.kind === 'ambiguous') {
      deps.err(`ambiguous prefix '${id}' matches ${resolved.count} proposals`)
      return { code: 1 }
    }
    if (resolved.kind === 'none') {
      deps.err(`proposal ${id} not found`)
      return { code: 1 }
    }
    const proposal = await getProposal(resolved.id)
    if (!proposal) {
      deps.err(`proposal ${id} not found`)
      return { code: 1 }
    }
    if (proposal.source === 'skill-forge') {
      return landSkillProposal(proposal, deps)
    }
    try {
      const r = (await deps.daemon.sendRequest(
        {
          op: 'proposal.promote',
          proposalId: resolved.id,
          autoApprove: args.flags['--hold'] === undefined,
          coordinated: args.flags['--coordinated'] !== undefined,
          ...(priority !== undefined && { priority }),
        },
        { onSpawnNotice: spawnNoticeErr(deps.err) },
      )) as { proposalId: string; status: string }
      if (args.flags['--hold'] === undefined) {
        deps.out(
          `proposal ${r.proposalId} marked ${r.status}; tasks will be enqueued automatically when slicing completes`,
        )
      } else {
        deps.out(`proposal ${r.proposalId} marked ${r.status}; slicing will pause for plan review`)
      }
      if (!(await isDaemonReachable(deps.ctx.stateDir))) {
        deps.err(
          `proposal ${r.proposalId} promoted; the action-queue row will clear when the daemon next runs (daemon not running — run \`mars daemon start\`).`,
        )
      }
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalSlice: Command = {
  path: 'proposal slice',
  summary: 'decompose a prd-ready proposal into vertical-slice tasks',
  usage: 'usage: mars proposal slice <id> [--priority 0..3] [--coordinated]',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal slice <id> [--priority 0..3] [--coordinated]')
      return { code: 2 }
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
    try {
      if (args.flags['--coordinated'] !== undefined) {
        await setProposalCoordinated(id, true)
      }
      const r = (await deps.daemon.sendRequest(
        { op: 'proposal.slice', proposalId: id, ...(priority !== undefined && { priority }) },
        { onSpawnNotice: spawnNoticeErr(deps.err) },
      )) as { proposalId: string; status: string; taskIds: string[] }
      deps.out(
        `proposal ${r.proposalId} ${r.status} into ${r.taskIds.length} task(s):`,
      )
      for (const t of r.taskIds) deps.out(`  ${t}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalDismiss: Command = {
  path: 'proposal dismiss',
  summary: 'dismiss a proposal',
  usage: 'usage: mars proposal dismiss <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal dismiss <id>')
      return { code: 2 }
    }
    try {
      const idea = await dismissProposal(id)
      deps.out(`dismissed ${idea.id}`)
      if (!(await isDaemonReachable(deps.ctx.stateDir))) {
        deps.err(
          `proposal ${idea.id} dismissed; the action-queue row will clear when the daemon next runs (daemon not running — run \`mars daemon start\`).`,
        )
      }
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalDelete: Command = {
  path: 'proposal delete',
  summary: 'remove a proposal row (cascades user stories)',
  usage: 'usage: mars proposal delete <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal delete <id>')
      return { code: 2 }
    }
    try {
      const deletedId = await deleteProposal(id)
      deps.out(`deleted ${deletedId}`)
      if (!(await isDaemonReachable(deps.ctx.stateDir))) {
        deps.err(
          `proposal ${deletedId} deleted; the action-queue row will clear when the daemon next runs (daemon not running — run \`mars daemon start\`).`,
        )
      }
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalList: Command = {
  path: 'proposal list',
  summary: 'list proposals; filter by source and/or status',
  usage: `usage: mars proposal list [--source ${VALID_SOURCES.join('|')}] [--status <status>]`,
  run: async (args, deps) => {
    const sourceFlag = args.flags['--source']
    const statusFlag = args.flags['--status']
    if (sourceFlag !== undefined && !isProposalSource(sourceFlag)) {
      deps.err(
        `--source must be one of: ${VALID_SOURCES.join('|')}; got '${sourceFlag}'`,
      )
      return { code: 2 }
    }
    const filter: {
      source?: ProposalSource
      status?: string
    } = {}
    if (sourceFlag) filter.source = sourceFlag
    if (statusFlag) filter.status = statusFlag
    const ideas = await listProposals(filter)
    if (ideas.length === 0) {
      deps.out('no proposals')
      return { code: 0 }
    }
    for (const i of ideas) {
      const title = i.title.trim() || '(no title)'
      deps.out(`${i.id.slice(0, 8)}\t${i.status}\tsource=${i.source}\t${title}`)
    }
    return { code: 0 }
  },
}

const proposalBlock: Command = {
  path: 'proposal block',
  summary: 'add planning-graph blocker edges (proposal waits on proposal)',
  usage: 'usage: mars proposal block <proposal-id> <blocker-id> [<blocker-id> ...]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const blockerArgs = args.positional.slice(1)
    if (!id || blockerArgs.length === 0) {
      deps.err(
        'usage: mars proposal block <proposal-id> <blocker-id> [<blocker-id> ...]',
      )
      return { code: 2 }
    }
    if (blockerArgs.some((b) => b === id)) {
      deps.err(`proposal ${id} cannot block itself`)
      return { code: 2 }
    }
    try {
      await addProposalDependencies(id, blockerArgs)
      deps.out(`blocked ${id} by: ${blockerArgs.join(', ')}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalUnblock: Command = {
  path: 'proposal unblock',
  summary: 'remove planning-graph blocker edges',
  usage: 'usage: mars proposal unblock <proposal-id> <blocker-id> [<blocker-id> ...]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const blockerArgs = args.positional.slice(1)
    if (!id || blockerArgs.length === 0) {
      deps.err(
        'usage: mars proposal unblock <proposal-id> <blocker-id> [<blocker-id> ...]',
      )
      return { code: 2 }
    }
    try {
      const removed: string[] = []
      for (const b of blockerArgs) {
        const r = await removeProposalDependency(id, b)
        if (r.removed) removed.push(b)
      }
      deps.out(
        removed.length > 0
          ? `unblocked ${id} from: ${removed.join(', ')}`
          : `no matching edges removed for ${id}`,
      )
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalBlockers: Command = {
  path: 'proposal blockers',
  summary: 'list planning-graph blockers on a proposal',
  usage: 'usage: mars proposal blockers <proposal-id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal blockers <proposal-id>')
      return { code: 2 }
    }
    try {
      const blockers = await listProposalDependencies(id)
      if (blockers.length === 0) {
        deps.out(`no blockers on ${id}`)
        return { code: 0 }
      }
      for (const b of blockers) deps.out(b)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalBlockTask: Command = {
  path: 'proposal block-task',
  summary: 'add cross-graph edge (task waits on proposal)',
  usage: 'usage: mars proposal block-task <task-id> <proposal-id> [<proposal-id> ...]',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    const ideaArgs = args.positional.slice(1)
    if (!taskId || ideaArgs.length === 0) {
      deps.err(
        'usage: mars proposal block-task <task-id> <proposal-id> [<proposal-id> ...]',
      )
      return { code: 2 }
    }
    try {
      const resolvedIds: string[] = []
      for (const raw of ideaArgs) {
        const resolved = await resolveProposalId(raw)
        if (resolved.kind === 'ambiguous') {
          deps.err(`ambiguous prefix '${raw}' matches ${resolved.count} proposals`)
          return { code: 1 }
        }
        if (resolved.kind === 'none') {
          deps.err(`proposal ${raw} not found`)
          return { code: 1 }
        }
        resolvedIds.push(resolved.id)
      }
      await deps.store.addProposalBlockers(taskId, resolvedIds)
      deps.out(`blocked ${taskId} by proposal(s): ${resolvedIds.join(', ')}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalUnblockTask: Command = {
  path: 'proposal unblock-task',
  summary: 'remove cross-graph edges (task waits on proposal)',
  usage: 'usage: mars proposal unblock-task <task-id> <proposal-id> [<proposal-id> ...]',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    const ideaArgs = args.positional.slice(1)
    if (!taskId || ideaArgs.length === 0) {
      deps.err(
        'usage: mars proposal unblock-task <task-id> <proposal-id> [<proposal-id> ...]',
      )
      return { code: 2 }
    }
    try {
      const removed: string[] = []
      for (const raw of ideaArgs) {
        const resolved = await resolveProposalId(raw)
        const idToRemove = resolved.kind === 'unique' ? resolved.id : raw
        const r = await deps.store.removeProposalBlocker(taskId, idToRemove)
        if (r.removed) removed.push(idToRemove)
      }
      deps.out(
        removed.length > 0
          ? `unblocked ${taskId} from proposal(s): ${removed.join(', ')}`
          : `no matching proposal edges removed for ${taskId}`,
      )
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalTaskBlockers: Command = {
  path: 'proposal task-blockers',
  summary: 'list proposal blockers on a task',
  usage: 'usage: mars proposal task-blockers <task-id>',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars proposal task-blockers <task-id>')
      return { code: 2 }
    }
    try {
      const blockers = await deps.store.listProposalBlockers(taskId)
      if (blockers.length === 0) {
        deps.out(`no proposal blockers on ${taskId}`)
        return { code: 0 }
      }
      for (const b of blockers) deps.out(b)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalShipSummary: Command = {
  path: 'proposal ship-summary',
  summary: 'summarise the landed arc for a proposal',
  usage: 'usage: mars proposal ship-summary <id> [--json]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const emitJson = args.positional.includes('--json')
    if (!id) {
      deps.err('usage: mars proposal ship-summary <id> [--json]')
      return { code: 2 }
    }
    const resolved = await resolveProposalId(id)
    if (resolved.kind === 'ambiguous') {
      deps.err(`ambiguous prefix '${id}' matches ${resolved.count} proposals`)
      return { code: 1 }
    }
    const proposal =
      resolved.kind === 'unique' ? await getProposal(resolved.id) : null
    if (!proposal) {
      deps.err(`proposal ${id} not found`)
      return { code: 1 }
    }

    const taskStore = await getDefaultTaskStore()
    const arc = await taskStore.arcStatus(proposal.id, { cwd: deps.ctx.repoRoot })

    type TaskRow = {
      id: string
      shortTitle: string
      status: string
      sha: string | null
      commitSubject: string | null
    }

    const taskRows: TaskRow[] = await Promise.all(
      arc.tasks.map(async (t): Promise<TaskRow> => {
        const full = await deps.store.getTask(t.id)
        const shortTitle = (full?.prompt ?? t.id).split('\n')[0].trim()

        let sha: string | null = null
        let commitSubject: string | null = null

        if (t.status === 'done') {
          try {
            const { stdout } = await execFileAsync(
              'git',
              [
                'log',
                'main',
                `--grep=${t.id}`,
                '--fixed-strings',
                '--format=%H\t%s',
                '-1',
              ],
              { cwd: deps.ctx.repoRoot },
            )
            const line = stdout.trim()
            if (line) {
              const tab = line.indexOf('\t')
              sha = tab >= 0 ? line.slice(0, tab) : line
              commitSubject = tab >= 0 ? line.slice(tab + 1) : ''
            }
          } catch {
            // best-effort: no commit found for this task id
          }
        }

        return { id: t.id, shortTitle, status: t.status, sha, commitSubject }
      }),
    )

    if (emitJson) {
      deps.out(
        JSON.stringify(
          {
            proposalId: proposal.id,
            title: proposal.title.split('\n')[0].trim(),
            arcState: arc.status,
            tasks: taskRows.map((r) => ({
              id: r.id,
              shortTitle: r.shortTitle,
              status: r.status,
              sha: r.sha,
              commitSubject: r.commitSubject,
            })),
            landedCommits: arc.landedCommits,
          },
          null,
          2,
        ),
      )
      return { code: 0 }
    }

    deps.out(`proposal: ${proposal.id}`)
    deps.out(`title:    ${proposal.title.split('\n')[0].trim()}`)
    deps.out(`arc:      ${arc.status}`)
    if (taskRows.length > 0) {
      deps.out('')
      for (const row of taskRows) {
        const display =
          row.status === 'dropped'
            ? 'dismissed'
            : row.status === 'done' && row.sha !== null
              ? `${row.sha.slice(0, 7)} ${row.commitSubject ?? ''}`
              : row.status
        deps.out(`  ${row.id}  ${row.shortTitle}  ${display}`)
      }
    }
    return { code: 0 }
  },
}

const proposalApprove: Command = {
  path: 'proposal approve',
  summary: 'approve a sliced plan and enqueue all slice tasks',
  usage: 'usage: mars proposal approve <id> [--coordinated]',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal approve <id> [--coordinated]')
      return { code: 1 }
    }
    try {
      if (args.flags['--coordinated'] !== undefined) {
        await setProposalCoordinated(id, true)
      }
      const r = (await deps.daemon.sendRequest(
        { op: 'proposal.approve', proposalId: id },
        { onSpawnNotice: spawnNoticeErr(deps.err) },
      )) as { proposalId: string; queuedCount: number; blockedCount: number }
      deps.out(
        `proposal ${r.proposalId} approved: ${r.queuedCount} task(s) queued, ${r.blockedCount} blocked`,
      )
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalTake: Command = {
  path: 'proposal take',
  summary:
    'take a shaped proposal live as ONE task on the chosen workflow (human-driven, no slicer); use `proposal slice` for multi-slice decomposition',
  usage: 'usage: mars proposal take <id> [--workflow <kind>]',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars proposal take <id> [--workflow <kind>]')
      return { code: 1 }
    }
    const workflow = args.flags['--workflow']?.trim() ?? 'live'

    // Resolve and validate the proposal locally so errors are actionable
    // before the daemon is ever contacted.
    const resolved = await resolveProposalId(id)
    if (resolved.kind === 'ambiguous') {
      deps.err(`ambiguous prefix '${id}' matches ${resolved.count} proposals`)
      return { code: 1 }
    }
    if (resolved.kind === 'none') {
      deps.err(`proposal ${id} not found`)
      return { code: 1 }
    }
    const proposal = await getProposal(resolved.id)
    if (!proposal) {
      deps.err(`proposal ${id} not found`)
      return { code: 1 }
    }
    const missing = validateProposalShaped(proposal)
    if (missing.length > 0) {
      deps.err(
        `proposal ${proposal.id} is not fully shaped; missing: ${missing.join(', ')}. ` +
          `Shape it with 'mars proposal set ${proposal.id} <field> <value>' and ` +
          `'mars proposal add-user-story ${proposal.id} <story>'.`,
      )
      return { code: 1 }
    }

    try {
      const r = (await deps.daemon.sendRequest(
        { op: 'proposal.take', proposalId: resolved.id, workflow },
        { onSpawnNotice: spawnNoticeErr(deps.err) },
      )) as { proposalId: string; taskId: string }
      deps.out(`proposal ${r.proposalId} taken as task ${r.taskId} (workflow: ${workflow})`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalReslice: Command = {
  path: 'proposal reslice',
  summary: 'discard current slices and re-run the Slicer with operator feedback',
  usage: 'usage: mars proposal reslice <id> --feedback "<text>" [--priority 0..3]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const feedback = args.flags['--feedback']
    if (!id || !feedback) {
      deps.err('usage: mars proposal reslice <id> --feedback "<text>" [--priority 0..3]')
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
    try {
      const r = (await deps.daemon.sendRequest(
        { op: 'proposal.reslice', proposalId: id, feedback, ...(priority !== undefined && { priority }) },
        { onSpawnNotice: spawnNoticeErr(deps.err) },
      )) as { proposalId: string; status: string; taskIds: string[] }
      deps.out(
        `proposal ${r.proposalId} resliced to ${r.status} into ${r.taskIds.length} task(s):`,
      )
      for (const t of r.taskIds) deps.out(`  ${t}`)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const proposalGroupUsage = `usage: mars proposal <subcommand>

  CRUD:      add  list  show  set  delete
  PRD:       add-user-story  remove-user-story
  Lifecycle: promote  slice  approve  take  reslice  dismiss
  Blockers:  block  unblock  blockers  block-task  unblock-task  task-blockers
  Reports:   ship-summary`

const proposalGroup: Command = {
  path: 'proposal',
  summary: 'proposal subcommands',
  usage: proposalGroupUsage,
  run: (_args, deps) => {
    deps.err(proposalGroupUsage)
    return { code: 2 }
  },
}

export const proposalCommands: readonly Command[] = [
  proposalAdd,
  proposalShow,
  proposalSet,
  proposalAddUserStory,
  proposalRemoveUserStory,
  proposalPromote,
  proposalSlice,
  proposalTake,
  proposalApprove,
  proposalReslice,
  proposalDismiss,
  proposalDelete,
  proposalList,
  proposalBlock,
  proposalUnblock,
  proposalBlockers,
  proposalBlockTask,
  proposalUnblockTask,
  proposalTaskBlockers,
  proposalShipSummary,
  proposalGroup,
]
