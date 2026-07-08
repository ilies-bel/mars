import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BEHAVIOUR_DOD_UNMET_SIGNATURE,
  BEHAVIOUR_VERIFY_FAILING_STEP,
  BEHAVIOUR_VERIFY_STEP_NAME,
  behaviourUnverifiedFingerprint,
  behaviourVerify,
  buildArtifacts,
  buildBehaviourVerifyPrompt,
  buildFailEvidenceBlock,
  extractVerdictReport,
  foldVerdicts,
  playwrightMcpServers,
  VERDICT_CLOSE_TAG,
  VERDICT_OPEN_TAG,
  type BehaviourVerifyDeps,
  type CriterionVerdict,
} from '../behaviour-verify'
import type { MarsCtx, MarsWorkflowInput } from '../index'
import {
  classifyError,
  computeFailureSignature,
} from '../../../core/lib/failure-signature'
import { hasRecipe, getRecipe } from '../../../core/lib/fix-recipes'
import { lookupFailureKind } from '../../../core/lib/failure-kinds'
import {
  ACTION_QUEUE_KINDS,
  isActionQueueKind,
} from '../../../core/lib/action-queue'
import {
  claudeStreamArgs,
  codegraphMcpConfigJson,
} from '../../../core/lib/git/claude'
import { WORKER_CONFIGS } from '../../../core/workers'
import {
  runNonLlmStepWithSpan,
  type RunWorkerWithSpanOptions,
} from '../../../core/lib/run-worker-with-span'
import { __resetContextCacheForTests } from '../../../core/context'
import type { Task } from '../../../core/queue'
import type { Proposal } from '../../../core/proposals'
import type { ClaudeEvent } from '../../../core/lib/claude-stream'
import type { RunClaudeResult } from '../../../core/lib/git/claude'
import type { TraceEventStore } from '../../../core/lib/trace-events-store'

// ---------------------------------------------------------------------------
// Sandbox: point resolveContext / origin resolution at a temp repo so no test
// ever touches a real .mars.
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-behaviour-verify-'))
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()
})

// ---------------------------------------------------------------------------
// Verdict extraction (the parser is the guard against LLM optimism)
// ---------------------------------------------------------------------------

const resultEvent = (text: string): ClaudeEvent => ({ type: 'result', result: text })

