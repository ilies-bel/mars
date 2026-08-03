import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { createQueueWorkflowStore } from './queue-workflow-store'
import {
  claimProposalForSlicing,
  getProposal,
  markProposalSliced,
} from '../core/proposals'
import { getDefaultStateStore } from '../core/store/state-store'
import { enqueueTask, updateTask } from '../core/queue'
import { Arc } from '../core/arc'
import { type DomainTaskStore, getDefaultTaskStore } from '../core/store/task-store'
import { Workers } from '../core/workers'
import { parseWorkerJsonResult } from '../core/lib/worker-json'
import { getRepoRoot } from '../core/context'
import { listActionQueueItems, raiseActionQueueItem } from '../core/lib/action-queue'
import { type TraceEventStore } from '../core/lib/trace-events-store'
import { nullTraceStore } from '../core/lib/run-tool'
import { runWorkerWithSpan } from '../core/lib/run-worker-with-span'
import { diagnoseClaudeFailure } from '../core/lib/claude-stream'
import { validateSliceReferences } from './slice-reference-validator'
import type { SliceSpec } from '../core/slice-spec'

const sliceInputSchema = z.object({
  proposalId: z.string(),
  /** Optional operator feedback from a prior reslice invocation. When set,
   *  appended to the Slicer prompt so the model can revise its output. */
  resliceFeedback: z.string().optional(),
  /** Task priority (0–3) to assign to every slice task created by this run.
   *  When omitted, tasks land at the default priority (0). */
  priority: z.number().int().min(0).max(3).optional(),
})

const sliceOutputSchema = z.object({
  proposalId: z.string(),
  status: z.string(),
  taskIds: z.array(z.string()),
  queuedTaskIds: z.array(z.string()),
  blockedTaskIds: z.array(z.string()),
})

/**
 * Coder-dispatchable artifact spec attached by the slicer to an hitl slice.
 * Describes the artifact (typically a verify script) the human operator will
 * use to confirm the HITL step. Must be present on every kind='hitl' slice
 * and absent on every kind='coder' slice — enforced via superRefine below.
 */
export const subDeliverableSchema = z.object({
  title: z.string().min(1),
  whatToBuild: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  files: z.array(z.string()).optional(),
})

export type SubDeliverableSpec = z.infer<typeof subDeliverableSchema>

export const slicerOutputSchema = z.object({
  slices: z
    .array(
      z
        .object({
          title: z.string(),
          type: z.enum(['HITL', 'AFK']).default('AFK'),
          /**
           * Routing kind. 'coder' (default) dispatches to the Coder worker.
           * 'hitl' marks slices whose acceptance criteria require human-only
           * actions — push access, observing live external workflows, third-
           * party UI interactions, downloading from a public release, etc.
           * An hitl slice MUST include a subDeliverable spec; a coder slice
           * MUST NOT. This is enforced by the superRefine below.
           */
          kind: z.enum(['coder', 'hitl']).default('coder'),
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
          // at persist time into the task_spec_files junction table so the
          // implementor brief stays one flat list.
          modifies: z.array(z.string()).default([]),
          creates: z.array(z.string()).default([]),
          verifyCmd: z.string().nullable().default(null),
          mergeMode: z.enum(['auto', 'gated']).default('auto'),
          /**
           * Present on hitl slices, absent on coder slices. Describes the
           * ONE Coder-dispatchable artifact (e.g. a verify script) a Coder
           * can build for the operator to run during the HITL step.
           */
          subDeliverable: subDeliverableSchema.optional(),
        })
        .superRefine((data, ctx) => {
          if (data.kind === 'hitl' && data.subDeliverable === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "hitl slices must include a subDeliverable spec (title, whatToBuild, acceptanceCriteria, optional files)",
              path: ['subDeliverable'],
            })
          }
          if (data.kind === 'coder' && data.subDeliverable !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "coder slices must not include a subDeliverable spec; only hitl slices carry one",
              path: ['subDeliverable'],
            })
          }
        }),
    )
    .min(1),
})

/**
 * Concatenate a slice's `modifies` + `creates` into the single flat
 * `files` list the queue persists into `task_spec_files`. The slicer
 * schema splits the two so the prompt can discipline path hallucination
 * separately for "edit this existing file" vs "create this new file";
 * downstream (the implementor brief, the spec.files array, the rest
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

export const buildSlicerPrompt = (
  proposal: {
    id: string
    title: string
    problem: string
    solution: string
    outOfScope: string
    notes: string
    userStories: string[]
  },
  resliceFeedback?: string,
): string => `Break this PRD into independently-grabbable issues using vertical
slices (tracer bullets). Each slice is a thin vertical tracer cutting
end-to-end through every layer. Prefer many thin slices over few thick ones.

HITL vs AFK
-----------
Slices may be 'HITL' or 'AFK'. HITL slices require human interaction
(architectural decision, design review). AFK slices can be implemented
and merged without human interaction. Prefer AFK over HITL where possible.

kind: routing hint ('coder' vs 'hitl')
---------------------------------------
Every slice carries a \`kind\` field (default: 'coder').
- 'coder' — the slice is dispatched to a Coder agent that can edit code
  autonomously. This is the default; use it for the vast majority of slices.
- 'hitl' — the slice requires a HUMAN OPERATOR to act. Emit kind='hitl'
  when the acceptance criteria include ANY of these human-only verbs:
    • push or deploy to a live environment or registry
    • observe or monitor a live external workflow or third-party system
    • interact with a third-party UI that the agent cannot access
    • download an artifact from a public release page or external service
    • copy or inject credentials/secrets that cannot be committed to source
    • run a visual regression test that requires a human eye to judge
    • approve or merge a pull request in an external hosted service

When you emit kind='hitl', you MUST also emit a subDeliverable spec.
The subDeliverable describes ONE Coder-dispatchable artifact (typically a
verify script) that a Coder agent will build so the operator has a runnable
tool for the HITL step. An hitl slice WITHOUT a subDeliverable is a schema
error. A coder slice MUST NOT carry a subDeliverable.

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

Size-aware slicing — split before emitting
------------------------------------------
Before emitting the final list, estimate each candidate slice's size
relative to ONE coder's context budget. Anchor the estimate on countable
proxies — files touched and distinct steps — not raw token counts, because
raw-token self-estimates are unreliable.

If a slice looks too large (too many files touched, too many distinct steps),
split it into two or more smaller slices BEFORE returning the list. When a
split produces dependent pieces, the dependent piece MUST list the slice it
builds on in \`blockedBy\` (1-based index into the same response).

IMPORTANT: The size estimate is internal reasoning only. It MUST NOT appear as a field
in the JSON output, MUST NOT be persisted, and MUST NOT be treated as a dispatch-time gate.
The existing watchdog kill plus single recovery remain the only back-stop.

Output shape
------------
For each slice, produce:
- title — a short descriptive name
- type — "HITL" or "AFK"
- kind — 'coder' (default) or 'hitl'. See the routing section above.
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
- mergeMode — "auto" for slices the implementor can drive end-to-end and
  commit, or "gated" for slices that need human verification before
  merge. Default "auto"; reach for "gated" only when a human must
  visually confirm an output the verifier cannot.
- subDeliverable — REQUIRED on hitl slices; FORBIDDEN on coder slices.
  Describes ONE Coder-dispatchable artifact (e.g. a verify script) that
  the operator will use during the HITL step. Carries:
    • title (string, min 1 char)
    • whatToBuild (string, min 1 char)
    • acceptanceCriteria (string[], min 1 item)
    • files (string[], optional) — paths the Coder will create/modify

Return ONLY a single JSON object matching exactly this shape, with no
surrounding prose, no code fences, and no commentary:

{"slices":[{"title":"...","type":"AFK","kind":"coder","whatToBuild":"...","acceptanceCriteria":["..."],"blockedBy":[],"readFirst":["src/foo.ts"],"prescriptiveAction":"In fooFn (foo.ts:42), change return type from string to number and update all call sites.","modifies":["src/foo.ts"],"creates":["src/foo.test.ts"],"verifyCmd":"cd src && npx vitest run foo.test.ts","mergeMode":"auto"}]}

PRD to decompose
================

Title: ${proposal.title}

Problem
-------
${proposal.problem || '(not specified)'}

Solution
--------
${proposal.solution || '(not specified)'}

User stories
------------
${renderUserStories(proposal.userStories)}

Out of scope
------------
${proposal.outOfScope || '(not specified)'}

Notes
-----
${proposal.notes || '(not specified)'}
${resliceFeedback ? `
Operator re-slice feedback
--------------------------
A prior slice plan was reviewed and rejected. Revise your output to address
the following feedback from the operator:

${resliceFeedback}
` : ''}`

const parseSlicerOutput = (stdout: string): z.infer<typeof slicerOutputSchema> =>
  slicerOutputSchema.parse(parseWorkerJsonResult(Workers.Slicer.config.provider, stdout))

// ---------------------------------------------------------------------------
// Action quality guard — regex anti-pattern detector
// ---------------------------------------------------------------------------

/**
 * Minimum number of whitespace-separated words a prescriptiveAction must
 * contain to be considered non-trivially specific.
 */
