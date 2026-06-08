export interface StepEvalResult {
  label: string
  value: number | string | null
  warn: boolean
}

export interface StepEvaluator {
  /** Short display label, e.g. "ctx%" */
  label: string
  /** Pure function: reads the step_ended payload, returns a value or null if not applicable */
  compute: (payload: Record<string, unknown>) => number | string | null
  /** Optional formatter for display. Defaults to String(value). */
  format?: (value: number | string) => string
  /** Return true to show a warning indicator. */
  warn?: (value: number | string) => boolean
}

const CONTEXT_WINDOW_TOKENS = 200_000

const registry = new Map<string, StepEvaluator[]>()

export function registerStepEvaluator(stepName: string, evaluator: StepEvaluator): void {
  const existing = registry.get(stepName) ?? []
  const idx = existing.findIndex((e) => e.label === evaluator.label)
  if (idx === -1) {
    existing.push(evaluator)
  } else {
    existing[idx] = evaluator
  }
  registry.set(stepName, existing)
}

export function evaluateStep(
  stepName: string,
  payload: Record<string, unknown>,
): StepEvalResult[] {
  const evaluators = registry.get(stepName) ?? []
  const results: StepEvalResult[] = []
  for (const ev of evaluators) {
    let value: number | string | null = null
    try {
      value = ev.compute(payload)
    } catch {
      continue
    }
    if (value === null) continue
    const formatted = ev.format ? ev.format(value) : String(value)
    const warned = ev.warn ? ev.warn(value) : false
    results.push({ label: ev.label, value: formatted, warn: warned })
  }
  return results
}

function usageSignals(payload: Record<string, unknown>): Record<string, unknown> | null {
  const signals = payload.usageSignals
  if (signals !== null && typeof signals === 'object' && !Array.isArray(signals)) {
    return signals as Record<string, unknown>
  }
  return null
}

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function llmEvaluators(): StepEvaluator[] {
  return [
    {
      label: 'ctx%',
      compute(payload) {
        const s = usageSignals(payload)
        if (!s) return null
        const ctx = toNum(s.contextTokens)
        return Math.round((ctx / CONTEXT_WINDOW_TOKENS) * 100 * 10) / 10
      },
      format: (v) => `${v}%`,
      warn: (v) => (v as number) >= 80,
    },
    {
      label: 'out/in',
      compute(payload) {
        const s = usageSignals(payload)
        if (!s) return null
        const input = toNum(s.inputTokens)
        if (input === 0) return null
        const output = toNum(s.outputTokens)
        return Math.round((output / input) * 100) / 100
      },
    },
    {
      label: 'msgs',
      compute(payload) {
        const s = usageSignals(payload)
        if (!s) return null
        const count = s.messageCount
        if (typeof count !== 'number') return null
        return count
      },
    },
  ]
}

const LLM_STEPS = ['run-claude-code', 'slicer', 'triage', 'plan', 'slice']
for (const step of LLM_STEPS) {
  for (const ev of llmEvaluators()) {
    registerStepEvaluator(step, ev)
  }
}

registerStepEvaluator('verify', {
  label: 'checks',
  compute(payload) {
    const v = payload.verifyCheckCount
    if (typeof v !== 'number') return null
    return v
  },
})

registerStepEvaluator('verify', {
  label: 'failed',
  compute(payload) {
    const v = payload.verifyFailedCount
    if (typeof v !== 'number') return null
    return v
  },
  warn: (v) => (v as number) > 0,
})

registerStepEvaluator('setup-worktree', {
  label: 'deps',
  compute(payload) {
    const v = payload.depsInstalled
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    if (typeof v === 'number') return v
    return null
  },
})

for (const step of ['slicer', 'slice']) {
  registerStepEvaluator(step, {
    label: 'tasks',
    compute(payload) {
      const v = payload.slicedTaskCount
      if (typeof v !== 'number') return null
      return v
    },
  })
}