describe('extractVerdictReport', () => {
  it('parses the sentinel-tagged block from the result event', () => {
    const report = extractVerdictReport([
      resultEvent(
        `preamble\n${VERDICT_OPEN_TAG}\n{"verdicts": [{"criterionIndex": 0, "verdict": "pass", "evidence": "criterion-0.png", "note": "banner visible"}]}\n${VERDICT_CLOSE_TAG}\ntrailer`,
      ),
    ])
    expect(report).not.toBeNull()
    expect(report!.verdicts).toHaveLength(1)
    expect(report!.verdicts[0].verdict).toBe('pass')
    expect(report!.verdicts[0].evidence).toBe('criterion-0.png')
  })

  it('falls back to the last fenced json block carrying a "verdicts" key', () => {
    const report = extractVerdictReport([
      resultEvent(
        'here you go:\n```json\n{"verdicts": [{"criterionIndex": 1, "verdict": "fail", "evidence": "criterion-1.png", "note": "button dead"}]}\n```\n',
      ),
    ])
    expect(report).not.toBeNull()
    expect(report!.verdicts[0].verdict).toBe('fail')
  })

  it('reads the verdict block from an assistant text block when no result event carries it', () => {
    const report = extractVerdictReport([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: `${VERDICT_OPEN_TAG}{"verdicts": [{"criterionIndex": 0, "verdict": "unverifiable", "evidence": null, "note": "backend-only"}]}${VERDICT_CLOSE_TAG}`,
            },
          ],
        },
      },
    ])
    expect(report).not.toBeNull()
    expect(report!.verdicts[0].verdict).toBe('unverifiable')
  })

  it('returns null on prose with no verdict block (never an inferred pass)', () => {
    expect(extractVerdictReport([resultEvent('Everything looked great to me!')])).toBeNull()
  })

  it('returns null on malformed JSON inside the sentinel tags', () => {
    expect(
      extractVerdictReport([
        resultEvent(`${VERDICT_OPEN_TAG}{"verdicts": [not json]}${VERDICT_CLOSE_TAG}`),
      ]),
    ).toBeNull()
  })

  it('returns null when the JSON parses but fails the Zod schema', () => {
    expect(
      extractVerdictReport([
        resultEvent(
          `${VERDICT_OPEN_TAG}{"verdicts": [{"criterionIndex": "zero", "verdict": "maybe"}]}${VERDICT_CLOSE_TAG}`,
        ),
      ]),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The tri-state fold
// ---------------------------------------------------------------------------

const v = (
  criterionIndex: number,
  verdict: CriterionVerdict['verdict'],
  evidence: string | null = null,
): CriterionVerdict => ({ criterionIndex, verdict, evidence, note: '' })

describe('foldVerdicts — FAIL dominates, PASS needs positive evidence', () => {
  it('a single evidenced fail dominates any number of passes', () => {
    const fold = foldVerdicts([v(0, 'pass', 'a.png'), v(1, 'fail', 'b.png'), v(2, 'pass', 'c.png')])
    expect(fold.decision).toBe('fail')
    if (fold.decision === 'fail') {
      expect(fold.failed).toHaveLength(1)
      expect(fold.failed[0].criterionIndex).toBe(1)
    }
  })

  it('all-pass folds to pass', () => {
    expect(foldVerdicts([v(0, 'pass', 'a.png')]).decision).toBe('pass')
  })

  it('pass + unverifiable (no fail) still folds to pass — absence never blocks', () => {
    expect(foldVerdicts([v(0, 'pass', 'a.png'), v(1, 'unverifiable')]).decision).toBe('pass')
  })

  it('only-unverifiable folds to CAN\'T-VERIFY (no-exercisable-criteria), never pass', () => {
    const fold = foldVerdicts([v(0, 'unverifiable'), v(1, 'unverifiable')])
    expect(fold.decision).toBe('unverifiable')
    if (fold.decision === 'unverifiable') {
      expect(fold.reason).toBe('no-exercisable-criteria')
    }
  })

  it('an empty verdict list folds to CAN\'T-VERIFY', () => {
    expect(foldVerdicts([]).decision).toBe('unverifiable')
  })
})

// ---------------------------------------------------------------------------
// Registration: signature rule, ADR-0002 recipe, failure-kind, queue kind
// ---------------------------------------------------------------------------

describe('behaviour-verify:dod-unmet registration (ship-blocker wiring)', () => {
  const evidenceBlock = buildFailEvidenceBlock({
    failed: [v(0, 'fail', 'criterion-0.png')],
    criteria: ['the banner renders'],
    previewCmd: 'npm run dev',
    url: 'http://127.0.0.1:4000',
    artifactsDir: '/tmp/art',
    devServerLogPath: '/tmp/art/t.log',
    logTail: 'listening on 4000',
  })

  it('the evidence block first line classifies to the dod-unmet error class', () => {
    expect(classifyError(evidenceBlock)).toBe('dod-unmet')
  })

  it('computeFailureSignature yields the registered full signature', () => {
    expect(computeFailureSignature(BEHAVIOUR_VERIFY_FAILING_STEP, evidenceBlock)).toBe(
      BEHAVIOUR_DOD_UNMET_SIGNATURE,
    )
  })

  it('an ADR-0002 recovery recipe is registered under that exact signature', () => {
    expect(hasRecipe(BEHAVIOUR_DOD_UNMET_SIGNATURE)).toBe(true)
  })

  it('the recipe prompt inlines the evidence block (failed criteria, screenshots, log tail)', () => {
    const recipe = getRecipe(BEHAVIOUR_DOD_UNMET_SIGNATURE)
    const prompt = recipe.buildPrompt({
      targetPath: '/wt',
      statusOutput: evidenceBlock,
      targetBranch: 'task/x',
      originalPrompt: 'build the banner',
    })
    expect(prompt).toContain('the banner renders')
    expect(prompt).toContain('criterion-0.png')
    expect(prompt).toContain('listening on 4000')
    expect(prompt).toContain('build the banner')
    expect(prompt).toContain('Save your work')
  })

  it('the failure-kind registry resolves the signature to a warm card with a recipe ref', () => {
    const kind = lookupFailureKind(BEHAVIOUR_DOD_UNMET_SIGNATURE)
    expect(kind).not.toBeNull()
    expect(kind!.recipe).toBe(BEHAVIOUR_DOD_UNMET_SIGNATURE)
  })

  it("'behaviour-unverified' is a registered action-queue kind", () => {
    expect(ACTION_QUEUE_KINDS).toContain('behaviour-unverified')
    expect(isActionQueueKind('behaviour-unverified')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Worker plumbing: MCP config threading + pinned posture
// ---------------------------------------------------------------------------

describe('BehaviourVerifier Worker + Playwright MCP threading', () => {
  it('WORKER_CONFIGS pins sonnet, headless, read-only tool surface', () => {
    const cfg = WORKER_CONFIGS.BehaviourVerifier
    expect(cfg.model).toBe('claude-sonnet-4-6')
    expect(cfg.runtime).toBe('headless')
    expect(cfg.disallowedTools).toContain('Edit')
    expect(cfg.disallowedTools).toContain('Write')
    expect(cfg.disallowedTools).toContain('NotebookEdit')
  })

  it('codegraphMcpConfigJson merges the playwright server on top of codegraph', () => {
    const json = codegraphMcpConfigJson(
      '/repo',
      playwrightMcpServers('/repo/.mars/behaviour-verify/mars-t1'),
    )
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(parsed.mcpServers.codegraph).toBeDefined()
    expect(parsed.mcpServers.playwright).toBeDefined()
    expect(parsed.mcpServers.playwright.args).toContain('--output-dir')
    expect(parsed.mcpServers.playwright.args).toContain('/repo/.mars/behaviour-verify/mars-t1')
  })

  it('claudeStreamArgs carries the merged config through --mcp-config under --strict-mcp-config', () => {
    const json = codegraphMcpConfigJson('/repo', playwrightMcpServers('/out'))
    const args = claudeStreamArgs('go', { mcpConfig: json })
    const i = args.indexOf('--mcp-config')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toContain('playwright')
    expect(args).toContain('--strict-mcp-config')
  })

  it('the Worker prompt carries the criteria verbatim, the URL, and the verdict contract', () => {
    const prompt = buildBehaviourVerifyPrompt({
      url: 'http://127.0.0.1:5000',
      criteria: ['clicking Save persists the row'],
      artifactsDir: '/art',
    })
    expect(prompt).toContain('http://127.0.0.1:5000')
    expect(prompt).toContain('[0] clicking Save persists the row')
    expect(prompt).toContain(VERDICT_OPEN_TAG)
    expect(prompt).toContain(VERDICT_CLOSE_TAG)
    expect(prompt).toContain('browser_take_screenshot')
  })
})

// ---------------------------------------------------------------------------
// The primitive — all three outcomes + skips, with mocked dev-server / MCP
// ---------------------------------------------------------------------------

interface RecordedEvent {
  kind: string
  payload: Record<string, unknown>
}

const makeTraceStore = (): { store: TraceEventStore; events: RecordedEvent[] } => {
  const events: RecordedEvent[] = []
  const store = {
    record: async (event: { kind: string; payload: Record<string, unknown> }) => {
      events.push({ kind: event.kind, payload: event.payload })
    },
  } as unknown as TraceEventStore
  return { store, events }
}

const makeCtx = (
  input: MarsWorkflowInput,
  traceStore: TraceEventStore,
): MarsCtx =>
  ({
    runId: input.taskId ?? 'mars-behav01',
    input,
    services: { store: {} as never, traceStore },
    emit: () => {},
    currentStep: undefined,
  }) as unknown as MarsCtx

const taskWithSpec = (spec: {
  previewCmd: string | null
  doneCriteria: string[]
}): Task =>
  ({
    id: 'mars-behav01',
    spec: {
      files: [],
      verifyCmd: null,
      previewCmd: spec.previewCmd,
      doneCriteria: spec.doneCriteria,
      taskType: 'auto',
    },
  }) as unknown as Task

const verdictText = (verdicts: CriterionVerdict[]): string =>
  `${VERDICT_OPEN_TAG}${JSON.stringify({ verdicts })}${VERDICT_CLOSE_TAG}`

interface DepsHarness {
  deps: BehaviourVerifyDeps
  captured: { spanExtra: Record<string, unknown> | null }
}

const makeDeps = (args: {
  task: Task | null
  workerFinalText?: string
  workerExitCode?: number
  healthy?: boolean
  existingDraft?: { id: string; title: string } | null
}): DepsHarness => {
  const captured: DepsHarness['captured'] = { spanExtra: null }
  const logPath = join(tmpRepo, 'dev-server.log')
  const deps: BehaviourVerifyDeps = {
    getTask: vi.fn(async () => args.task),
    updateTask: vi.fn(async () => undefined) as unknown as BehaviourVerifyDeps['updateTask'],
    handleTaskFailureWithFixTask: vi.fn(async () => ({ outcome: 'blocked' as const })),
    createProposal: vi.fn(
      async (title: string) => ({ id: 'prop-1', title }) as unknown as Proposal,
    ),
    findOpenDraftByKpiTag: vi.fn(async () => args.existingDraft ?? null),
    raiseActionQueueItem: vi.fn(async () => 'aq-1'),
    startDevServer: vi.fn(async () => ({
      pid: 4242,
      url: 'http://127.0.0.1:5555',
      logPath,
      port: 5555,
    })),
    killDevServer: vi.fn(async () => undefined),
    waitForHealthy: vi.fn(async () => args.healthy ?? true),
    runWorker: vi.fn(async (options: RunWorkerWithSpanOptions) => {
      if (args.workerFinalText !== undefined) {
        await options.runOptions.onEvent?.(resultEvent(args.workerFinalText))
      }
      captured.spanExtra = options.getExtraPayload?.() ?? null
      const result: RunClaudeResult = {
        exitCode: args.workerExitCode ?? 0,
        stdout: '',
        stderr: '',
        sessionId: 'sess-1',
        conversation: [],
        quotaRejected: null,
      }
      return result
    }) as unknown as BehaviourVerifyDeps['runWorker'],
    readLogTail: vi.fn(async () => 'dev server said hello'),
  }
  return { deps, captured }
}

const WORKTREE = { path: '/tmp/wt-behav', branch: 'task/mars-behav01' }

describe('behaviourVerify — PASS', () => {
  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
  })

  it('all criteria positively verified → returns pass, tears down the dev server, no self-heal', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps, captured } = makeDeps({
      task: taskWithSpec({ previewCmd: 'npm run dev', doneCriteria: ['banner renders'] }),
      workerFinalText: verdictText([v(0, 'pass', 'criterion-0.png')]),
    })

    const result = await behaviourVerify(ctx, {
      worktree: WORKTREE,
      deps,
    })

    expect(result.outcome).toBe('pass')
    expect(result.reason).toBeNull()
    expect(result.verdicts).toHaveLength(1)
    // Artifact attachment: relative evidence resolves into the artifact dir.
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].type).toBe('screenshot')
    expect(result.artifacts[0].path).toBe(
      resolve(tmpRepo, '.mars', 'behaviour-verify', 'mars-behav01', 'criterion-0.png'),
    )
    expect(result.artifacts[0].criterionIndex).toBe(0)
    expect(result.devServerLogPath).not.toBeNull()

    // The step_ended payload (via getExtraPayload) carries outcome + evidence.
    expect(captured.spanExtra).not.toBeNull()
    expect(captured.spanExtra!.behaviourVerifyOutcome).toBe('pass')
    expect(captured.spanExtra!.devServerLogPath).toBe(result.devServerLogPath)
    expect(captured.spanExtra!.artifacts).toEqual(result.artifacts)
    expect(captured.spanExtra!.verdicts).toEqual(result.verdicts)

    // Lifecycle + never-silent bookkeeping.
    expect(deps.killDevServer).toHaveBeenCalledWith(4242)
    expect(deps.handleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(deps.updateTask).not.toHaveBeenCalled()
    expect(deps.raiseActionQueueItem).not.toHaveBeenCalled()
    expect(deps.createProposal).not.toHaveBeenCalled()
  })
})

describe('behaviourVerify — behavioural FAIL', () => {
  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
  })

  it('an evidenced contradiction stamps the task failed, spawns ONE recovery under the registered signature, and throws', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({
        previewCmd: 'npm run dev',
        doneCriteria: ['banner renders', 'save button persists'],
      }),
      workerFinalText: verdictText([
        v(0, 'pass', 'criterion-0.png'),
        v(1, 'fail', 'criterion-1.png'),
      ]),
    })

    await expect(
      behaviourVerify(ctx, { worktree: WORKTREE, deps }),
    ).rejects.toThrow(/behaviour-verify:dod-unmet/)

    // Task stamped failed exactly like static verify.
    expect(deps.updateTask).toHaveBeenCalledTimes(1)
    const updateArgs = vi.mocked(deps.updateTask).mock.calls[0]
    expect(updateArgs[0]).toBe('mars-behav01')
    expect(updateArgs[1]).toMatchObject({
      status: 'failed',
      failedPhase: 'verify',
      failureReason: BEHAVIOUR_VERIFY_FAILING_STEP,
      failureSignature: BEHAVIOUR_DOD_UNMET_SIGNATURE,
    })

    // Exactly one recovery spawn through the standard handler.
    expect(deps.handleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    const failureInput = vi.mocked(deps.handleTaskFailureWithFixTask).mock.calls[0][0]
    expect(failureInput.failingStep).toBe(BEHAVIOUR_VERIFY_FAILING_STEP)
    // The recovery prompt context inlines ONLY the failed criterion with its
    // evidence path and the dev-server log tail.
    expect(failureInput.recipeContext?.statusOutput).toContain('save button persists')
    expect(failureInput.recipeContext?.statusOutput).toContain('criterion-1.png')
    expect(failureInput.recipeContext?.statusOutput).toContain('dev server said hello')
    expect(failureInput.recipeContext?.statusOutput).not.toContain('[0] banner renders')
    // The first line binds to the registered recipe.
    expect(classifyError(failureInput.errorOutput)).toBe('dod-unmet')

    // No CAN'T-VERIFY surface fired, and the dev server was torn down.
    expect(deps.raiseActionQueueItem).not.toHaveBeenCalled()
    expect(deps.createProposal).not.toHaveBeenCalled()
    expect(deps.killDevServer).toHaveBeenCalledWith(4242)
  })
})