const MIN_ACTION_WORD_COUNT = 6

/**
 * Fluff phrases that, when present as standalone words/phrases, indicate the
 * action is too generic to be useful to a coder. Matched case-insensitively
 * with word-boundary anchors so "misalign" does not trip the "align" rule.
 */
const FLUFF_PATTERNS: ReadonlyArray<{ re: RegExp; phrase: string }> = [
  { re: /\bimplement\b/i, phrase: 'implement' },
  { re: /\bensure\b/i, phrase: 'ensure' },
  { re: /\bproperly\b/i, phrase: 'properly' },
  { re: /\bcorrectly\b/i, phrase: 'correctly' },
  { re: /\balign\b/i, phrase: 'align' },
  { re: /\bhandle the case\b/i, phrase: 'handle the case' },
  { re: /\bmake sure\b/i, phrase: 'make sure' },
  { re: /\bas needed\b/i, phrase: 'as needed' },
  { re: /\bwhere appropriate\b/i, phrase: 'where appropriate' },
]

/** Matches a file-path-shaped token: at least one slash surrounded by path
 *  segments (word chars, dashes, dots). */
const HAS_FILE_PATH = /\b[a-zA-Z][a-zA-Z0-9_\-.]*(?:\/[a-zA-Z0-9_\-.]+)+/

/** Matches the opening of a backtick-quoted identifier or path. */
const HAS_BACKTICK_IDENT = /`[a-zA-Z_$./][a-zA-Z0-9_$./]*/

/**
 * Inspect a slice's prescriptiveAction for vague-prose anti-patterns.
 * Returns a human-readable description of the first violation found, or
 * `null` when the action looks concrete enough.
 *
 * Checks (in order):
 * 1. Word count below the minimum threshold.
 * 2. Presence of a fluff word/phrase as a standalone token.
 * 3. Absence of both a file-path-shaped token and a backtick-quoted identifier.
 *
 * Exported for unit testing.
 */
export const detectActionAntiPattern = (action: string): string | null => {
  const wordCount = action.trim().split(/\s+/).length
  if (wordCount < MIN_ACTION_WORD_COUNT) {
    return `action is too short (${wordCount} word${wordCount === 1 ? '' : 's'}; minimum is ${MIN_ACTION_WORD_COUNT})`
  }
  for (const { re, phrase } of FLUFF_PATTERNS) {
    if (re.test(action)) {
      return `contains vague phrase "${phrase}"`
    }
  }
  if (!HAS_FILE_PATH.test(action) && !HAS_BACKTICK_IDENT.test(action)) {
    return 'missing a concrete anchor: no file path or backtick-quoted identifier found'
  }
  return null
}

/**
 * Build the re-prompt sent to the Slicer worker when a single slice's
 * prescriptiveAction trips the anti-pattern detector. The anti-pattern
 * description is embedded verbatim so the model can target the rewrite.
 */
const buildActionRepromptPrompt = (
  sliceTitle: string,
  currentAction: string,
  antiPattern: string,
): string =>
  `The prescriptiveAction for slice "${sliceTitle}" was flagged as too vague.

Anti-pattern: ${antiPattern}

Current prescriptiveAction:
${currentAction}

