import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
} from '../../../core/lib/action-queue-kinds'
import {
  claudeStreamArgs,
  codegraphMcpConfigJson,
} from '../../../core/lib/git/claude'
import {
  WORKER_CONFIGS,
  WORKER_PROVIDER,
  providerModel,
} from '../../../core/workers'
import {
  runNonLlmStepWithSpan,
} from '../../../core/lib/run-worker-with-span'
import { __resetContextCacheForTests } from '../../../core/context'
import type { Task } from '../../../core/queue'
import type { Proposal } from '../../../core/proposals'
import type { ClaudeEvent } from '../../../core/lib/claude-stream'
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
// Worker plumbing: pinned posture + no shipped MCP dependency
// ---------------------------------------------------------------------------

describe('BehaviourVerifier Worker — pinned posture, no shipped MCP dependency', () => {
  it('WORKER_CONFIGS pins the balanced provider tier, headless, read-only tool surface', () => {
    const cfg = WORKER_CONFIGS.BehaviourVerifier
    expect(cfg.model).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
    expect(cfg.runtime).toBe('headless')
    expect(cfg.disallowedTools).toContain('Edit')
    expect(cfg.disallowedTools).toContain('Write')
    expect(cfg.disallowedTools).toContain('NotebookEdit')
  })

  it('WORKER_CONFIGS.BehaviourVerifier has no pinned mcpConfig — no MCP server is shipped by the framework', () => {
    // The framework must not inject any browser/UI-driving MCP server.
    // Operators wire their own tools; if none are present the existing
    // CAN'T-VERIFY path fires and merge still proceeds.
    expect(WORKER_CONFIGS.BehaviourVerifier.mcpConfig).toBeUndefined()
  })

  it('claudeStreamArgs always includes --strict-mcp-config; --mcp-config is absent without extra servers', () => {
    // When no extra servers are provided the framework emits no --mcp-config
    // flag at all — only --strict-mcp-config. The operator's environment
    // may supply servers via their own Claude Code MCP config.
    const args = claudeStreamArgs('go', {})
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
  })

  it('codegraphMcpConfigJson merges operator-supplied servers on top of codegraph when provided', () => {
    // When an operator DOES pin extra servers, codegraphMcpConfigJson merges
    // them cleanly. This path is available for operator use; the framework
    // itself no longer calls it for BehaviourVerifier.
    const json = codegraphMcpConfigJson('/repo', {
      'my-browser': { type: 'stdio', command: 'my-browser-tool', args: [] },
    })
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(parsed.mcpServers.codegraph).toBeDefined()
    expect(parsed.mcpServers['my-browser']).toBeDefined()
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
    services: { store: { setQaReport: vi.fn(async () => {}) } as never, traceStore },
    emit: () => {},
    currentStep: undefined,
  }) as unknown as MarsCtx

const taskWithSpec = (spec: {
  doneCriteria: string[]
}): Task =>
  ({
    id: 'mars-behav01',
    spec: {
      files: [],
      verifyCmd: null,
      doneCriteria: spec.doneCriteria,
      mergeMode: 'auto',
    },
  }) as unknown as Task

interface DepsHarness {
  deps: BehaviourVerifyDeps
}

const makeDeps = (args: {
  task: Task | null
  existingDraft?: { id: string; title: string } | null
  /** Simulated git diff --name-only output; defaults to empty (no UI files). */
  diff?: string
}): DepsHarness => {
  const deps: BehaviourVerifyDeps = {
    getTask: vi.fn(async () => args.task),
    createProposal: vi.fn(
      async (title: string) => ({ id: 'prop-1', title }) as unknown as Proposal,
    ),
    findOpenDraftByKpiTag: vi.fn(async () => args.existingDraft ?? null),
    raiseActionQueueItem: vi.fn(async () => 'aq-1'),
    getDiff: vi.fn(async () => args.diff ?? ''),
    // Stub out the browser check so tests never start a real dev server or
    // browser. Returns all-unverifiable results immediately.
    runBrowserCheck: vi.fn(async (_boot, criteria) =>
      [...criteria].map((criterion: string) => ({
        criterion,
        verdict: 'unverifiable' as const,
        screenshotPath: null,
        note: 'mocked: no real browser in unit tests',
      })),
    ),
    // Not triggered in these tests (all browser results are 'unverifiable');
    // stub prevents TS error and guards against accidental calls.
    handleTaskFailure: vi.fn(async () => ({ outcome: 'noop' as const })),
  }
  return { deps }
}

const WORKTREE = { path: '/tmp/wt-behav', branch: 'task/mars-behav01' }

describe("behaviourVerify — CAN'T-VERIFY", () => {
  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
  })

  it('no preview command (the no-UI-surface branch): draft + alert, merge proceeds', async () => {
    const { store, events } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ doneCriteria: ['banner renders'] }),
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('no-preview-command')

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
      task: taskWithSpec({ doneCriteria: ['x'] }),
      existingDraft: { id: 'prop-existing', title: 'already filed' },
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(deps.createProposal).not.toHaveBeenCalled()
    const raised = vi.mocked(deps.raiseActionQueueItem).mock.calls[0][0]
    expect(raised.payload.proposalId).toBe('prop-existing')
  })

  it('empty Definition of Done → unverifiable (no-done-criteria)', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ doneCriteria: [] }),
    })

    const result = await behaviourVerify(ctx, { worktree: WORKTREE, deps })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('no-done-criteria')
    expect(deps.raiseActionQueueItem).toHaveBeenCalledTimes(1)
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

