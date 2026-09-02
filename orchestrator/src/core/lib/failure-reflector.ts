import { runHeadlessProvider } from '../workers/providers'
import { getRepoRoot } from '../context'
import { createHash } from 'node:crypto'
import {
  createProposal,
  addProposalUserStory,
  recordFailureReflectionOccurrence,
} from '../proposals'
import { getDefaultTaskStore } from '../store/task-store-default'
import { loadLeverRegistry, formatRecipeCatalog } from './lever-registry'
import { collectAssistantText, extractFirstJsonDocument } from './reflector'
import type { Reflector, ReflectorRunOutcome } from '../ports/reflector/types'
import { isRecoveryDisabled, resolveControlLevers } from '../config/levers'
import type { ControlLevers } from '../daemon/config'

const SYSTEM_PROMPT_TEMPLATE = `You are a harness improvement advisor for the Mars orchestrator.
A task failed and recovery was exhausted — the fix-task loop could not
resolve the issue. Your job is NOT to fix the code but to improve the
harness so this class of failure is prevented or automatically handled.

Review the arc: the origin task, what it tried, each recovery attempt,
and why each failed. Then:
1. Check the improvement recipe catalog for applicable recipes.
2. Suggest which recipes to apply (cite the recipe name).
3. If no recipe fits, propose a novel improvement.

Least-specific-valid-rule requirement: the rule behind each suggestion
must be VALID on every failure instance you cite as evidence, and no
MORE SPECIFIC than that evidence requires — do not narrow a rule to
this arc's exact signature, file path, or task id when a broader
pattern already covers it, and do not widen it past what the cited
instances actually support. In "rationale", state explicitly (a) which
failures/instances this rule COVERS — cite them — and (b) what it does
NOT claim to cover (other signatures, tasks, or scenarios you have no
evidence for).

Output a JSON object:
{
  "suggestions": [
    {
      "recipe": "add-typecheck" | null,
      "title": "short title",
      "rationale": "why this would help",
      "action": "concrete mars verify add command or other action"
    }
  ]
}

Improvement recipes:
{catalog}

Arc context:
{arcContext}`

export interface SpawnFailureReflectorOpts {
  taskId: string
  lastStep: string
  lastErrorSignature: string
  recoverySpawnedCount: number
  worktreePath: string | null
  branch: string | null
  /**
   * The operator control levers governing this spawn. `recovery: 'off'`
   * suppresses it entirely.
   *
   * The failure handler's own kill-switch check returns early only for origin
   * tasks (`fixForTaskId === null`); recovery-task failures fall through to
   * the reflector spawn sites, so the lever is honoured here too and the
   * incident kill-switch stays comprehensive. Defaults to
   * `resolveControlLevers()` for callers that reach the Port without one.
   */
  levers?: ControlLevers
}

// ─────────────────────────────────────────────────────────────────────────────
// Admission control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum concurrent reflector agents.
 *
 * The reflector is spawned fire-and-forget from the failure handler, once per
 * failing task, and does NOT pass through the daemon's worker-pool semaphores
 * (`acquire(sems.*)` in server.ts). Without a cap of its own, a failure storm
 * spawns one headless provider run per failure simultaneously — a 900-task
 * backlog melted the host at ~150 concurrent `codex exec` processes, invisible
 * to an operator dispatch pause because the pool genuinely held zero of them.
 *
 * Overflow is DROPPED, not queued. Reflector output is a best-effort
 * harness-improvement draft proposal, so shedding load under a storm is the
 * correct behaviour — queueing would only defer the same melt.
 */
const MAX_CONCURRENT = Number(process.env.MARS_FAILURE_REFLECTOR_MAX ?? 1)

let inFlight = 0

/** For test isolation ONLY. Never call in production. */
export const _resetFailureReflectorGateForTests = (): void => {
  inFlight = 0
}

interface FailureReflectorSuggestion {
  recipe: string | null
  title: string
  rationale: string
  action: string
}