Rewrite ONLY the prescriptiveAction to be concrete and code-level specific:
- Name at least one file path (e.g. src/foo/bar.ts) or backtick-quoted identifier (\`symbolName\`)
- Name the specific function, type, variable, SQL column, or line range to change
- Use exact values — not vague directives like "implement", "ensure", "properly", or "correctly"
- Minimum ${MIN_ACTION_WORD_COUNT} words

Return only valid JSON: {"prescriptiveAction": "<rewritten action here>"}`

/** Schema used to parse the slicer's response to an action re-prompt. */
const actionRepromptSchema = z.object({ prescriptiveAction: z.string().min(1) })

/**
 * For each slice whose prescriptiveAction trips the anti-pattern detector,
 * call `reprompt` exactly once with the slice and the named anti-pattern.
 * If the reprompt returns a concrete rewrite (passes the detector), the
 * slice is updated in place. If the reprompt returns null or still-vague
 * prose, the original action is kept and the pipeline continues unchanged.
 *
 * Exported so tests can inject a mock reprompt function without spawning a
 * real Claude worker.
 */
export const applyActionQualityGuard = async (
  slices: Array<{ title: string; prescriptiveAction: string }>,
  reprompt: (
    slice: { title: string; prescriptiveAction: string },
    antiPattern: string,
  ) => Promise<string | null>,
): Promise<void> => {
  for (const slice of slices) {
    const antiPattern = detectActionAntiPattern(slice.prescriptiveAction)
    if (antiPattern === null) continue

    // Pass a snapshot (shallow copy) so the spy / caller never sees the
    // post-mutation state of the slice object.
    const rewritten = await reprompt({ ...slice }, antiPattern).catch(() => null)
    if (rewritten === null) continue

    // Only swap if the rewrite itself passes the detector.
    if (detectActionAntiPattern(rewritten) === null) {
      slice.prescriptiveAction = rewritten
    }
  }
}

// ---------------------------------------------------------------------------

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
 * drop — e.g. `legacy_data_col`. Identifiers without an underscore are
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
 * Extract camelCase and snake_case identifiers from text for general-purpose
 * closeness computation. Extends extractSchemaIdentifiers (which only covers
 * snake_case) to also include camelCase symbols specific enough to signal
 * meaningful overlap between slices.
 *
 * Single-segment bare words (no underscore, no embedded uppercase after the
 * first char) are excluded — same 'too-generic bare word' guard as
 * extractSchemaIdentifiers.
 */
const extractGeneralIdentifiers = (text: string): string[] => {
  const snakeCase = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []
  // camelCase: starts lowercase, has an uppercase letter in the interior,
  // length ≥ 4 to avoid trivial acronyms ("getId" → fine, "id" → excluded).
  const camelCase = [
    ...(text.match(/\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? []),
  ].filter((id) => id.length >= 4)
  return Array.from(new Set([...snakeCase, ...camelCase]))
}

/**
 * True when slices a and b share at least one specific identifier (snake_case
 * or camelCase ≥ 4 chars) across their title + whatToBuild +
 * prescriptiveAction text, or share at least one file path in their
 * modifies/creates arrays.
 *
 * Both signals must be non-trivial: single bare lowercase words are excluded
 * by extractGeneralIdentifiers, and the shared-file check requires an exact
 * path match.
 */
const isCloseEnough = (
  a: {
    title: string
    whatToBuild: string
    prescriptiveAction?: string
    modifies?: string[]
    creates?: string[]
  },
  b: {
    title: string
    whatToBuild: string
    prescriptiveAction?: string
    modifies?: string[]
    creates?: string[]
  },
): boolean => {
  const filesA = new Set([...(a.modifies ?? []), ...(a.creates ?? [])])
  for (const f of [...(b.modifies ?? []), ...(b.creates ?? [])]) {
    if (filesA.has(f)) return true
  }
  const textA = [a.title, a.whatToBuild, a.prescriptiveAction ?? ''].join('\n')
  const textB = [b.title, b.whatToBuild, b.prescriptiveAction ?? ''].join('\n')
  const identsA = new Set(extractGeneralIdentifiers(textA))
  for (const id of extractGeneralIdentifiers(textB)) {
    if (identsA.has(id)) return true
  }
  return false
}

/**
 * Returns true if adding the edge (depender depends on blocker) to the current
 * blockedBy graph would create a cycle.
 *
 * A cycle exists iff blocker can already reach depender through existing
 * blockedBy edges (i.e. blocker transitively waits on depender). The DFS is
 * bounded to the slice count and always terminates.
 */
const wouldCreateCycle = (
  slices: readonly { blockedBy: number[] }[],
  dependerIdx: number,
  blockerOneBased: number,
): boolean => {
  const blockerIdx = blockerOneBased - 1
  const visited = new Set<number>()
  const stack = [blockerIdx]
  while (stack.length > 0) {
    const curr = stack.pop()!
    if (curr === dependerIdx) return true
    if (visited.has(curr)) continue
    visited.add(curr)
    for (const dep of slices[curr].blockedBy) {
      stack.push(dep - 1)
    }
  }
  return false
}

/**
 * The verdict returned by the direction judge for a close pair (a, b).
 * When hasDependency is true, aBlocksB indicates direction: true means a must
 * complete before b; false means b must complete before a.
 */
export type DirectionVerdict =
  | { hasDependency: false }
  | { hasDependency: true; aBlocksB: boolean }

/**
 * Provenance of an injected blocker edge: determined mechanically from
 * declared file overlap ('file-overlap') or by the auto-linker LLM direction
 * judge ('inferred'). Persisted in task_blockers so the operator can see why
 * an edge exists.
 */
export type EdgeProvenance = 'file-overlap' | 'inferred'

/**
 * A single blocker edge injected by the auto-linker, tagged with its
 * provenance. dependerIdx is the 0-based index of the slice that waits;
 * blockerOneBased is the 1-based index of its blocker.
 */
export type InjectedEdge = {
  dependerIdx: number
  blockerOneBased: number
  provenance: EdgeProvenance
}

/**
 * An inferred edge that was dropped by the cycle guard because adding it
 * would have created a cycle. Mechanical (file-overlap) edges are never
 * dropped — only inferred edges can be removed to break cycles.
 */
export type DroppedCycleEdge = {
  dependerIdx: number
  blockerOneBased: number
}

/**
 * Return value of injectAutoLinkerBlockers: the list of edges injected and
 * the list of inferred edges dropped by the cycle guard.
 */
export type AutoLinkerResult = {
  /** Edges successfully injected, tagged with their provenance. */
  injected: InjectedEdge[]
  /**
   * Inferred (LLM-proposed) edges that were dropped because they would have
   * created a cycle in the dependency graph. Mechanical edges are never
   * dropped. Callers should log these for traceability.
   */
  droppedCycles: DroppedCycleEdge[]
}

const directionVerdictSchema = z.union([
  z.object({ hasDependency: z.literal(false) }),
  z.object({ hasDependency: z.literal(true), aBlocksB: z.boolean() }),
])

const buildDirectionJudgementPrompt = (
  a: { title: string; whatToBuild: string; prescriptiveAction?: string },
  b: { title: string; whatToBuild: string; prescriptiveAction?: string },
): string =>
  `You are reviewing two implementation slices from the same project.
Determine whether one slice MUST complete before the other can safely start.

SLICE A:
Title: ${a.title}
What to build: ${a.whatToBuild}${a.prescriptiveAction ? `\nAction: ${a.prescriptiveAction}` : ''}

SLICE B:
Title: ${b.title}
What to build: ${b.whatToBuild}${b.prescriptiveAction ? `\nAction: ${b.prescriptiveAction}` : ''}

Answer in valid JSON only — no prose, no markdown:
- A must finish before B starts → {"hasDependency": true, "aBlocksB": true}
- B must finish before A starts → {"hasDependency": true, "aBlocksB": false}
- No ordering constraint → {"hasDependency": false}`

/**
 * Three-stage auto-linker: inject blockedBy edges the slicer LLM forgot.
 * Returns the injected edges with provenance and any inferred edges dropped
 * by the cycle guard (callers should log droppedCycles for traceability).
 *
 * Stage 1 — Schema-drop fast path (no LLM needed, direction is certain):
 *   Any slice whose title/whatToBuild matches SCHEMA_DROP_PATTERNS is
 *   automatically blocked on every consumer slice in the same PRD that
 *   shares a snake_case identifier with the dropped entity. This is the
 *   behaviour of the former injectSchemaDropBlockers (motivation: PRD
 *   1b7498f6-remove-all-usd-cost-usd-mentions-from-th).
 *
 * Stage 1.5 — File-overlap mechanical edges (no LLM, direction deterministic):
 *   Any two non-schema-drop slices sharing ≥1 declared file (modifies ∪
 *   creates) get a forced sequential edge. Direction is always earlier
 *   (lower proposal index) blocks later — deterministic, no LLM. These
 *   edges are tagged 'file-overlap' so the operator can see why they exist.
 *
 * Stage 2 — General heuristic + LLM direction:
 *   For every pair not already handled by Stage 1 or Stage 1.5, compute
 *   textual closeness. Close pairs proceed to the injected judgeDirection
 *   callback; only pairs the callback labels as dependent get an edge, in
 *   the direction the callback specifies. File-overlap pairs are excluded
 *   from Stage 2 — mechanical edge wins; an LLM edge for such a pair
 *   would be redundant or conflict, and is never requested.
 *
 * Invariants:
 *   - Idempotent: merges into existing blockedBy via a Set.
 *   - Acyclic: cycle check before every inferred edge insertion. Inferred
 *     edges that would create a cycle are DROPPED (never mechanical edges);
 *     dropped edges are returned in result.droppedCycles for logging.
 *   - Drop↔drop pairs skipped in Stage 1 (avoids multi-column-drop cycles).
 *   - Schema-drop pairs excluded from Stages 1.5 and 2.
 *   - File-overlap pairs excluded from Stage 2 (mechanical wins).
 *   - judgeDirection errors / 'no dependency' verdicts leave the graph unchanged.
 *
 * Mutates `slices` in place; exported for unit testing.
 */
export const injectAutoLinkerBlockers = async (
  slices: Array<{
    title: string
    whatToBuild: string
    prescriptiveAction?: string
    modifies?: string[]
    creates?: string[]
    blockedBy: number[]
  }>,
  judgeDirection: (
    a: { title: string; whatToBuild: string; prescriptiveAction?: string },
    b: { title: string; whatToBuild: string; prescriptiveAction?: string },
  ) => Promise<DirectionVerdict>,
): Promise<AutoLinkerResult> => {
  const injected: InjectedEdge[] = []
  const droppedCycles: DroppedCycleEdge[] = []

  // ── Stage 1: Schema-drop fast path ──────────────────────────────────────
  const schemaDropIndices: number[] = []
  for (let i = 0; i < slices.length; i += 1) {
    if (isSchemaDropSlice(slices[i])) schemaDropIndices.push(i)
  }
  const schemaDropSet = new Set(schemaDropIndices)

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
      // blocker (an inverted slicer ordering), don't add the reverse edge.
      if (cand.blockedBy.includes(dropOneBased)) continue
      // Textual link: candidate must mention at least one snake_case
      // identifier the drop names.
      if (!idents.some((ident) => sliceMentions(cand, ident))) continue
      merged.add(j + 1)
    }
    drop.blockedBy = Array.from(merged).sort((a, b) => a - b)
  }

  // ── Stage 1.5: File-overlap mechanical edges ─────────────────────────────
  // Any two non-schema-drop slices that share ≥1 declared file (modifies ∪
  // creates) get a forced sequential edge. Direction is deterministic:
  // earlier in proposal order (lower index) blocks later (higher index).
  // No LLM involvement — this is a mechanical, non-overridable constraint.
  // Schema-drop pairs are excluded: Stage 1 already handles those with
  // domain-specific direction logic.
  const fileOverlapPairSet = new Set<string>() // keys: "${i}:${j}" with i < j
  for (let i = 0; i < slices.length; i += 1) {
    if (schemaDropSet.has(i)) continue
    const filesI = new Set([...(slices[i].modifies ?? []), ...(slices[i].creates ?? [])])
    if (filesI.size === 0) continue
    for (let j = i + 1; j < slices.length; j += 1) {
      if (schemaDropSet.has(j)) continue
      const filesJ = [...(slices[j].modifies ?? []), ...(slices[j].creates ?? [])]
      if (!filesJ.some((f) => filesI.has(f))) continue

      fileOverlapPairSet.add(`${i}:${j}`)
      // Earlier (i) blocks later (j). i < j guarantees a forward-only edge
      // that cannot form a cycle among mechanical edges themselves.
      const blockerOneBased = i + 1
      const depender = slices[j]
      const merged = new Set<number>(depender.blockedBy)
      if (!merged.has(blockerOneBased)) {
        merged.add(blockerOneBased)
        depender.blockedBy = Array.from(merged).sort((a, b) => a - b)
        injected.push({ dependerIdx: j, blockerOneBased, provenance: 'file-overlap' })
      }
    }
  }

  // ── Stage 2: General heuristic + LLM direction ──────────────────────────
  // File-overlap pairs are excluded — mechanical edge already covers them,
  // and the LLM would either add a redundant or a conflicting edge. Cycle
  // guard drops inferred edges (never mechanical ones) and records them in
  // droppedCycles so the caller can log the decision for traceability.
  for (let i = 0; i < slices.length; i += 1) {
    for (let j = i + 1; j < slices.length; j += 1) {
      // Pairs involving schema-drop slices were resolved in Stage 1.
      if (schemaDropSet.has(i) || schemaDropSet.has(j)) continue
      // File-overlap pairs were resolved mechanically in Stage 1.5.
      // Mechanical edge wins — LLM is not consulted for these pairs.
      if (fileOverlapPairSet.has(`${i}:${j}`)) continue

      // Closeness check — skip pairs without a meaningful textual link.
      if (!isCloseEnough(slices[i], slices[j])) continue

      // LLM direction judgement.
      const verdict = await judgeDirection(slices[i], slices[j])
      if (!verdict.hasDependency) continue

      const blockerIdx = verdict.aBlocksB ? i : j
      const dependerIdx = verdict.aBlocksB ? j : i
      const blockerOneBased = blockerIdx + 1

      // Cycle guard: inferred edges are dropped (never mechanical edges)
      // if they would create a cycle. Record the drop for traceability.
      if (wouldCreateCycle(slices, dependerIdx, blockerOneBased)) {
        droppedCycles.push({ dependerIdx, blockerOneBased })
        continue
      }

      const depender = slices[dependerIdx]
      const merged = new Set<number>(depender.blockedBy)
      merged.add(blockerOneBased)
      depender.blockedBy = Array.from(merged).sort((a, b) => a - b)
      injected.push({ dependerIdx, blockerOneBased, provenance: 'inferred' })
    }
  }

  return { injected, droppedCycles }
}

