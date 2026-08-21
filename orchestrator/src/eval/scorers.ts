/**
 * Eval scorers — turn one offline `replayFixture` transcript (`./replay.ts`)
 * into a numeric score per behaviour dimension, each against a stated,
 * deterministic rubric (`mars eval`, `cli/commands/eval.ts`).
 *
 * Every scorer is a pure function of a `ReplayTranscript`: same transcript in,
 * same `ScoreResult` out, every time — `replayFixture` is itself deterministic
 * (no network, no subprocess, no git, no clock reads), so a scorer built only
 * from its output inherits that determinism for free. This is what lets
 * `mars eval` diff a rerun against a recorded baseline and trust the delta.
 *
 * Scores are continuous in `[0, 1]`; 1 is "the dimension behaved exactly as
 * the fixture expected", 0 is "it did not". `mars eval` averages each
 * dimension across the fixture suite and averages the three dimension means
 * into a total.
 */
import type { ReplayTranscript } from './replay'

/** A behaviour dimension a Scorer grades. */
export type ScoreDimension = 'slicing' | 'verify' | 'recovery'

/** The output of one scorer against one replay transcript. */
export interface ScoreResult {
  readonly dimension: ScoreDimension
  /** Normalized score in [0, 1]; higher is better. */
  readonly score: number
  /** The fixed, self-contained rubric this score was computed against. */
  readonly rubric: string
  /** Human-readable explanation of how this transcript arrived at `score`. */
  readonly rationale: string
}

const findStep = (transcript: ReplayTranscript, name: string) =>
  transcript.steps.find((s) => s.name === name)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const stringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Pull the `filePath`s off a `CodeIndex.search()`-shaped hit array. */
const extractHitPaths = (output: unknown): string[] => {
  if (!Array.isArray(output)) return []
  return output
    .map((hit) => (isPlainObject(hit) ? hit.filePath : undefined))
    .filter((p): p is string => typeof p === 'string')
}

/** Pull `filesChanged` off an executor-run-result-shaped output. */
const extractFilesChanged = (output: unknown): string[] =>
  isPlainObject(output) ? stringArray(output.filesChanged) : []

/** Pull `passed`/`steps[].passed` off a verifier-result-shaped output. */
const extractVerifierShape = (
  output: unknown,
): { passed: boolean | undefined; stepsAllPassed: boolean | undefined } => {
  if (!isPlainObject(output)) return { passed: undefined, stepsAllPassed: undefined }
  const passed = typeof output.passed === 'boolean' ? output.passed : undefined
  const steps = Array.isArray(output.steps) ? output.steps : undefined
  const stepsAllPassed =
    steps === undefined
      ? undefined
      : steps.every((s) => isPlainObject(s) && s.passed === true)
  return { passed, stepsAllPassed }
}

// ── Rubrics ──────────────────────────────────────────────────────────────────

const SLICING_RUBRIC =
  'score = |executor.filesChanged ∩ code-index search hit filePaths| / |executor.filesChanged|. ' +
  '1.0 when every file the executor touched was already surfaced by the code-index slice ' +
  '(or when the executor changed nothing — vacuously in scope); 0.0 when none were.'

const VERIFY_RUBRIC =
  "score = 0.5 * (verifier.passed is internally consistent with verifier.steps, i.e. passed === every step's passed) " +
  '+ 0.5 * (the transcript\'s verifierPassed decision matches the fixture\'s expectedDecisions.verifierPassed). ' +
  '1.0 = the verify gate reported a self-consistent result that also matched the recorded expectation.'

const RECOVERY_RUBRIC =
  "score = 0.5 * (finalVerdict correctly composes executorSuccess AND verifierPassed, i.e. 'done' iff both true) " +
  '+ 0.5 * (finalVerdict matches the fixture\'s expectedDecisions.finalVerdict). ' +
  "This is the choice that decides whether an origin task needs a recovery attempt spawned: " +
  '1.0 = the terminal decision was both internally sound and matched the expected outcome.'

// ── Scorers ──────────────────────────────────────────────────────────────────

/**
 * Slicing quality: did the code-index step surface the files the executor
 * actually ended up changing? A slice that misses the changed files means
 * the coder worked outside what was indexed for the task.
 */
export const scoreSlicing = (transcript: ReplayTranscript): ScoreResult => {
  const codeIndexOutput = findStep(transcript, 'code-index')?.output
  const executorOutput = findStep(transcript, 'executor')?.output
  const hitPaths = new Set(extractHitPaths(codeIndexOutput))
  const changedPaths = extractFilesChanged(executorOutput)

  if (changedPaths.length === 0) {
    return {
      dimension: 'slicing',
      score: 1,
      rubric: SLICING_RUBRIC,
      rationale: 'executor reported no changed files — vacuously in scope',
    }
  }

  const hitCount = changedPaths.filter((p) => hitPaths.has(p)).length
  const score = hitCount / changedPaths.length
  return {
    dimension: 'slicing',
    score,
    rubric: SLICING_RUBRIC,
    rationale: `${hitCount}/${changedPaths.length} changed file(s) were surfaced by the code-index slice`,
  }
}

/**
 * Verify correctness: was the verifier's own `passed` boolean consistent
 * with its step results, and did the pipeline's verify decision match what
 * the fixture recorded as expected?
 */
export const scoreVerify = (transcript: ReplayTranscript): ScoreResult => {
  const verifierOutput = findStep(transcript, 'verifier')?.output
  const { passed, stepsAllPassed } = extractVerifierShape(verifierOutput)
  const consistent = passed !== undefined && stepsAllPassed !== undefined && passed === stepsAllPassed
  const matchesExpected = !transcript.mismatches.includes('verifierPassed')

  const score = (consistent ? 0.5 : 0) + (matchesExpected ? 0.5 : 0)
  const rationale = `verifier.passed ${consistent ? 'is' : 'is not'} consistent with its steps; decision ${
    matchesExpected ? 'matches' : 'diverges from'
  } the fixture's expected verifierPassed`
  return { dimension: 'verify', score, rubric: VERIFY_RUBRIC, rationale }
}

/**
 * Recovery choice: did the pipeline's terminal `finalVerdict` correctly
 * compose the executor and verifier outcomes, and did it land on the
 * fixture's expected outcome? This is the decision a recovery policy has to
 * get right to know whether the origin task needs a recovery attempt.
 */
export const scoreRecovery = (transcript: ReplayTranscript): ScoreResult => {
  const { executorSuccess, verifierPassed, finalVerdict } = transcript.decisions
  const expectedVerdict = executorSuccess && verifierPassed ? 'done' : 'failed'
  const consistent = finalVerdict === expectedVerdict
  const matchesExpected = !transcript.mismatches.includes('finalVerdict')

  const score = (consistent ? 0.5 : 0) + (matchesExpected ? 0.5 : 0)
  const rationale = `finalVerdict '${finalVerdict}' ${
    consistent ? 'correctly composes' : 'does not correctly compose'
  } executorSuccess/verifierPassed; decision ${
    matchesExpected ? 'matches' : 'diverges from'
  } the fixture's expected finalVerdict`
  return { dimension: 'recovery', score, rubric: RECOVERY_RUBRIC, rationale }
}
