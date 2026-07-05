/**
 * The single validation seam for user-owned workflows.
 *
 * `mars workflow validate` (and the declared-runbook section of `mars
 * workflow show`) dry-run the workflow's `fn` on the real engine with an
 * `InMemoryStore` and a {@link ValidateRecorder} threaded through services:
 * every primitive records its declaration and returns an inert result, so the
 * full declared runbook — step names, primitives, Execution modes, Step
 * guides — is enumerated with zero side effects.
 *
 * Load errors come from {@link loadWorkflowByName} — the exact no-fallback
 * loader the dispatcher uses — so what validate accepts is precisely what
 * dispatch will run, and what validate rejects is precisely what would fail
 * the task at dispatch time.
 *
 * Caveat (documented in the scaffolded templates): the workflow file is the
 * consumer's own JS and its `fn` EXECUTES during validation. Only primitive
 * work is stubbed; side effects an author writes outside primitives will run.
 */

import { InMemoryStore, runWorkflow } from '@mars/workflow'
import type { DomainTaskStore } from '../core/store/task-store'
import type { ValidateRecorderEntry } from './primitives'
import {
  loadWorkflowByName,
  userWorkflowPath,
} from './queue-workflow-store'

/**
 * One step of the declared runbook, in execution order. `primitive` is one of
 * the five Mars primitives when the step body called one, or `'(custom)'` for
 * hand-written step bodies (e.g. the scaffolded diagnose/write placeholders).
 */
export interface DeclaredStep {
  step: string | null
  primitive: string
  mode: 'auto' | 'manual'
  guide: string | null
}

export interface WorkflowValidation {
  ok: boolean
  /** The workflow name that was validated (file: `<name>-workflow.js`). */
  name: string
  /** Absolute path of the validated file. */
  path: string
  /** The default-exported workflow id, when the file loaded. */
  workflowId: string | null
  /** Declared runbook in execution order (empty when validation failed early). */
  steps: DeclaredStep[]
  errors: string[]
}

/**
 * Inert store handed to the dry-run's `services.store`. Primitives never
 * reach it (the recorder gate returns first); it exists so a user fn that
 * touches `ctx.services.store` directly gets empty result sets instead of a
 * live database.
 */
const inertTaskStore = (): DomainTaskStore =>
  ({
    query: async () => ({ rows: [] }),
    execute: async () => ({ rows: [] }),
    batch: async () => [],
  }) as unknown as DomainTaskStore

export const validateWorkflow = async (
  name: string,
  repoRoot?: string,
): Promise<WorkflowValidation> => {
  const path = repoRoot ? userWorkflowPath(name, repoRoot) : userWorkflowPath(name)
  const base = { name, path, workflowId: null, steps: [], errors: [] }

  let wf
  try {
    wf = repoRoot
      ? await loadWorkflowByName(name, repoRoot)
      : await loadWorkflowByName(name)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ...base, ok: false, errors: [msg] }
  }

  const dry = await dryRunWorkflow(wf, name)
  return {
    ...base,
    ok: dry.errors.length === 0,
    workflowId: typeof wf.id === 'string' ? wf.id : null,
    steps: dry.steps,
    errors: dry.errors,
  }
}

/**
 * The engine-level dry-run behind {@link validateWorkflow}: run `fn` with the
 * recorder in services and merge engine step records with the recorded
 * primitive declarations. Exported separately so it is testable with an
 * in-memory workflow object (a tmp file cannot resolve the `mars/workflow`
 * bare specifier).
 */
export const dryRunWorkflow = async (
  wf: Parameters<typeof runWorkflow>[0],
  name: string,
): Promise<{ steps: DeclaredStep[]; errors: string[] }> => {
  const entries: ValidateRecorderEntry[] = []
  const recorder = { record: (e: ValidateRecorderEntry) => entries.push(e) }
  const engineStore = new InMemoryStore()

  const errors: string[] = []
  const runId = `validate:${name}`
  const result = await runWorkflow(
    wf,
    // Synthetic dispatch facts so input-defaulting primitives resolve without
    // a real task row. Primitives never act on them in validation mode.
    {
      taskId: runId,
      prompt: '(validation dry-run)',
      kind: 'task',
    },
    {
      store: engineStore,
      runId,
      services: { store: inertTaskStore(), validateRecorder: recorder },
    },
  )
  if (result.status === 'failed') {
    // Duplicate step names, throws in author code, schema rejections — the
    // engine surfaces them all here.
    errors.push(
      `dry-run failed: ${result.error?.message ?? 'unknown error'}`,
    )
  }

  // Merge the engine's step records (authoritative names + order) with the
  // recorder entries (primitive/mode/guide where a Mars primitive ran).
  // Hand-written step bodies — the scaffolded diagnose/write placeholders,
  // or any custom step an author adds — render as '(custom)' auto steps.
  const engineSteps = await engineStore.listSteps(runId)
  const steps: DeclaredStep[] = engineSteps.map((s) => {
    const rec = entries.find((e) => e.step === s.name)
    return rec ?? { step: s.name, primitive: '(custom)', mode: 'auto', guide: null }
  })
  // Primitive calls made outside any ctx.step still surface (they have no
  // engine record).
  for (const e of entries) {
    if (e.step === null) steps.push(e)
  }
  if (steps.length === 0 && errors.length === 0) {
    errors.push(
      'workflow fn ran but declared no steps — wrap work in ctx.step(name, fn)',
    )
  }

  return { steps, errors }
}
