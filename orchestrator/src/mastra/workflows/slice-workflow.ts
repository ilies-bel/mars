import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getProposal, getProposalsClient, markProposalSliced } from '../proposals'
import {
  getClient as getQueueClient,
  enqueueTask,
  initQueue,
} from '../queue'
import { Workers } from '../workers'
import { parseClaudeJsonResult } from '../lib/claude-json'
import { getRepoRoot } from '../context'

const sliceInputSchema = z.object({
  ideaId: z.string(),
})

const sliceOutputSchema = z.object({
  ideaId: z.string(),
  status: z.string(),
  taskIds: z.array(z.string()),
})

export const slicerOutputSchema = z.object({
  slices: z
    .array(
      z.object({
        title: z.string(),
        type: z.enum(['HITL', 'AFK']).default('AFK'),
        whatToBuild: z.string(),
        acceptanceCriteria: z.array(z.string()).min(1),
        blockedBy: z.array(z.number().int().min(1)),
        // Ordered list of file paths the implementor should read before
        // touching anything. Required and non-empty so the implementor
        // always starts from the right files rather than re-orienting.
        readFirst: z.array(z.string()).min(1),
        // Prescriptive description naming exact functions, types,
        // variables, SQL columns, or file paths to change and their exact
        // target state. Required and non-empty so every slice carries
        // code-level specifics, not just user-visible behaviour.
        prescriptiveAction: z.string().min(1),
        // gsd-style structured-task spec. The slicer names the files it
        // expects the implementor to touch — split into two arrays so the
        // slicer must consciously distinguish files it knows already exist
        // (modifies) from files it intends to create (creates). The split
        // exists to curb path hallucination: a guessed path inside a
        // module that doesn't exist had been silently landing in `files`
        // and blocking slices. Both default to []; they are concatenated
        // into the queue's `files_json` column at persist time so the
        // implementor brief stays one flat list.
        modifies: z.array(z.string()).default([]),
        creates: z.array(z.string()).default([]),
        verifyCmd: z.string().nullable().default(null),
        taskType: z.enum(['auto', 'checkpoint']).default('auto'),
      }),
    )
    .min(1)
    .max(20),
})

type SliceSpec = z.infer<typeof slicerOutputSchema>['slices'][number]

/**
 * Concatenate a slice's `modifies` + `creates` into the single flat
 * `files` list the queue persists into `tasks.files_json`. The slicer
 * schema splits the two so the prompt can discipline path hallucination
 * separately for "edit this existing file" vs "create this new file";
 * downstream (the implementor brief, the `files_json` column, the rest
 * of the orchestrator) still sees one array, so no other call site
 * needs to change shape. Exported for unit tests that round-trip a
 * slicer output through the persistence path.
 */
export const sliceFilesForPersistence = (slice: {
  modifies: readonly string[]
  creates: readonly string[]
}): string[] => [...slice.modifies, ...slice.creates]