/**
 * For each slice, validate that every backtick-cited symbol and every
 * `readFirst` path exists in the repo. When unresolved references are found,
 * append a fenced "Spec-vs-reality caveat" block to `prescriptiveAction` and
 * strip the missing paths from `readFirst` (retaining the last missing path
 * as a fallback when removal would violate the `.min(1)` constraint).
 *
 * The `onAnnotated` callback is invoked once per annotated slice so callers
 * can emit telemetry or trace records without coupling this helper to any
 * particular store.
 *
 * Exported for unit testing.
 */
export function annotateUnresolvedReferences(
  slices: SliceSpec[],
  repoRoot: string,
  onAnnotated: (evt: {
    sliceTitle: string
    missingSymbols: string[]
    missingReadFirstPaths: string[]
  }) => void,
): void {
  for (const slice of slices) {
    const { missingSymbols, missingReadFirstPaths } = validateSliceReferences(slice, repoRoot)
    if (missingSymbols.length === 0 && missingReadFirstPaths.length === 0) continue

    // Filter missing paths from readFirst, retaining one fallback if needed.
    let filteredReadFirst = slice.readFirst.filter((p) => !missingReadFirstPaths.includes(p))
    let retainedFallback: string | null = null
    if (filteredReadFirst.length === 0 && missingReadFirstPaths.length > 0) {
      retainedFallback = missingReadFirstPaths[missingReadFirstPaths.length - 1]
      filteredReadFirst = [retainedFallback]
    }
    slice.readFirst = filteredReadFirst

    // Build caveat text.
    const caveats: string[] = [
      '',
      'Spec-vs-reality caveat: the following references could not be resolved in the current tree at slicing time — verify or replace before implementing.',
    ]
    if (missingSymbols.length > 0) {
      caveats.push(`Unresolved symbols: ${missingSymbols.join(', ')}`)
    }
    if (missingReadFirstPaths.length > 0) {
      if (retainedFallback !== null) {
        const displayPaths = missingReadFirstPaths
          .map((p) => (p === retainedFallback ? `${p} (retained as fallback)` : p))
          .join(', ')
        caveats.push(`Missing read-first paths: ${displayPaths}`)
      } else {
        caveats.push(`Missing read-first paths: ${missingReadFirstPaths.join(', ')}`)
      }
    }

    slice.prescriptiveAction += caveats.join('\n')

    onAnnotated({
      sliceTitle: slice.title,
      missingSymbols,
      missingReadFirstPaths,
    })
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
  proposal: {
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

  const rawGoal = (proposal.solution || proposal.title).trim()
  const goal = truncateAtWord(rawGoal, DIGEST_GOAL_CHARS)

  const blockers =
    slice.blockedBy.length === 0
      ? '(none)'
      : `slices ${slice.blockedBy.join(', ')} in this PRD`

  const rawNonGoals = (proposal.outOfScope || '').trim()
  const nonGoals = rawNonGoals
    ? truncateAtWord(rawNonGoals, DIGEST_NON_GOALS_CHARS)
    : '(none)'

  return `# ${slice.title}

Slice ${index} of ${total} for PRD ${proposal.id}: ${proposal.title}
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

type SliceInput = z.infer<typeof sliceInputSchema>
type SliceOutput = z.infer<typeof sliceOutputSchema>

// The slice workflow talks to proposals/queue via injected services; the
// daemon wires the DomainTaskStore and TraceEventStore from the composition
// root, read inside as `ctx.services.store` and `ctx.services.traceStore`.
// One imperative step ('generate-slices', load-bearing as the trace-view
// node label). Failures THROW; the engine records the step failed.
export interface SliceServices {
  store: DomainTaskStore
  traceStore: TraceEventStore
}

export const sliceWorkflow = defineWorkflow<SliceInput, SliceOutput, SliceServices>({
  id: 'slice',
  inputSchema: sliceInputSchema,
  fn: async (ctx: WorkflowCtx<SliceServices>, input: SliceInput): Promise<SliceOutput> =>
    ctx.step('generate-slices', async (): Promise<SliceOutput> => {
    const inputData = input
    const proposal = await getProposal(inputData.proposalId)
    if (!proposal) throw new Error(`proposal ${inputData.proposalId} not found`)
    // Atomic claim — flip 'prd-ready' to 'slicing' in a single conditional
    // UPDATE so a second concurrent runSlice (e.g. promote auto-slice racing
    // a direct `mars proposal slice` RPC, or a daemon restart re-exposing
    // the same prd-ready proposal) sees zero rows affected and aborts before
    // generating a duplicate slice-set. The read-only `proposal.status`
    // check this replaces was a TOCTOU race: both callers used to read
    // 'prd-ready' and both ran the slicer.
    const claimed = await claimProposalForSlicing(inputData.proposalId)
    if (!claimed) {
      const current = await getProposal(inputData.proposalId)
      throw new Error(
        `proposal ${proposal.id} is not claimable for slicing (status='${current?.status ?? 'missing'}'; already slicing or sliced)`,
      )
    }
    // From this point on, every failure path must revert the claim
    // ('slicing' -> 'prd-ready') so the daemon's auto-slice loop and a
    // direct `mars proposal slice` can re-attempt. The outer try/catch
    // below is that compensating revert; it is a superset of the existing
    // inner cleanup, which targets the post-Phase-4 'sliced' -> 'prd-ready'
    // window specifically.
    try {
      const traceStore = ctx.services.traceStore
    let slicedTaskCount = 0
    const r = await runWorkerWithSpan({
      worker: Workers.Slicer,
      prompt: buildSlicerPrompt(proposal, inputData.resliceFeedback),
      runOptions: { cwd: getRepoRoot() },
      traceStore,
      stepName: 'generate-slices',
      workflowInstanceId: ctx.runId,
      originId: inputData.proposalId,
      taskId: null,
      getExtraPayload: () => ({ slicedTaskCount }),
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `provider worker exited ${r.exitCode}: ${diagnoseClaudeFailure(r.stdout, r.stderr)}`,
      )
    }

    const parsed = parseSlicerOutput(r.stdout)
    // Repair: the slicer LLM routinely forgets to wire dependency edges
    // between related slices. Stage 1 handles schema-drop ↔ consumer edges
    // deterministically; Stage 1.5 handles file-overlap pairs mechanically
    // (earlier slice blocks later — no LLM); Stage 2 uses textual closeness +
    // LLM direction for remaining pairs not already covered by Stage 1 or 1.5.
    // Both stages are non-fatal — errors and 'no dependency' verdicts leave the
    // graph unchanged. Injected indices are always in range so the validation
    // loop below still passes.
    const autoLinkerResult = await injectAutoLinkerBlockers(parsed.slices, async (a, b) => {
      const rr = await runWorkerWithSpan({
        worker: Workers.Slicer,
        prompt: buildDirectionJudgementPrompt(a, b),
        runOptions: { cwd: getRepoRoot() },
        traceStore,
        stepName: 'auto-linker-direction',
        workflowInstanceId: ctx.runId,
        originId: inputData.proposalId,
        taskId: null,
      }).catch(() => null)
      if (!rr || rr.exitCode !== 0) return { hasDependency: false }
      try {
        return directionVerdictSchema.parse(
          parseWorkerJsonResult(Workers.Slicer.config.provider, rr.stdout),
        )
      } catch {
        return { hasDependency: false }
      }
    })
    // Log any inferred edges dropped by the cycle guard to the trace so the
    // operator can see what was trimmed and why. Best-effort — a trace
    // failure must not block the slice workflow.
    if (autoLinkerResult.droppedCycles.length > 0 && traceStore) {
      await traceStore
        .record({
          kind: 'log_line',
          taskId: null,
          originId: inputData.proposalId,
          phase: null,
          payload: {
            level: 'warn',
            source: 'auto-linker',
            msg: `Dropped ${autoLinkerResult.droppedCycles.length} inferred edge(s) to prevent cycles`,
            droppedCycles: autoLinkerResult.droppedCycles,
          },
        })
        .catch(() => {})
    }
    // Build a provenance map for Phase 2 so each persisted task_blockers row
    // carries the right 'file-overlap' | 'inferred' tag.
    const edgeProvenanceMap = new Map<string, EdgeProvenance>()
    for (const edge of autoLinkerResult.injected) {
      edgeProvenanceMap.set(`${edge.dependerIdx}:${edge.blockerOneBased}`, edge.provenance)
    }
    // Pre-flight drop: remove any slice whose creates files already exist
    // on disk and already export every backtick-declared symbol. Blocker
    // edges pointing at dropped slices are removed from surviving slices.
    const preDropCount = parsed.slices.length
    parsed.slices = dropAlreadySatisfiedSlices(parsed.slices, getRepoRoot())
    const droppedCount = preDropCount - parsed.slices.length
    const total = parsed.slices.length
    slicedTaskCount = total

    // Action quality guard: for each slice whose prescriptiveAction is vague,
    // re-prompt the slicer exactly once naming the specific anti-pattern.
    // Non-fatal: errors in the reprompt are swallowed and the original action
    // is kept so the pipeline never blocks on a quality issue.
    await applyActionQualityGuard(parsed.slices, async (slice, antiPattern) => {
      const rr = await runWorkerWithSpan({
        worker: Workers.Slicer,
        prompt: buildActionRepromptPrompt(
          slice.title,
          slice.prescriptiveAction,
          antiPattern,
        ),
        runOptions: { cwd: getRepoRoot() },
        traceStore,
        stepName: 'action-quality-reprompt',
        workflowInstanceId: ctx.runId,
        originId: inputData.proposalId,
        taskId: null,
      }).catch(() => null)
      if (!rr || rr.exitCode !== 0) return null
      try {
        return actionRepromptSchema.parse(
          parseWorkerJsonResult(Workers.Slicer.config.provider, rr.stdout),
        )
          .prescriptiveAction
      } catch {
        return null
      }
    })

    // Reference validation: annotate slices whose symbols/paths don't resolve.
    annotateUnresolvedReferences(parsed.slices, getRepoRoot(), (evt) => {
      void traceStore
        ?.record({
          kind: 'log_line',
          taskId: null,
          originId: inputData.proposalId,
          phase: null,
          payload: {
            level: 'warn',
            source: 'reference-validator',
            msg: 'Slice cites unresolved references',
            sliceTitle: evt.sliceTitle,
            missingSymbols: evt.missingSymbols,
            missingReadFirstPaths: evt.missingReadFirstPaths,
          },
        })
        .catch(() => {})
    })

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

    const taskStore = ctx.services.store
    const stateStore = await getDefaultStateStore()

    // Pre-flight: crash-recovery deduplication. A process crash between
    // Phase 1 (task inserts) and Phase 4 (status flip) leaves the proposal
    // prd-ready with orphaned tasks in the queue. Without this cleanup,
    // a retry would insert a fresh set of tasks on top of the orphans,
    // creating duplicates. Delete any tasks that claim this proposal as
    // parent before starting Phase 1 so retries are idempotent. The
    // bulk-delete emits task.dropped + task.terminal{purged} into the outbox
    // in the SAME transaction as the row removal so the Invalidator
    // (ADR-0030) can still resolve each taskId and clear any open
    // action-queue rows after the row is gone.
    // Relocated to the Arc aggregate (ADR-0052 sole-writer): the lifecycle
    // event emit + row deletion now live in Arc.dropProposalSlices. The
    // best-effort .catch() wrapping stays here at the call site, covering both
    // the orphan SELECT and the atomic delete.
    await Arc.dropProposalSlices(
      taskStore,
      proposal.id,
      'slicer-preflight',
    ).catch(() => {})

    // Inform the operator when the pre-flight dropped at least one slice.
    // Non-fatal: a failure here must not prevent the surviving slices from
    // dispatching. Created before Phase 1 so the operator can intercept
    // before any tasks are queued.
    if (droppedCount > 0) {
      await raiseActionQueueItem({
        kind: 'slices-dropped',
        category: 'orchestrator',
        priority: 'normal',
        title: `Slicer pre-flight: ${droppedCount} slice${droppedCount === 1 ? '' : 's'} already satisfied for PRD ${proposal.id}`,
        body: `PRD ${proposal.id} (${proposal.title}): ${droppedCount} slice${droppedCount === 1 ? ' was' : 's were'} dropped as already satisfied on main. The remaining ${total} survivor${total === 1 ? '' : 's'} will dispatch normally.`,
        payload: { proposalId: proposal.id, droppedCount, survivorCount: total },
        context: {},
        raisedBy: 'slicer',
        signature: proposal.id,
        // Keyed to proposal.id so the existing proposal-evict path in
        // action-queue-repopulator (proposal.promoted/dismissed/deleted →
        // supersedeActionQueueItemsForOrigin) closes this row automatically
        // when the PRD reaches a terminal state.
        originTaskId: proposal.id,
      }).catch(() => {})
    }

    const taskIds: string[] = []
    // Coder sub-tasks enqueued for hitl slices (one per hitl slice, in
    // the same order as the hitl slices appear in taskIds). Tracked
    // separately so markProposalSliced receives the true slice count and
    // the catch block can clean them up alongside the slice tasks.
    const subTaskIds: string[] = []
    const queuedTaskIds: string[] = []
    const blockedTaskIds: string[] = []
    // Parallel arrays that map hitl slice positions to their sub-tasks.
    // hitlSliceIndices[j] is the 0-based index in parsed.slices/taskIds;
    // subTaskIds[j] is the id of the Coder sub-task for that slice.
    const hitlSliceIndices: number[] = []
    // Tracks whether Phase 4 successfully flipped the proposal row to 'sliced'.
    // The catch block uses this to compensate (revert to 'prd-ready') when
    // a failure after the flip would otherwise strand the proposal as 'sliced'
    // with no surviving tasks — wedging it permanently, since the
    // precondition above refuses to re-slice anything that is not
    // 'prd-ready' and the daemon's auto-slice loop only picks up
    // 'prd-ready' proposals.
    let proposalFlipped = false

    // The writes span two domain seams (tasks/blockers and proposals) within
    // the same Mars database. We use separate transactions for each domain
    // (a historical SQLite-era constraint kept deliberately: folding both
    // domains into one PG transaction is possible now, but changes crash-
    // recovery semantics and is deferred as an intentional design pass). We
    // do best-effort with cleanup on error: if anything fails after task
    // inserts begin, delete the inserted slice tasks AND revert the
    // proposal's status back to 'prd-ready' if we already flipped it, before
    // re-throwing — so a failed slice is fully undone and the proposal is
    // re-sliceable.
    try {
      // Phase 1: coordinated proposals get one owner task; sibling proposals
      // insert each slice as a draft task carrying parent_proposal_id and
      // slice_index. We transition status in Phase 3.
      if (proposal.coordinated) {
        const task = await enqueueTask(
          `Coordinator for PRD ${proposal.id}: ${proposal.title}`,
          undefined,
          {
            author: proposal.author ?? undefined,
            originId: proposal.id,
            parentProposalId: proposal.id,
            intent: `Coordinator: ${proposal.title}`.slice(0, 200),
            ...(input.priority !== undefined && { priority: input.priority }),
            spec: {
              files: [],
              verifyCmd: null,
              previewCmd: null,
              doneCriteria: [],
              mergeMode: 'auto',
              executionMode: 'coordinated',
              slicePlan: parsed.slices,
            },
          },
        )
        taskIds.push(task.id)
      } else {
        for (let i = 0; i < total; i += 1) {
          const slice = parsed.slices[i]
          const prompt = composeTaskPrompt(proposal, slice, i + 1, total)
          const verifyCmd =
            slice.verifyCmd !== null && slice.verifyCmd.trim().length > 0
              ? slice.verifyCmd
              : null
          const files = sliceFilesForPersistence(slice)
          const task = await enqueueTask(prompt, undefined, {
            author: proposal.author ?? undefined,
            originId: proposal.id,
            parentProposalId: proposal.id,
            sliceIndex: i + 1,
            intent: (slice.title.trim() || slice.whatToBuild.split(/[.!?\n]/)[0].trim()).slice(0, 200),
            ...(input.priority !== undefined && { priority: input.priority }),
            spec: {
              files,
              verifyCmd,
              doneCriteria: slice.acceptanceCriteria,
              mergeMode: slice.mergeMode,
              sliceKind: slice.kind,
              subDeliverable: slice.subDeliverable,
            },
          })
          taskIds.push(task.id)

          // HITL routing: for hitl slices, enqueue a Coder sub-task built
          // from the slice's subDeliverable spec, then raise an operator
          // actionQueue item so the human knows what to act on. The hitl slice
          // task itself is never dispatched to a Coder (Phase 3 always
          // marks it 'blocked'; Phase 2b wires it to wait on the sub-task).
          if (slice.kind === 'hitl' && slice.subDeliverable !== undefined) {
            const sub = slice.subDeliverable
            const subCriteria = sub.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
            const subFilesSection =
              sub.files && sub.files.length > 0
                ? `\n## Files\n\n${sub.files.map((f) => `- ${f}`).join('\n')}\n`
                : ''
            const subPrompt =
              `# ${sub.title}\n\n` +
              `Sub-task for HITL slice "${slice.title}" (PRD ${proposal.id}: ${proposal.title}).\n\n` +
              `## What to build\n\n${sub.whatToBuild}\n\n` +
              `## Acceptance criteria\n\n${subCriteria}\n` +
              subFilesSection

            const subTask = await enqueueTask(subPrompt, undefined, {
              author: proposal.author ?? undefined,
              originId: proposal.id,
              parentProposalId: proposal.id,
              intent: sub.title.slice(0, 200),
              ...(input.priority !== undefined && { priority: input.priority }),
              spec: {
                files: sub.files ?? [],
                verifyCmd: null,
                doneCriteria: sub.acceptanceCriteria,
                mergeMode: 'auto',
                sliceKind: 'coder',
              },
            })
            subTaskIds.push(subTask.id)
            hitlSliceIndices.push(i)

            const checklist = slice.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
            await raiseActionQueueItem({
              kind: 'hitl-slice-needs-operator',
              category: 'orchestrator',
              priority: 'normal',
              title: `HITL: ${slice.title}`,
              body:
                `**HITL slice:** ${slice.title}\n\n` +
                `## Manual checklist\n\n${checklist}\n\n` +
                `## Operator tooling\n\n` +
                `Sub-task \`${subTask.id}\` will deliver the artifact for this HITL step. ` +
                `Once it completes, run the artifact to confirm the step.\n`,
              payload: {
                proposalId: proposal.id,
                sliceIndex: i + 1,
                subTaskId: subTask.id,
              },
              context: {},
              raisedBy: 'slicer',
              signature: `${proposal.id}:hitl:${i + 1}`,
            })
          }
        }
      }
      // Phase 2: a coordinator owns dependency sequencing internally. Sibling
      // proposals wire blockers using the resolved task ids. Routes through the
      // Arc aggregate (ADR-0052 sole-writer for task_blockers); Arc.addBlocker
      // carries the ADR-0040 leaf-node guard internally. The provenance map
      // from the auto-linker determines whether each edge is 'file-overlap'
      // (mechanical, forced by shared declared files) or 'inferred' (from
      // the slicer LLM or the auto-linker direction judge).
      if (!proposal.coordinated) {
        for (let i = 0; i < total; i += 1) {
          const deps = parsed.slices[i].blockedBy
          for (const dep of deps) {
            const provenance = edgeProvenanceMap.get(`${i}:${dep}`) ?? 'inferred'
            await Arc.load(taskIds[i], taskStore).addBlocker(
              taskIds[i],
              [taskIds[dep - 1]],
              { provenance },
            )
          }
        }
      }
      // Phase 2b: wire each hitl slice task to block on its Coder sub-task.
      // The hitl slice is never dispatched until the sub-task completes and
      // the operator confirms the manual step. hitlSliceIndices[j] is the
      // 0-based position in taskIds; subTaskIds[j] is the sub-task id.
      for (let j = 0; j < hitlSliceIndices.length; j += 1) {
        await Arc.load(taskIds[hitlSliceIndices[j]], taskStore).addBlocker(
          taskIds[hitlSliceIndices[j]],
          [subTaskIds[j]],
        )
      }
      // Phase 3: sliced work dispatches immediately. Keep the lifecycle gate
      // in updateTask: HITL slices and slices with unresolved blockers remain
      // blocked; every other slice (including Coder sub-tasks) is queued.
      const draftTasks = await taskStore.query({
        sql: `SELECT id, slice_kind FROM tasks WHERE parent_proposal_id = ? AND status = 'draft'`,
        args: [proposal.id],
      })
      for (const row of draftTasks.rows) {
        const task = row as unknown as { id: string; slice_kind: string | null }
        const blockers = await taskStore.query({
          sql: `SELECT 1 FROM task_blockers WHERE task_id = ? LIMIT 1`,
          args: [task.id],
        })
        const status = task.slice_kind === 'hitl' || blockers.rows.length > 0 ? 'blocked' : 'queued'
        await updateTask(task.id, { status }, taskStore)
        if (status === 'queued') queuedTaskIds.push(task.id)
        else blockedTaskIds.push(task.id)
      }
      // Defensive: never mark a proposal 'sliced' with zero tasks. The
      // slicerOutputSchema already enforces `slices.min(1)` and Phase 1
      // pushes every successfully-enqueued task into `taskIds`, so this
      // branch only fires if some upstream path silently committed an
      // empty parse result. Throwing here lets the catch block revert
      // any partial state and surface the bug instead of stranding the
      // proposal as 'sliced' with no work to do.
      if (taskIds.length === 0) {
        throw new Error(
          `slicer produced 0 tasks for proposal ${proposal.id}; refusing to mark proposal 'sliced' with no surviving tasks`,
        )
      }
      // Phase 4: flip the proposal row to 'sliced' so subsequent invocations
      // refuse to re-slice (the precondition above checks 'prd-ready').
      // markProposalSliced updates the proposal row and emits
      // proposal.sliced on the event bus (best-effort).
      await markProposalSliced(proposal.id, taskIds.length)
      proposalFlipped = true
      // Phase 5 (ADR-0015 promote transfer): any task that was blocked by
      // THIS proposal via task_proposal_blockers must now be re-pointed at the
      // resulting work, atomically, so no dispatcher tick observes the
      // dependent with zero blockers between the delete and the insert.
      // transferProposalBlockerToTask does both writes (delete the
      // task_proposal_blockers row, insert the task_blockers row) in ONE
      // `batch(..., 'write')` transaction — both tables live in the same
      // Mars database, so this is genuinely atomic, not merely ordered.
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
        const { transferProposalBlockerToTask } = await import('../core/queue')
        await transferProposalBlockerToTask(proposal.id, taskIds[0])
      }
    } catch (error: unknown) {
      // Clean up slice tasks AND any Coder sub-tasks created for hitl slices.
      // Each row-removal emits task.dropped + task.terminal{purged} into the
      // outbox in the SAME transaction as the DELETE so the Invalidator
      // (ADR-0030) can still resolve the taskId and supersede any open
      // action-queue rows after the row is gone. Best-effort — a cleanup
      // failure must not mask the original cause.
      // Relocated to the Arc aggregate (ADR-0052 sole-writer): the lifecycle
      // event emit + row deletion now live in Arc.dropTasksForProposal. Call it
      // per-id so the best-effort .catch() stays per-id (a single failed delete
      // must not skip the remaining ids — preserving the original loop's
      // per-row swallow exactly).
      for (const id of [...taskIds, ...subTaskIds]) {
        await Arc.dropTasksForProposal(taskStore, [id], 'slicer-rollback').catch(
          () => {},
        )
      }
      // Compensating revert: the proposal status flip (Phase 4) and the
      // task cleanup above run in separate transactions within the Mars
      // database (see the compensation note above Phase 1: wrapping them in
      // one PG transaction is a deferred, deliberate redesign, not a port
      // detail). If we already flipped the proposal to 'sliced' before
      // failing later (e.g. in Phase 5's blocker-transfer), revert it
      // back to 'prd-ready' so the daemon auto-slice loop and
      // `mars proposal slice` can pick it up again. Best-effort — a revert
      // failure should not mask the original cause.
      if (proposalFlipped) {
        await stateStore
          .execute({
            sql: `UPDATE proposals SET status = 'prd-ready', updated_at = ? WHERE id = ?`,
            args: [Date.now(), proposal.id],
          })
          .catch(() => {})
      }
      throw error
    }

    return { proposalId: proposal.id, status: 'sliced', taskIds, queuedTaskIds, blockedTaskIds }
    } catch (error: unknown) {
      // Compensating revert for the atomic claim. Covers every failure
      // path between the claim above and a successful return — including
      // failures that fire BEFORE the inner Phase 1-5 catch (slicer process
      // failure, parse failure, validation failure) and would otherwise
      // strand the proposal at 'slicing' with no surviving tasks. The WHERE
      // runs for every failure after this workflow owns the claim, including
      // post-Phase-4 failures whose inner cleanup already restored
      // 'prd-ready'. Recording the failure beside that reset prevents the
      // boot reconciler from blindly repeating a deterministic attempt.
      // Best-effort — a revert failure must not mask the original cause.
      const revertStore = await getDefaultStateStore()
      const failure = describeSliceFailure({ status: 'failed', error })
      await revertStore
        .execute({
          sql: `UPDATE proposals
                SET status = 'prd-ready', last_slice_error = ?, last_slice_failed_at = ?, updated_at = ?
                WHERE id = ?`,
          args: [failure, Date.now(), Date.now(), proposal.id],
        })
        .catch(() => {})
      await raiseActionQueueItem({
        kind: 'slice-failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Slicer failed for PRD ${proposal.id}`,
        body: `PRD ${proposal.id} (${proposal.title}) could not be sliced: ${failure}. Inspect the PRD and run \`mars proposal slice ${proposal.id}\` to retry explicitly.`,
        payload: { proposalId: proposal.id, error: failure },
        context: {},
        raisedBy: 'slicer',
        signature: proposal.id,
        originTaskId: proposal.id,
      }).catch(() => {})
      throw error
    }
    }),
})

