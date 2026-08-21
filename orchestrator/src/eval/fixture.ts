/**
 * Eval fixture format — a replayable snapshot of one task arc: the prompt
 * that was dispatched, a pointer to the repo state it ran against, and the
 * exact responses its CodeIndex/Verifier/Executor dependencies returned,
 * plus the pipeline decisions that arc was expected to reach.
 *
 * `replayFixture` (`./replay.ts`) re-runs a thin decision pipeline against
 * these stubbed responses — no network call, no subprocess, no git
 * mutation — so a fixture is a deterministic, offline regression check:
 * "given these exact port responses, does the pipeline still decide the
 * same thing?" This is the substrate for measuring whether a prompt or
 * provider change made the pipeline's decisions better or worse.
 *
 * Field shapes deliberately mirror the real Ports so a fixture stays
 * faithful to production data without importing those modules' TS types —
 * a fixture is plain JSON, checked into `./fixtures/*.json`.
 *   - `stubs.codeIndex` mirrors `CodeIndex` (`../core/ports/code-index/types.ts`).
 *   - `stubs.verifier` mirrors `VerifyResult` (`../core/lib/git/verify.ts`),
 *     the `VerifierRunResult` the Verifier Port returns
 *     (`../core/ports/verifier/types.ts`).
 *   - `stubs.executor` has no Port counterpart today — only `verifier`,
 *     `codeIndex` and `vcs` are registered Ports (ADR-0097). It is scoped to
 *     this eval harness, shaped the same way (`kind` + a fixed response) so
 *     promoting it to a real Port later is a lift, not a rewrite.
 */
import { z } from 'zod'

/** Mirrors `SymbolHit` (`../core/ports/code-index/types.ts`). */
const symbolHitSchema = z.object({
  name: z.string(),
  kind: z.string(),
  filePath: z.string(),
  startLine: z.number().int(),
  score: z.number().optional(),
})

const codeIndexStubSchema = z.object({
  kind: z.string().default('fixture'),
  /** Canned response for `CodeIndex.symbols()`. */
  symbols: z.array(symbolHitSchema).default([]),
  /** Canned response for `CodeIndex.search()`. */
  search: z.array(symbolHitSchema).default([]),
  /** Canned `ImpactResult.affected` for `CodeIndex.impact()`. */
  impactAffected: z.array(symbolHitSchema).default([]),
})

const verifyStepStubSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  output: z.string().default(''),
})

const verifierStubSchema = z.object({
  kind: z.string().default('fixture'),
  passed: z.boolean(),
  verdict: z.enum(['PASS', 'FAIL', "CAN'T-VERIFY"]),
  steps: z.array(verifyStepStubSchema).default([]),
})

const executorStubSchema = z.object({
  kind: z.string().default('fixture'),
  success: z.boolean(),
  filesChanged: z.array(z.string()).default([]),
  commitMessage: z.string().default(''),
})

const repoSnapshotSchema = z.object({
  /** The git ref/sha the fixture's stubbed responses were captured against.
   *  Informational only — replay never checks this out or touches git. */
  ref: z.string().min(1),
  description: z.string().optional(),
})

const expectedDecisionsSchema = z.object({
  executorSuccess: z.boolean(),
  verifierPassed: z.boolean(),
  finalVerdict: z.enum(['done', 'failed']),
})

export const evalFixtureSchema = z.object({
  /** Unique fixture identifier — also used as the replay's workflow run id. */
  name: z.string().min(1),
  taskPrompt: z.string().min(1),
  repoSnapshot: repoSnapshotSchema,
  stubs: z.object({
    codeIndex: codeIndexStubSchema,
    verifier: verifierStubSchema,
    executor: executorStubSchema,
  }),
  expectedDecisions: expectedDecisionsSchema,
})

export type EvalFixture = z.infer<typeof evalFixtureSchema>