describe("behaviourVerify — CAN'T-VERIFY", () => {
  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
  })

  it('no preview command (the no-UI-surface branch): no browser, draft + alert, merge proceeds', async () => {
    const { store, events } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ previewCmd: null, doneCriteria: ['banner renders'] }),
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('no-preview-command')

    // Never launched a surface or a browser.
    expect(deps.startDevServer).not.toHaveBeenCalled()
    expect(deps.runWorker).not.toHaveBeenCalled()

    // Fingerprinted draft proposal.
    expect(deps.findOpenDraftByKpiTag).toHaveBeenCalledWith(
      behaviourUnverifiedFingerprint('mars-behav01'),
    )
    expect(deps.createProposal).toHaveBeenCalledTimes(1)
    const [title, opts] = vi.mocked(deps.createProposal).mock.calls[0]
    expect(title).toBe('Make task mars-behav01 behaviourally verifiable')
    expect(opts?.kpiTag).toBe(behaviourUnverifiedFingerprint('mars-behav01'))
    expect(opts?.author).toEqual({ kind: 'agent', name: 'behaviour-verifier' })

    // Level-triggered action-queue row linking task ↔ proposal.
    expect(deps.raiseActionQueueItem).toHaveBeenCalledTimes(1)
    const raised = vi.mocked(deps.raiseActionQueueItem).mock.calls[0][0]
    expect(raised.kind).toBe('behaviour-unverified')
    expect(raised.originTaskId).toBe('mars-behav01')
    expect(raised.payload.proposalId).toBe('prop-1')
    expect(raised.payload.reason).toBe('no-preview-command')

    // Never a hard fail.
    expect(deps.updateTask).not.toHaveBeenCalled()
    expect(deps.handleTaskFailureWithFixTask).not.toHaveBeenCalled()

    // The span records the outcome even though no Worker ran.
    const ended = events.find(
      (e) =>
        e.kind === 'step_ended' &&
        e.payload.stepName === BEHAVIOUR_VERIFY_STEP_NAME,
    )
    expect(ended).toBeDefined()
    expect(ended!.payload.behaviourVerifyOutcome).toBe('unverifiable:no-preview-command')
  })

  it('deduplicates the draft on the behaviour-verify:<originId> fingerprint (re-runs never fan out siblings)', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ previewCmd: null, doneCriteria: ['x'] }),
      existingDraft: { id: 'prop-existing', title: 'already filed' },
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(deps.createProposal).not.toHaveBeenCalled()
    const raised = vi.mocked(deps.raiseActionQueueItem).mock.calls[0][0]
    expect(raised.payload.proposalId).toBe('prop-existing')
  })

  it('empty Definition of Done → unverifiable (no-done-criteria) without booting a server', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ previewCmd: 'npm run dev', doneCriteria: [] }),
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('no-done-criteria')
    expect(deps.startDevServer).not.toHaveBeenCalled()
    expect(deps.raiseActionQueueItem).toHaveBeenCalledTimes(1)
  })

  it('dev server never answers its health check → unverifiable, server killed, worker never dispatched', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ previewCmd: 'npm run dev', doneCriteria: ['x'] }),
      healthy: false,
    })

    const result = await behaviourVerify(ctx, {
      worktree: WORKTREE,
      healthCheckTimeoutMs: 10,
      deps,
    })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('dev-server-unhealthy')
    expect(deps.runWorker).not.toHaveBeenCalled()
    expect(deps.killDevServer).toHaveBeenCalledWith(4242)
    expect(deps.raiseActionQueueItem).toHaveBeenCalledTimes(1)
    expect(deps.handleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })

  it('worker emits no parseable verdict JSON → unverifiable (verdict-unparseable), never an inferred pass', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps, captured } = makeDeps({
      task: taskWithSpec({ previewCmd: 'npm run dev', doneCriteria: ['x'] }),
      workerFinalText: 'Looks good to me — everything passed!',
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('verdict-unparseable')
    expect(captured.spanExtra!.behaviourVerifyOutcome).toBe(
      'unverifiable:verdict-unparseable',
    )
    expect(deps.raiseActionQueueItem).toHaveBeenCalledTimes(1)
    expect(deps.handleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(deps.killDevServer).toHaveBeenCalledWith(4242)
  })

  it('only-unverifiable verdicts (pure backend criteria) → unverifiable (no-exercisable-criteria), merge proceeds', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ previewCmd: 'npm run dev', doneCriteria: ['db row appears'] }),
      workerFinalText: verdictText([v(0, 'unverifiable')]),
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('no-exercisable-criteria')
    expect(deps.raiseActionQueueItem).toHaveBeenCalledTimes(1)
    expect(deps.updateTask).not.toHaveBeenCalled()
  })
})