/**
 * Attempt to complete a HITL slice task.
 *
 * A HITL slice reaches 'done' exactly when BOTH of the following hold:
 *   1. Every blocking sub-task has status 'done' (the Coder sub-task that
 *      delivers the operator artifact has landed).
 *   2. The operator-facing actionQueue item (kind='hitl-slice-needs-operator') for
 *      this slice is 'resolved' or 'dismissed' — the operator has confirmed
 *      the manual step is complete.
 *
 * If either condition is unmet the function is a no-op and returns false.
 * If both conditions are met it flips the task from 'blocked' to 'done'
 * and returns true.
 *
 * Exported so it can be called from daemon event hooks (task.completed,
 * actionQueue.resolved) and from tests exercising the three ordering variants.
 */
export const tryCompleteHitlSlice = async (
  hitlSliceTaskId: string,
  taskStore?: DomainTaskStore,
): Promise<boolean> => {
  const store = taskStore ?? await getDefaultTaskStore()

  // 1. Confirm this is an HITL slice that is still blocked.
  const taskCheckResult = await store.execute({
    sql: `SELECT status, slice_kind, origin_id, slice_index FROM tasks WHERE id = ?`,
    args: [hitlSliceTaskId],
  })
  if (taskCheckResult.rows.length === 0) return false
  const taskRow = taskCheckResult.rows[0] as unknown as {
    status: string
    slice_kind: string | null
    origin_id: string | null
    slice_index: number | null
  }
  if (taskRow.status !== 'blocked' || taskRow.slice_kind !== 'hitl') return false
  if (!taskRow.origin_id || taskRow.slice_index == null) return false

  // 2. All blocking sub-tasks must be done.
  const blockersResult = await store.execute({
    sql: `SELECT t.status FROM task_blockers tb
          JOIN tasks t ON t.id = tb.blocker_task_id
          WHERE tb.task_id = ?`,
    args: [hitlSliceTaskId],
  })
  if (blockersResult.rows.length === 0) return false
  const allDone = blockersResult.rows.every(
    (r) => (r as unknown as { status: string }).status === 'done',
  )
  if (!allDone) return false

  // 3. The operator actionQueue item must be resolved.
  //    The item's signature encodes the proposal id and 1-based slice index,
  //    matching exactly what raiseActionQueueItem sets when slicing.
  const signature = `${taskRow.origin_id}:hitl:${taskRow.slice_index}`
  const hitlItems = await listActionQueueItems('all', { kind: 'hitl-slice-needs-operator' })
  const actionQueueItem = hitlItems.find((item) => item.signature === signature)
  if (!actionQueueItem) return false
  if (actionQueueItem.state !== 'resolved') return false

  // 4. Both conditions met — flip the HITL slice from 'blocked' to 'done'.
  // Route through updateTask so the lifecycle gate (IllegalTransitionError)
  // catches any illegal transition and so the status write + lifecycle events
  // (task.completed, task.terminal) land in the same atomic batch via
  // store.batch (ADR-0030).
  await updateTask(hitlSliceTaskId, { status: 'done' }, store)
  return true
}

