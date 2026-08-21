/**
 * `replayFixture` — offline, deterministic replay of one eval fixture
 * (`./fixture.ts`).
 *
 * Runs a thin `@mars/workflow` pipeline — a code-index lookup, an executor
 * "run", a verifier run — with the CodeIndex and Verifier Ports
 * (`../core/ports/*`) and the (not-yet-a-Port) Executor bound to
 * fixture-backed stub implementations, injected directly as workflow
 * services. Every response the pipeline sees is the fixture's own stubbed
 * data: no network call, no subprocess, no git mutation, and persistence is
 * an ephemeral `InMemoryStore` scoped to this one replay call — so replaying
 * the same fixture twice produces byte-identical output.
 */
import { defineWorkflow, InMemoryStore, runWorkflow } from '@mars/workflow'
import { z } from 'zod'
import type { CodeIndex, ImpactQuery, ImpactResult, SymbolHit, SymbolQuery } from '../core/ports/code-index/types'
import type { Verifier } from '../core/ports/verifier/types'
import { evalFixtureSchema, type EvalFixture } from './fixture'

interface ExecutorRunResult {
  success: boolean
  filesChanged: string[]
  commitMessage: string
}

/** Not a registered Port today (see `fixture.ts`'s doc comment) — scoped to
 *  this eval harness, shaped the same way (`kind` + `run`) as a real Port. */
interface ExecutorStub {
  readonly kind: string
  run(prompt: string): Promise<ExecutorRunResult>
}

interface VerifierArgs {
  filesChanged: string[]
}

interface VerifierResult {
  passed: boolean
  verdict: 'PASS' | 'FAIL' | "CAN'T-VERIFY"
  steps: Array<{ name: string; passed: boolean; output: string }>
}

interface ReplayServices {
  codeIndex: CodeIndex
  verifier: Verifier<VerifierArgs, VerifierResult>
  executor: ExecutorStub
}

interface ReplayStepRecord {
  name: string
  input: unknown
  output: unknown
}

interface ReplayDecisions {
  executorSuccess: boolean
  verifierPassed: boolean
  finalVerdict: 'done' | 'failed'
}

export interface ReplayTranscript {
  fixtureName: string
  steps: ReplayStepRecord[]
  decisions: ReplayDecisions
  /** Whether `decisions` matches the fixture's `expectedDecisions` exactly. */
  matchesExpected: boolean
  /** Decision fields that diverged from `expectedDecisions`; empty when `matchesExpected`. */
  mismatches: string[]
}

const replayInputSchema = z.object({ taskPrompt: z.string() })

interface ReplayOutput {
  steps: ReplayStepRecord[]
  decisions: ReplayDecisions
}

const replayPipeline = defineWorkflow<{ taskPrompt: string }, ReplayOutput, ReplayServices>({
  id: 'eval-replay',
  inputSchema: replayInputSchema,
  fn: async (ctx) => {
    const steps: ReplayStepRecord[] = []

    const codeIndexQuery: SymbolQuery = { term: ctx.input.taskPrompt }
    const codeIndexHits = await ctx.step('code-index', () => ctx.services.codeIndex.search(codeIndexQuery))
    steps.push({ name: 'code-index', input: codeIndexQuery, output: codeIndexHits })

    const executorResult = await ctx.step('executor', () => ctx.services.executor.run(ctx.input.taskPrompt))
    steps.push({ name: 'executor', input: { taskPrompt: ctx.input.taskPrompt }, output: executorResult })

    const verifierArgs: VerifierArgs = { filesChanged: executorResult.filesChanged }
    const verifierResult = await ctx.step('verifier', () => ctx.services.verifier.run(verifierArgs))
    steps.push({ name: 'verifier', input: verifierArgs, output: verifierResult })

    const finalVerdict: ReplayDecisions['finalVerdict'] =
      executorResult.success && verifierResult.passed ? 'done' : 'failed'

    return {
      steps,
      decisions: {
        executorSuccess: executorResult.success,
        verifierPassed: verifierResult.passed,
        finalVerdict,
      },
    }
  },
})

export const replayFixture = async (fixture: EvalFixture): Promise<ReplayTranscript> => {
  const parsed = evalFixtureSchema.parse(fixture)
  const fixtureKind = `fixture:${parsed.name}`

  const codeIndex: CodeIndex = {
    kind: fixtureKind,
    async symbols(_query: SymbolQuery): Promise<SymbolHit[]> {
      return parsed.stubs.codeIndex.symbols
    },
    async search(_query: SymbolQuery): Promise<SymbolHit[]> {
      return parsed.stubs.codeIndex.search
    },
    async impact(query: ImpactQuery): Promise<ImpactResult> {
      return { symbol: query.symbol, affected: parsed.stubs.codeIndex.impactAffected }
    },
  }

  const verifier: Verifier<VerifierArgs, VerifierResult> = {
    kind: fixtureKind,
    async run(_args: VerifierArgs): Promise<VerifierResult> {
      return {
        passed: parsed.stubs.verifier.passed,
        verdict: parsed.stubs.verifier.verdict,
        steps: parsed.stubs.verifier.steps,
      }
    },
  }

  const executor: ExecutorStub = {
    kind: fixtureKind,
    async run(): Promise<ExecutorRunResult> {
      return {
        success: parsed.stubs.executor.success,
        filesChanged: parsed.stubs.executor.filesChanged,
        commitMessage: parsed.stubs.executor.commitMessage,
      }
    },
  }

  const result = await runWorkflow(
    replayPipeline,
    { taskPrompt: parsed.taskPrompt },
    {
      store: new InMemoryStore(),
      services: { codeIndex, verifier, executor },
      runId: `eval-${parsed.name}`,
    },
  )

  if (result.status !== 'completed') {
    throw new Error(`eval replay failed for fixture "${parsed.name}": ${result.error.message}`)
  }

  const { steps, decisions } = result.output
  const mismatches: string[] = []
  if (decisions.executorSuccess !== parsed.expectedDecisions.executorSuccess) mismatches.push('executorSuccess')
  if (decisions.verifierPassed !== parsed.expectedDecisions.verifierPassed) mismatches.push('verifierPassed')
  if (decisions.finalVerdict !== parsed.expectedDecisions.finalVerdict) mismatches.push('finalVerdict')

  return {
    fixtureName: parsed.name,
    steps,
    decisions,
    matchesExpected: mismatches.length === 0,
    mismatches,
  }
}