const buildArcContext = async (opts: SpawnFailureReflectorOpts): Promise<string> => {
  let taskPrompt = '(not found)'
  const fixTaskLines: string[] = []

  try {
    const store = await getDefaultTaskStore()

    try {
      const task = await store.getTask(opts.taskId)
      if (task?.prompt) {
        taskPrompt = task.prompt.slice(0, 500)
      }
    } catch {
      // best-effort: proceed without task prompt
    }

    try {
      const fixTasksResult = await store.query({
        sql: `SELECT id, failure_reason, status FROM tasks WHERE fix_for_task_id = ? ORDER BY created_at ASC`,
        args: [opts.taskId],
      })
      for (const row of fixTasksResult.rows) {
        const r = row as Record<string, unknown>
        fixTaskLines.push(
          `  - Fix task ${r.id}: status=${r.status}, failure=${r.failure_reason ?? 'none'}`,
        )
      }
    } catch {
      // best-effort: proceed without fix task list
    }
  } catch {
    // best-effort: proceed without DB context
  }

  return [
    `Task ID: ${opts.taskId}`,
    `Prompt: ${taskPrompt}`,
    `Last failing step: ${opts.lastStep}`,
    `Failure signature: ${opts.lastErrorSignature}`,
    `Retry count: ${opts.recoverySpawnedCount}`,
    opts.branch ? `Branch: ${opts.branch}` : null,
    opts.worktreePath ? `Worktree: ${opts.worktreePath}` : null,
    '',
    'Fix task attempts:',
    fixTaskLines.length > 0 ? fixTaskLines.join('\n') : '  (none)',
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

const parseSuggestions = (text: string): FailureReflectorSuggestion[] => {
  const parsed = extractFirstJsonDocument(text) as { suggestions?: unknown } | null
  if (!parsed || !Array.isArray(parsed.suggestions)) return []

  const results: FailureReflectorSuggestion[] = []
  for (const raw of parsed.suggestions) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : ''
    const action = typeof obj.action === 'string' ? obj.action.trim() : ''
    const recipe = typeof obj.recipe === 'string' ? obj.recipe : null
    if (!title || !action) continue
    results.push({ recipe, title, rationale, action })
  }
  return results
}

const failureReflectorFingerprint = (opts: SpawnFailureReflectorOpts): string =>
  createHash('sha256')
    .update(`failure-reflector:${opts.lastStep}:${opts.lastErrorSignature}:`)
    .digest('hex')
    .slice(0, 32)

const persistSuggestion = async (
  opts: SpawnFailureReflectorOpts,
  s: FailureReflectorSuggestion,
): Promise<void> => {
  const fingerprint = failureReflectorFingerprint(opts)

  const notes = [s.rationale, s.recipe ? `Recipe: ${s.recipe}` : null]
    .filter(Boolean)
    .join('\n')

  const proposal = await createProposal(s.title, {
    source: 'failure-reflector',
    author: { kind: 'agent', name: 'failure-reflector' },
    problem: s.rationale,
    solution: s.action,
    notes,
    fingerprint,
  })
  await addProposalUserStory(proposal.id, s.title)
}

/**
 * Spawn a harness-improvement analysis for an exhausted failure arc.
 *
 * Fire-and-forget: the call site does NOT await this. All errors are caught
 * and logged; nothing is ever thrown. The function runs the selected provider with a
 * harness-improvement system prompt (NOT a code-fix prompt), then persists
 * each suggestion as a draft proposal with source='failure-reflector'.
 *
 * Deduplication: signatures are claimed in a durable ledger before provider
 * work begins. That ledger survives the proposal lifecycle, so dismissing or
 * deleting a proposal cannot regenerate it. The proposal's unique
 * source/fingerprint index remains a second line of defense and merges notes
 * if a legacy or cross-process race reaches the insert path.
 *
 * Admission control (see {@link MAX_CONCURRENT}): the call is suppressed when
 * self-heal is disabled, the signature was already analysed, or
 * {@link MAX_CONCURRENT} runs are already in flight. Suppression
 * is silent and non-fatal — the caller never awaits this.
 *
 * The concurrency slot is reserved before the durable signature claim, so
 * overload shedding cannot accidentally mark an unanalysed signature as
 * complete. The ledger then ensures recurring failures with unchanged
 * classification do not consume another provider run.
 * A changed failing step or signature receives its own analysis and draft.
 */
export const spawnFailureReflector = async (
  opts: SpawnFailureReflectorOpts,
): Promise<void> => {
  // ── Admission control ────────────────────────────────────────────────────
  // Checked before any provider work so recurring failures do not saturate it.
  if (isRecoveryDisabled(opts.levers ?? resolveControlLevers())) return
  if (inFlight >= MAX_CONCURRENT) return
  inFlight += 1

  try {
    if (!(await recordFailureReflectionOccurrence(failureReflectorFingerprint(opts)))) return
    const catalog = formatRecipeCatalog(loadLeverRegistry())
    const arcContext = await buildArcContext(opts)

    const prompt = SYSTEM_PROMPT_TEMPLATE.replace('{catalog}', catalog).replace(
      '{arcContext}',
      arcContext,
    )

    const r = await runHeadlessProvider(prompt, {
      cwd: getRepoRoot(),
      modelTier: 'fast',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    })

    const text = collectAssistantText(r.conversation) || r.stdout
    const suggestions = parseSuggestions(text)

    for (const s of suggestions) {
      await persistSuggestion(opts, s)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[failure-reflector] error (non-fatal):', err)
  } finally {
    inFlight -= 1
  }
}

/**
 * The `failure` Reflector Port implementation — binds
 * {@link spawnFailureReflector} to the `Reflector<SpawnFailureReflectorOpts,
 * ReflectorRunOutcome>` contract (`../ports/reflector/types.ts`). Registered
 * under kind `'failure'` in `../ports/reflector/registry.ts`; CLI/daemon
 * entry points resolve it via `requireReflector('failure')` instead of
 * importing `spawnFailureReflector` directly.
 *
 * `spawnFailureReflector` is fire-and-forget by design (admission-controlled,
 * never throws, persists suggestions as a side effect) and reports no
 * provider output of its own once suppressed by admission control — the
 * Port's `ReflectorRunOutcome` envelope is satisfied with a neutral outcome
 * rather than inventing data the underlying function never produced.
 */
export const failureReflector: Reflector<SpawnFailureReflectorOpts, ReflectorRunOutcome> = {
  kind: 'failure',
  reflect: async (opts) => {
    await spawnFailureReflector(opts)
    return { rawOutput: '', exitCode: 0 }
  },
}