export interface RunSliceResult {
  proposalId: string
  status: string
  taskIds: string[]
  queuedTaskIds: string[]
  blockedTaskIds: string[]
}

/** Bound on the synthesized failure message so it stays log-friendly even
 * when a step error carries a giant stack or serialized payload. */
const MAX_SLICE_FAILURE_CHARS = 1000

/**
 * Normalize an unknown error-ish value into a single human-readable line.
 * The @mars/workflow engine puts the thrown `Error` verbatim on
 * `RunResult.error` in-process, but a run rehydrated from the store can
 * surface a serialized `{ name, message, stack }` object, and a bare string
 * is possible too — handle all three rather than assuming one shape.
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
 * Build a diagnostic message from a non-completed slice workflow result.
 * Surfaces the engine's `RunResult.error` (the thrown step error verbatim)
 * so a live slicer outage is diagnosable from the daemon log / CLI instead
 * of the content-free status word. Exported for unit testing.
 */
export const describeSliceFailure = (result: unknown): string => {
  const r = (result ?? {}) as { status?: unknown; error?: unknown }
  const status = typeof r.status === 'string' ? r.status : 'failed'
  const parts: string[] = [`slice workflow ${status}`]

  const topError = stringifyErrorLike(r.error)
  if (topError) parts.push(`error: ${topError}`)

  const message = parts.join(' — ')
  return message.length > MAX_SLICE_FAILURE_CHARS
    ? `${message.slice(0, MAX_SLICE_FAILURE_CHARS)}…`
    : message
}

export const runSlice = async (
  proposalId: string,
  resliceFeedback?: string,
  services?: Partial<SliceServices> & { priority?: number },
): Promise<RunSliceResult> => {
  const taskStore = services?.store ?? await getDefaultTaskStore()
  const traceStore = services?.traceStore ?? nullTraceStore
  const result = await runWorkflow(
    sliceWorkflow,
    { proposalId, resliceFeedback, priority: services?.priority },
    {
      store: createQueueWorkflowStore(),
      services: { store: taskStore, traceStore },
    },
  )
  if (result.status !== 'completed' || !result.output) {
    throw new Error(describeSliceFailure(result))
  }
  return result.output
}