// ---------------------------------------------------------------------------
// Boot discovery integration — discoverAppBoot wired into behaviourVerify
// ---------------------------------------------------------------------------

describe('behaviourVerify — boot discovery from repo signals', () => {
  let viteRepoRoot: string

  beforeEach(() => {
    __resetContextCacheForTests()
    process.env.MARS_REPO = tmpRepo
    viteRepoRoot = mkdtempSync(join(tmpdir(), 'mars-boot-disc-bv-'))
    // Create a minimal Vite project so discoverAppBoot can detect it.
    writeFileSync(join(viteRepoRoot, 'vite.config.ts'), '')
  })

  afterEach(() => {
    rmSync(viteRepoRoot, { recursive: true, force: true })
  })

  it('bootPlan is recorded on the run when diff touches UI files and boot is discoverable', async () => {
    const { store, events } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ doneCriteria: ['banner renders on the home page'] }),
      diff: 'ui/src/App.tsx\nui/src/styles.css\n',
    })

    const result = await behaviourVerify(ctx, {
      worktree: { path: viteRepoRoot, branch: 'task/mars-behav01' },
      deps,
    })

    // Still CAN'T-VERIFY because no server was actually started, but the
    // bootPlan carries the discovered command and URL.
    expect(result.outcome).toBe('unverifiable')
    expect(result.bootPlan).not.toBeNull()
    expect(result.bootPlan!.cmd).toBe('npm run dev')
    expect(result.bootPlan!.url).toBe('http://localhost:5173')
    expect(result.bootPlan!.reason).toContain('vite')

    // The span payload also carries the bootPlan (readable via the HTTP API).
    const ended = events.find(
      (e) => e.kind === 'step_ended' && e.payload.stepName === BEHAVIOUR_VERIFY_STEP_NAME,
    )
    expect(ended).toBeDefined()
    expect(ended!.payload.bootPlan).not.toBeNull()
    const bootPlanOnSpan = ended!.payload.bootPlan as { cmd: string; url: string; reason: string }
    expect(bootPlanOnSpan.cmd).toBe('npm run dev')
    expect(bootPlanOnSpan.url).toBe('http://localhost:5173')
  })

  it('bootPlan is null when diff has no UI files — boot discovery is skipped entirely', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ doneCriteria: ['API returns 200'] }),
      diff: 'orchestrator/src/core/queue.ts\npackage.json\n',
    })

    const result = await behaviourVerify(ctx, {
      worktree: { path: viteRepoRoot, branch: 'task/mars-behav01' },
      deps,
    })

    expect(result.outcome).toBe('unverifiable')
    expect(result.bootPlan).toBeNull()
    // getDiff should have been called once to inspect the diff.
    expect(deps.getDiff).toHaveBeenCalledTimes(1)
  })

  it('getDiff is NOT called when criteria list is empty (short-circuit before diff)', async () => {
    const { store } = makeTraceStore()
    const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
    const { deps } = makeDeps({
      task: taskWithSpec({ doneCriteria: [] }),
    })

    const result = await behaviourVerify(ctx, {
      worktree: { path: viteRepoRoot, branch: 'task/mars-behav01' },
      deps,
    })

    expect(result.outcome).toBe('unverifiable')
    expect(result.reason).toBe('no-done-criteria')
    expect(result.bootPlan).toBeNull()
    expect(deps.getDiff).not.toHaveBeenCalled()
  })

  it('bootPlan is null when UI diff is detected but no boot command found in the repo', async () => {
    // Empty repo — no vite.config, no package.json.
    const emptyRepoRoot = mkdtempSync(join(tmpdir(), 'mars-boot-empty-'))
    try {
      const { store } = makeTraceStore()
      const ctx = makeCtx({ taskId: 'mars-behav01', kind: 'task' }, store)
      const { deps } = makeDeps({
        task: taskWithSpec({ doneCriteria: ['form submits successfully'] }),
        diff: 'ui/src/Form.tsx\n',
      })

      const result = await behaviourVerify(ctx, {
        worktree: { path: emptyRepoRoot, branch: 'task/mars-behav01' },
        deps,
      })

      expect(result.outcome).toBe('unverifiable')
      expect(result.bootPlan).toBeNull()
    } finally {
      rmSync(emptyRepoRoot, { recursive: true, force: true })
    }
  })
})