describe('behaviourVerify — skips', () => {
  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
  })

  it('diagnose Chores short-circuit as skipped with zero side effects', async () => {
    const { store, events } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'diagnose' }, store)
    const { deps } = makeDeps({ task: null })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('skipped')
    expect(result.reason).toBe('diagnose')
    expect(deps.getTask).not.toHaveBeenCalled()
    expect(deps.startDevServer).not.toHaveBeenCalled()
    expect(deps.raiseActionQueueItem).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Artifact plumbing units
// ---------------------------------------------------------------------------

describe('buildArtifacts', () => {
  it('resolves relative evidence into the artifact dir and keeps absolute paths', () => {
    const artifacts = buildArtifacts(
      [v(0, 'pass', 'criterion-0.png'), v(1, 'fail', '/abs/shot.png'), v(2, 'unverifiable', null)],
      '/art/mars-x',
    )
    expect(artifacts).toEqual([
      { type: 'screenshot', path: '/art/mars-x/criterion-0.png', criterionIndex: 0, verdict: 'pass' },
      { type: 'screenshot', path: '/abs/shot.png', criterionIndex: 1, verdict: 'fail' },
    ])
  })
})

describe('runNonLlmStepWithSpan — getExtraPayload lands on step_ended (artifact seam for non-worker branches)', () => {
  it('spreads the extra payload into the success step_ended payload', async () => {
    const { store, events } = makeTraceStore()
    await runNonLlmStepWithSpan({
      stepName: BEHAVIOUR_VERIFY_STEP_NAME,
      workflowInstanceId: 'wf-1',
      originId: 'mars-behav01',
      taskId: 'mars-behav01',
      phase: 'verify',
      traceStore: store,
      getExtraPayload: () => ({
        behaviourVerifyOutcome: 'unverifiable:no-preview-command',
        artifacts: [],
      }),
      fn: async () => 'ok',
    })
    const ended = events.find((e) => e.kind === 'step_ended')
    expect(ended).toBeDefined()
    expect(ended!.payload.behaviourVerifyOutcome).toBe('unverifiable:no-preview-command')
    expect(ended!.payload.outcome).toBe('completed')
  })
})