const renderUserStories = (stories: readonly string[]): string => {
  if (stories.length === 0) return '(none)'
  return stories.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

export const buildSlicerPrompt = (idea: {
  id: string
  title: string
  problem: string
  solution: string
  outOfScope: string
  notes: string
  userStories: string[]
}): string => `Break this PRD into independently-grabbable issues using vertical
slices (tracer bullets). Each slice is a thin vertical tracer cutting
end-to-end through every layer. Prefer many thin slices over few thick ones.

HITL vs AFK
-----------
Slices may be 'HITL' or 'AFK'. HITL slices require human interaction
(architectural decision, design review). AFK slices can be implemented
and merged without human interaction. Prefer AFK over HITL where possible.

Structured-writes are settled at grill time — never slice one
-------------------------------------------------------------
A STRUCTURED-WRITE is a glossary or ADR mutation. Per ADR 0019,
structured-writes are never a dispatched slice's deliverable: glossary
terms and ADRs are decided and recorded during GRILLING, before a PRD is
ever promoted. By the time a PRD reaches you the structured-write has
already happened and the vocabulary is settled. Therefore: NEVER produce
a slice whose sole deliverable is a structured-write — i.e. a glossary
change or an ADR change. If this PRD still describes such a
structured-write as its own deliverable, treat that as an upstream
process violation — a PRD that was promoted before its vocabulary was
settled at grill time — not a case to accommodate. Do not add a slice
for it, do not branch your output around it, do not "detect" it: this is
guidance only. Just decompose the remaining real work and leave the
structured-write out, because it should already have happened during
grilling.

Output shape
------------
For each slice, produce:
- title — a short descriptive name
- type — "HITL" or "AFK"
- whatToBuild — concise end-to-end behaviour description from the user's
  perspective. Describe what the user observes when this slice is done.
- acceptanceCriteria — a list of checkbox items the slice must satisfy
  to be considered complete. Each item is a single concrete observable.
- blockedBy — 1-based indices of other slices in the same response that
  this one must wait for. Use sparingly; most slices should parallelise.
- readFirst — an ordered list of file paths the implementor must read
  before touching anything. Place the files most likely to need editing
  first; the implementor reads them in order before writing a single line
  of code. At least one real path is required — do not leave this empty.
- prescriptiveAction — a prescriptive description naming the exact
  functions, exported types, variables, SQL columns, Zod schemas, or
  file paths to change and their exact target state. Use code-shaped
  language freely: name specific identifiers, exact strings, exact line
  ranges when known. At least one concrete identifier or file path is
  required — do not leave this empty or write vague prose.
- modifies — array of paths to files that ALREADY EXIST in the
  project and this slice edits. Cite real paths only. If you are
  unsure whether a file exists, OMIT it — the implementor will
  discover the right file rather than be misled by your guess.
- creates — array of paths to files this slice will create. Prefer
  new files under existing directories. If you propose a NEW
  directory (a path whose parent doesn't already exist in the
  project), prefix the path with 'NEW: ' so the implementor knows
  it is a deliberate structural choice and not a misremembered
  location. Example: 'NEW: orchestrator/src/manifest/load.ts'.
- verifyCmd — a single shell command that the implementor must run to
  prove the slice landed (e.g. "npx vitest run src/foo.test.ts" or
  "npx tsc --noEmit"). When the project lives in a subdirectory, the
  command MUST cd into that subdirectory first, e.g.
  "cd orchestrator && npx vitest run src/foo.test.ts". Empty string
  if the project's default verify is sufficient.
- taskType — "auto" for slices the implementor can drive end-to-end and
  commit, or "checkpoint" for slices that need human verification before
  merge. Default "auto"; reach for "checkpoint" only when a human must
  visually confirm an output the verifier cannot.

Return ONLY a single JSON object matching exactly this shape, with no
surrounding prose, no code fences, and no commentary:

{"slices":[{"title":"...","type":"AFK","whatToBuild":"...","acceptanceCriteria":["..."],"blockedBy":[],"readFirst":["src/foo.ts"],"prescriptiveAction":"In fooFn (foo.ts:42), change return type from string to number and update all call sites.","modifies":["src/foo.ts"],"creates":["src/foo.test.ts"],"verifyCmd":"cd src && npx vitest run foo.test.ts","taskType":"auto"}]}

PRD to decompose
================

Title: ${idea.title}

Problem
-------
${idea.problem || '(not specified)'}

Solution
--------
${idea.solution || '(not specified)'}

User stories
------------
${renderUserStories(idea.userStories)}

Out of scope
------------
${idea.outOfScope || '(not specified)'}

Notes
-----
${idea.notes || '(not specified)'}
`

const parseSlicerOutput = (
  claudeStdout: string,
): z.infer<typeof slicerOutputSchema> =>
  slicerOutputSchema.parse(parseClaudeJsonResult(claudeStdout))

/**
 * Schema-drop / breaking-shape signal in a slice title or whatToBuild.
 * Keyed to vocabulary already used by the slicer for this case ("Drop
 * <ident> column from <db> schema (hard cut, no migration)") rather
 * than inferred semantics — see the matching tests in
 * __tests__/slice-workflow.test.ts for the canonical shapes.
 */
const SCHEMA_DROP_PATTERNS: readonly RegExp[] = [
  /\bdrop\b[^.\n]*\b(column|schema|table|field)\b/i,
  /\bhard\s+cut\b/i,
]

const sliceText = (s: { title: string; whatToBuild: string }): string =>
  `${s.title}\n${s.whatToBuild}`

const isSchemaDropSlice = (s: {
  title: string
  whatToBuild: string
}): boolean => {
  const hay = sliceText(s)
  return SCHEMA_DROP_PATTERNS.some((p) => p.test(hay))
}

/**
 * Extract snake_case identifiers (one or more underscore-joined lowercase
 * segments) from a slice's title/whatToBuild. These are the textual
 * stand-ins for column/field names the slicer used when describing the
 * drop — e.g. `total_cost_usd`. Identifiers without an underscore are
 * intentionally ignored: bare words like `tasks` or `queue` are too
 * generic and would over-match other slices.
 */
const extractSchemaIdentifiers = (text: string): string[] => {
  const matches = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []
  return Array.from(new Set(matches))
}

const sliceMentions = (
  s: { title: string; whatToBuild: string },
  ident: string,
): boolean => new RegExp(`\\b${ident}\\b`).test(sliceText(s))

/**
 * Post-process the slicer's output so a schema-drop / breaking-shape
 * slice is forced to wait on every consumer-update slice in the same
 * PRD that mentions the dropped identifier.
 *
 * Rationale (concrete failure that motivated this): PRD
 * 1b7498f6-remove-all-usd-cost-usd-mentions-from-th sliced into a
 * "Drop total_cost_usd column" slice plus three "Remove total_cost_usd
 * from <consumer>" slices. The slicer LLM emitted ZERO blocker edges,
 * so the schema-drop slice dispatched first and burned its full retry
 * budget on `SQLITE_ERROR: no such column: s.total_cost_usd` inside
 * consumer tests that still read the column. This pass injects the
 * edges the LLM forgot, from the textual signal already in the slice
 * titles (no new heuristics — the language is there). The injection
 * is idempotent, preserves any blockedBy the slicer declared, skips
 * other schema-drop slices to avoid drop↔drop cycles, and skips
 * candidates that already declare the drop as their upstream so the
 * tree stays acyclic.
 *
 * Mutates `slices` in place; exported for unit testing.
 */
export const injectSchemaDropBlockers = (
  slices: Array<{
    title: string
    whatToBuild: string
    blockedBy: number[]
  }>,
): void => {
  const schemaDropIndices: number[] = []
  for (let i = 0; i < slices.length; i += 1) {
    if (isSchemaDropSlice(slices[i])) schemaDropIndices.push(i)
  }
  if (schemaDropIndices.length === 0) return

  for (const dropIdx of schemaDropIndices) {
    const drop = slices[dropIdx]
    const idents = extractSchemaIdentifiers(sliceText(drop))
    if (idents.length === 0) continue

    const dropOneBased = dropIdx + 1
    const merged = new Set<number>(drop.blockedBy)
    for (let j = 0; j < slices.length; j += 1) {
      if (j === dropIdx) continue
      const cand = slices[j]
      // Only consumer (non-drop) slices are valid blockers — skipping
      // other drops also avoids drop↔drop cycles if a PRD ever splits a
      // multi-column drop.
      if (isSchemaDropSlice(cand)) continue
      // Cycle guard: if the candidate already declares this drop as a
      // blocker (an inverted slicer ordering), don't add the reverse
      // edge.
      if (cand.blockedBy.includes(dropOneBased)) continue
      // Textual link: candidate must mention at least one snake_case
      // identifier the drop names.
      if (!idents.some((ident) => sliceMentions(cand, ident))) continue
      merged.add(j + 1)
    }
    drop.blockedBy = Array.from(merged).sort((a, b) => a - b)
  }
}

/**
 * Drop slices whose every `creates` file already exists on disk and already
 * exports every backtick-declared symbol found in `prescriptiveAction`.
 * Blocker edges pointing at dropped slices are removed from surviving slices;
 * surviving slice indices are re-numbered so `blockedBy` stays valid (1-based
 * into the returned slice list).
 *
 * Only `creates` files are examined — `modifies` paths are not checked because
 * a slice that edits an existing file may still have pending work even when
 * the file exists. Partial symbol coverage (file exists but a symbol is
 * missing) is intentionally NOT dropped — the slice must still land that
 * symbol.
 *
 * Exported for unit testing.
 */
export const dropAlreadySatisfiedSlices = (
  slices: SliceSpec[],
  repoRoot: string,
): SliceSpec[] => {
  const droppedOriginal = new Set<number>() // 0-based positions

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]
    // Only slices that declare files to create can be pre-flight-dropped.
    if (slice.creates.length === 0) continue

    // Extract backtick-delimited leading identifiers from prescriptiveAction.
    const symbols = [
      ...new Set(
        [
          ...slice.prescriptiveAction.matchAll(
            /`([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
          ),
        ].map((m) => m[1]),
      ),
    ]
    // No declared symbols → can't confirm coverage; leave the slice.
    if (symbols.length === 0) continue

    // All creates files must exist on disk.
    const allExist = slice.creates.every((f) => {
      try {
        return existsSync(resolve(repoRoot, f))
      } catch {
        return false
      }
    })
    if (!allExist) continue

    // Every creates file must export every declared symbol.
    const allExported = slice.creates.every((f) => {
      try {
        const content = readFileSync(resolve(repoRoot, f), 'utf-8')
        return symbols.every((sym) =>
          new RegExp(`\\bexport\\b[^\\n]*\\b${sym}\\b`).test(content),
        )
      } catch {
        return false
      }
    })
    if (!allExported) continue

    droppedOriginal.add(i)
  }

  if (droppedOriginal.size === 0) return slices

  // Build old (1-based) → new (1-based) index mapping for surviving slices.
  const oldToNew = new Map<number, number>()
  let newIdx = 0
  for (let i = 0; i < slices.length; i++) {
    if (!droppedOriginal.has(i)) {
      newIdx++
      oldToNew.set(i + 1, newIdx)
    }
  }

  // Filter out dropped slices and re-index blockedBy.
  return slices
    .filter((_, i) => !droppedOriginal.has(i))
    .map((slice) => ({
      ...slice,
      blockedBy: slice.blockedBy
        .filter((dep) => !droppedOriginal.has(dep - 1))
        .map((dep) => oldToNew.get(dep)!)
        .sort((a, b) => a - b),
    }))
}

/**
 * Maximum characters for the goal line inside the per-slice parent digest.
 * Exported so tests can verify that long solutions are truncated.
 */
export const DIGEST_GOAL_CHARS = 150

/**
 * Maximum characters for the non-goals line inside the per-slice parent
 * digest. Exported so tests can verify that long out-of-scope fields are
 * truncated.
 */
export const DIGEST_NON_GOALS_CHARS = 200

/**
 * Truncate `text` at the last word boundary before `maxLen` characters.
 * Appends an ellipsis when truncation occurs. Returns the input unchanged
 * when it fits within the limit.
 */
const truncateAtWord = (text: string, maxLen: number): string => {
  if (text.length <= maxLen) return text
  const cut = text.lastIndexOf(' ', maxLen)
  const boundary = cut > 0 ? cut : maxLen
  return `${text.slice(0, boundary)}…`
}

/**
 * Build the dispatched-coder prompt for a single slice. A short, bounded
 * parent digest is inlined — covering the parent goal (1–2 sentences),
 * this slice's blockers, and the PRD's non-goals — so the implementor does
 * NOT need to run `mars proposal show <id>` to obtain context and does NOT
 * receive a multi-KB verbatim PRD body that bloats every slice prompt.
 *
 * Rationale: dispatched coders execute from `.mars/worktrees/<id>/`, where
 * `mars` resolves the repo upward from CWD and silently binds to the
 * worktree's own (empty) `.mars/`. A bare `mars proposal show <id>` returns
 * 'not found' and burns the implementor's read/grep budget reverse-
 * engineering scope. The digest removes the lookup entirely while keeping
 * per-slice prompts lean.
 *
 * Exported for unit testing.
 */
export const composeTaskPrompt = (
  idea: {
    id: string
    title: string
    problem: string
    solution: string
    outOfScope: string
    notes: string
    userStories: readonly string[]
  },
  slice: SliceSpec,
  index: number,
  total: number,
): string => {
  const acceptance = slice.acceptanceCriteria
    .map((c) => `- [ ] ${c}`)
    .join('\n')

  const readFirstSection =
    slice.readFirst.length > 0
      ? `\n## Read first (in order)\n\n${slice.readFirst.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n`
      : ''

  const allFiles = [...slice.modifies, ...slice.creates]
  const filesSection =
    allFiles.length > 0
      ? `\n## Files\n\n${allFiles.map((f) => `- ${f}`).join('\n')}\n`
      : ''

  const rawGoal = (idea.solution || idea.title).trim()
  const goal = truncateAtWord(rawGoal, DIGEST_GOAL_CHARS)

  const blockers =
    slice.blockedBy.length === 0
      ? '(none)'
      : `slices ${slice.blockedBy.join(', ')} in this PRD`

  const rawNonGoals = (idea.outOfScope || '').trim()
  const nonGoals = rawNonGoals
    ? truncateAtWord(rawNonGoals, DIGEST_NON_GOALS_CHARS)
    : '(none)'

  return `# ${slice.title}

Slice ${index} of ${total} for PRD ${idea.id}: ${idea.title}
Type: ${slice.type}

## What to build

${slice.whatToBuild}

## Acceptance criteria

${acceptance}
${readFirstSection}
## Action

${slice.prescriptiveAction}
${filesSection}
## Context

This is a tracer-bullet vertical slice — implement the thinnest path through
every layer needed to satisfy the acceptance criteria, then stop. Other
slices in the same PRD will thicken this work; do not pre-build for them.

Match the project's existing testing and naming conventions.

## Parent digest

**Goal:** ${goal}

**Blockers:** ${blockers}

**Non-goals:** ${nonGoals}

Save your work: stage and commit when verify passes.
`
}

const generateStep = createStep({
  id: 'generate-slices',
  inputSchema: sliceInputSchema,
  outputSchema: sliceOutputSchema,
  execute: async ({ inputData, tracingContext }) => {
    const idea = await getProposal(inputData.ideaId)
    if (!idea) throw new Error(`idea ${inputData.ideaId} not found`)
    if (idea.status !== 'prd-ready') {
      throw new Error(
        `idea ${idea.id} is '${idea.status}'; only prd-ready ideas can be sliced`,
      )
    }

    tracingContext?.currentSpan?.update({
      metadata: { ideaId: idea.id, originId: idea.id },
    })

    const r = await Workers.Slicer.run(buildSlicerPrompt(idea), {
      cwd: getRepoRoot(),
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      )
    }

    const parsed = parseSlicerOutput(r.stdout)
    // Repair: the slicer LLM routinely forgets to wire schema-drop ↔
    // consumer-update edges, sending a "Drop <col>" slice to dispatch
    // before the slices that remove reads of <col> land. Inject those
    // edges here from the textual signal already in slice titles, before
    // the validation loop runs (the injected indices are always in
    // range, so validation still passes).
    injectSchemaDropBlockers(parsed.slices)
    // Pre-flight drop: remove any slice whose creates files already exist
    // on disk and already export every backtick-declared symbol. Blocker
    // edges pointing at dropped slices are removed from surviving slices.
    parsed.slices = dropAlreadySatisfiedSlices(parsed.slices, getRepoRoot())
    const total = parsed.slices.length

    // Validate dependency indices before any DB writes.
    for (let i = 0; i < total; i += 1) {
      for (const dep of parsed.slices[i].blockedBy) {
        if (dep < 1 || dep > total) {
          throw new Error(
            `slice ${i + 1} declares blockedBy=${dep} which is out of range 1..${total}`,
          )
        }
        if (dep === i + 1) {
          throw new Error(`slice ${i + 1} cannot depend on itself`)
        }
      }
    }

    await initQueue()
    const queueClient = getQueueClient()
    const ideasClient = getProposalsClient()

    // Pre-flight: crash-recovery deduplication. A process crash between
    // Phase 1 (task inserts) and Phase 4 (status flip) leaves the idea
    // prd-ready with orphaned tasks in the queue. Without this cleanup,
    // a retry would insert a fresh set of tasks on top of the orphans,
    // creating duplicates. Delete any tasks that claim this idea as
    // parent before starting Phase 1 so retries are idempotent.
    await queueClient
      .execute({
        sql: `DELETE FROM task_blockers WHERE task_id IN (
                SELECT id FROM tasks WHERE parent_proposal_id = ?
              ) OR blocker_task_id IN (
                SELECT id FROM tasks WHERE parent_proposal_id = ?
              )`,
        args: [idea.id, idea.id],
      })
      .catch(() => {})
    await queueClient
      .execute({
        sql: `DELETE FROM tasks WHERE parent_proposal_id = ?`,
        args: [idea.id],
      })
      .catch(() => {})

    const taskIds: string[] = []
    // Tracks whether Phase 4 successfully flipped the idea row to 'sliced'.
    // The catch block uses this to compensate (revert to 'prd-ready') when
    // a failure after the flip would otherwise strand the idea as 'sliced'
    // with no surviving tasks — wedging it permanently, since the
    // precondition above refuses to re-slice anything that is not
    // 'prd-ready' and the daemon's auto-slice loop only picks up
    // 'prd-ready' ideas.
    let ideaFlipped = false

    // The writes span two DBs (queue.db for tasks/blockers, state.db for
    // the idea row), so we cannot wrap them in a single transaction. We
    // do best-effort with cleanup on error: if anything fails after task
    // inserts begin, delete the inserted slice tasks AND revert the
    // idea's status back to 'prd-ready' if we already flipped it, before
    // re-throwing — so a failed slice is fully undone and the idea is
    // re-sliceable.
    try {
      // Phase 1: insert each slice as a 'draft' task carrying parent_idea_id
      // and slice_index. We transition status in Phase 3.
      for (let i = 0; i < total; i += 1) {
        const slice = parsed.slices[i]
        const prompt = composeTaskPrompt(idea, slice, i + 1, total)
        const verifyCmd =
          slice.verifyCmd !== null && slice.verifyCmd.trim().length > 0
            ? slice.verifyCmd
            : null
        const files = sliceFilesForPersistence(slice)
        const task = await enqueueTask(prompt, undefined, {
          author: idea.author ?? undefined,
          originId: idea.id,
          parentProposalId: idea.id,
          sliceIndex: i + 1,
          spec: {
            files,
            verifyCmd,
            doneCriteria: slice.acceptanceCriteria,
            taskType: slice.taskType,
          },
        })
        taskIds.push(task.id)
      }
      // Phase 2: wire blockers using the resolved task ids.
      const now = new Date().toISOString()
      for (let i = 0; i < total; i += 1) {
        const deps = parsed.slices[i].blockedBy
        for (const dep of deps) {
          await queueClient.execute({
            sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
                  VALUES (?, ?, ?)`,
            args: [taskIds[i], taskIds[dep - 1], now],
          })
        }
      }
      // Phase 3: transition each slice to 'queued' (no blockers) or
      // 'blocked' (has blockers). The daemon will pick up queued ones.
      for (let i = 0; i < total; i += 1) {
        const status = parsed.slices[i].blockedBy.length === 0 ? 'queued' : 'blocked'
        await queueClient.execute({
          sql: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
          args: [status, now, taskIds[i]],
        })
      }
      // Defensive: never mark an idea 'sliced' with zero tasks. The
      // slicerOutputSchema already enforces `slices.min(1)` and Phase 1
      // pushes every successfully-enqueued task into `taskIds`, so this
      // branch only fires if some upstream path silently committed an
      // empty parse result. Throwing here lets the catch block revert
      // any partial state and surface the bug instead of stranding the
      // idea as 'sliced' with no work to do.
      if (taskIds.length === 0) {
        throw new Error(
          `slicer produced 0 tasks for idea ${idea.id}; refusing to mark idea 'sliced' with no surviving tasks`,
        )
      }
      // Phase 4: flip the idea row to 'sliced' so subsequent invocations
      // refuse to re-slice (the precondition above checks 'prd-ready').
      // markProposalSliced updates state.db and emits proposal.sliced on
      // the event bus (best-effort, non-atomic with the queue.db writes).
      await markProposalSliced(idea.id, taskIds.length)
      ideaFlipped = true
      // Phase 5 (ADR-0015 promote transfer): any task that was blocked by
      // THIS idea via task_proposal_blockers must now be re-pointed at the
      // resulting work, atomically, so no dispatcher tick observes the
      // dependent with zero blockers between the delete and the insert.
      // transferProposalBlockerToTask does both writes (delete the
      // task_proposal_blockers row, insert the task_blockers row) in ONE
      // queue.db `batch(..., 'write')` transaction — both tables are in
      // queue.db, so this is genuinely atomic, not merely ordered.
      //
      // TODO(ADR-0015 fan-out): the ADR pins only the single
      // new_blocker_task_id case. A slice produces N tasks; ADR-0015 is
      // SILENT on whether the dependent should then wait on all N. Per the
      // task brief we implement the single-new-blocker case verbatim and
      // re-point dependents at the FIRST slice task (taskIds[0]) rather than
      // inventing fan-out semantics. taskIds[0] is the natural single
      // anchor: with the slicer's intra-slice blockers, completing the
      // whole arc still gates on it transitively in the common chained
      // shape. True N-fan-out is deferred and called out in the report.
      if (taskIds.length > 0) {
        const { transferProposalBlockerToTask } = await import('../queue')
        await transferProposalBlockerToTask(idea.id, taskIds[0])
      }
    } catch (error: unknown) {
      for (const id of taskIds) {
        await queueClient
          .execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] })
          .catch(() => {})
        await queueClient
          .execute({
            sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
            args: [id, id],
          })
          .catch(() => {})
      }
      // Compensating revert: the writes that mutate state.db (the idea
      // status flip in Phase 4) live outside the queue.db cleanup above
      // and cannot be wrapped in a single transaction with the task
      // inserts. If we already flipped the idea to 'sliced' before
      // failing later (e.g. in Phase 5's blocker-transfer), revert it
      // back to 'prd-ready' so the daemon auto-slice loop and
      // `mars proposal slice` can pick it up again. Best-effort — a revert
      // failure should not mask the original cause.
      if (ideaFlipped) {
        await ideasClient
          .execute({
            sql: `UPDATE proposals SET status = 'prd-ready', updated_at = ? WHERE id = ?`,
            args: [Date.now(), idea.id],
          })
          .catch(() => {})
      }
      throw error
    }

    return { ideaId: idea.id, status: 'sliced', taskIds }
  },
})

export const sliceWorkflow = createWorkflow({
  id: 'slice',
  inputSchema: sliceInputSchema,
  outputSchema: sliceOutputSchema,
})
  .then(generateStep)
  .commit()

export interface RunSliceResult {
  ideaId: string
  status: string
  taskIds: string[]
}

/** Bound on the synthesized failure message so it stays log-friendly even
 * when a step error carries a giant stack or serialized payload. */
const MAX_SLICE_FAILURE_CHARS = 1000

/**
 * Normalize an unknown error-ish value into a single human-readable line.
 * Mastra's `result.error` / step `error` is an `Error` in-process but a
 * serialized `{ name, message, stack }` object when the run is rehydrated
 * from storage, and older/other versions surface a bare string — handle
 * all three rather than assuming one shape.
 */
const stringifyErrorLike = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) {
    return value.message?.trim() || value.name || String(value)
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      return typeof obj.name === 'string' && obj.name.length > 0
        ? `${obj.name}: ${obj.message.trim()}`
        : obj.message.trim()
    }
    try {
      const json = JSON.stringify(value)
      if (json && json !== '{}') return json
    } catch {
      // circular / non-serializable — fall through to String()
    }
  }
  return String(value)
}

/**
 * Build a diagnostic message from a non-success slice workflow result.
 * Surfaces Mastra's top-level `result.error` and the first failing step's
 * error so a live slicer outage is diagnosable from the daemon log / CLI
 * instead of the content-free status word. Exported for unit testing.
 */
export const describeSliceFailure = (result: unknown): string => {
  const r = (result ?? {}) as {
    status?: unknown
    error?: unknown
    steps?: unknown
  }
  const status = typeof r.status === 'string' ? r.status : 'failed'
  const parts: string[] = [`slice workflow ${status}`]

  const topError = stringifyErrorLike(r.error)
  if (topError) parts.push(`error: ${topError}`)

  if (r.steps && typeof r.steps === 'object') {
    for (const [stepId, stepResult] of Object.entries(
      r.steps as Record<string, unknown>,
    )) {
      if (
        stepResult &&
        typeof stepResult === 'object' &&
        (stepResult as { status?: unknown }).status === 'failed'
      ) {
        const stepError = stringifyErrorLike(
          (stepResult as { error?: unknown }).error,
        )
        parts.push(`step "${stepId}" failed${stepError ? `: ${stepError}` : ''}`)
        break
      }
    }
  }

  const message = parts.join(' — ')
  return message.length > MAX_SLICE_FAILURE_CHARS
    ? `${message.slice(0, MAX_SLICE_FAILURE_CHARS)}…`
    : message
}

export const runSlice = async (ideaId: string): Promise<RunSliceResult> => {
  const run = await sliceWorkflow.createRun()
  const result = await run.start({ inputData: { ideaId } })
  if (result.status !== 'success') {
    throw new Error(describeSliceFailure(result))
  }
  return result.result
}
