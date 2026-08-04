import { runHeadlessProvider } from '../workers/providers'
import { getRepoRoot } from '../context'
import { createHash } from 'node:crypto'
import {
  createProposal,
  findOpenReflectionDraftByFingerprint,
  appendProposalNotes,
} from '../proposals'
import { getDefaultTaskStore } from '../store/task-store'
import { loadImprovementRecipes, formatRecipeCatalog } from './improvement-recipes'
import { collectAssistantText, extractFirstJsonDocument } from './reflector'

const SYSTEM_PROMPT_TEMPLATE = `You are a harness improvement advisor for the Mars orchestrator.
A task failed and recovery was exhausted — the fix-task loop could not
resolve the issue. Your job is NOT to fix the code but to improve the
harness so this class of failure is prevented or automatically handled.

Review the arc: the origin task, what it tried, each recovery attempt,
and why each failed. Then:
1. Check the improvement recipe catalog for applicable recipes.
2. Suggest which recipes to apply (cite the recipe name).
3. If no recipe fits, propose a novel improvement.

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
  retryCount: number
  worktreePath: string | null
  branch: string | null
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

/**
 * Returns `true` when self-heal is disabled via
 * `mars operator set recovery off` (sets MARS_RECOVERY_DISABLED=1
 * persistently).
 *
 * The failure handler's own kill-switch check returns early only for origin
 * tasks (`fixForTaskId === null`); recovery-task failures fall through to the
 * reflector spawn sites. Checking the flag here too makes the incident
 * kill-switch actually comprehensive.
 */
const isRecoveryDisabled = (): boolean =>
  process.env.MARS_RECOVERY_DISABLED === '1'

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
    `Retry count: ${opts.retryCount}`,
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

  const existing = await findOpenReflectionDraftByFingerprint(fingerprint, 'failure-reflector')
  if (existing) {
    if (s.rationale) {
      await appendProposalNotes(existing.id, s.rationale)
    }
    return
  }

  const notes = [s.rationale, s.recipe ? `Recipe: ${s.recipe}` : null]
    .filter(Boolean)
    .join('\n')

  await createProposal(s.title, {
    source: 'failure-reflector',
    author: { kind: 'agent', name: 'failure-reflector' },
    solution: s.action,
    notes,
    fingerprint,
  })
}

/**
 * Spawn a harness-improvement analysis for an exhausted failure arc.
 *
 * Fire-and-forget: the call site does NOT await this. All errors are caught
 * and logged; nothing is ever thrown. The function runs the selected provider with a
 * harness-improvement system prompt (NOT a code-fix prompt), then persists
 * each suggestion as a draft proposal with source='failure-reflector'.
 *
 * Deduplication: suggestions for the same failing step and classified failure
 * signature are collapsed into the existing open draft (notes appended, no
 * new proposal row created), regardless of model-written title wording.
 *
 * Admission control (see {@link MAX_CONCURRENT}): the call is suppressed when
 * self-heal is disabled, an open draft already represents this failure
 * signature, or {@link MAX_CONCURRENT} runs are already in flight. Suppression
 * is silent and non-fatal — the caller never awaits this.
 *
 * The signature gate comes before the global concurrency gate. An open draft
 * records that this failure arc has already been analysed, so recurring
 * failures with unchanged classification do not consume another provider run.
 * A changed failing step or signature receives its own analysis and draft.
 */
export const spawnFailureReflector = async (
  opts: SpawnFailureReflectorOpts,
): Promise<void> => {
  // ── Admission control ────────────────────────────────────────────────────
  // Checked before any provider work so recurring failures do not saturate it.
  if (isRecoveryDisabled()) return
  const existing = await findOpenReflectionDraftByFingerprint(
    failureReflectorFingerprint(opts),
    'failure-reflector',
  )
  if (existing) return
  if (inFlight >= MAX_CONCURRENT) return

  inFlight += 1

  try {
    const recipes = loadImprovementRecipes()
    const catalog = formatRecipeCatalog(recipes)
    const arcContext = await buildArcContext(opts)

    const prompt = SYSTEM_PROMPT_TEMPLATE.replace('{catalog}', catalog).replace(
      '{arcContext}',
      arcContext,
    )

    const r = await runHeadlessProvider(prompt, {
      cwd: getRepoRoot(),
      modelTier: 'balanced',
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
