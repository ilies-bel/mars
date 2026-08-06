/**
 * Arc-outcome verifier (ADR-XXXX).
 *
 * After the last task of an arc merges into the integration branch the daemon
 * fires the selected provider's fast-tier headless agent against main that:
 *   1. Re-runs each task's verifyCmd where present.
 *   2. Spot-checks the arc's done criteria against the actual merged diff.
 *   3. Returns a structured verdict { ok, findings[] }.
 *
 * On a failing verdict one `arc-verification-failed` action-queue item is raised
 * (deduped per originId; the operator decides the remediation). On a passing
 * verdict the outcome is recorded as a trace event for the Studio timeline.
 *
 * When the E2E tooling environment is not configured a single global
 * `e2e-tooling-missing` action-queue item is raised (deduped across all arcs
 * via a fixed signature). It auto-resolves when the tooling probe succeeds.
 *
 * `MARS_ARC_VERIFY_DISABLED=1` suppresses all runs. This is an environment-
 * level emergency escape hatch during incident storms.
 *
 * Concurrency: the daemon owns arc-verifier admission and execution through its
 * tracked worker pool. This module only performs the synchronous kill-switch and
 * dedup admission checks.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getDefaultTaskStore, type ArcStatusOptions } from '../store/task-store.js'
import { raiseActionQueueItem, listActionQueueItems, setActionQueueState } from './action-queue.js'
import { runHeadlessProvider } from '../workers/providers.js'
import { collectAssistantText } from './reflector.js'
import { getProposal } from '../proposals.js'
import { probeE2eTooling } from './e2e-tooling.js'
import { acquireLock } from './git/lock.js'
import { discoverAppBoot, type BootPlan } from '../../workflows/primitives/app-boot-discovery.js'
import { runBrowserCheck, type CriterionResult } from '../../workflows/primitives/browser-check.js'

const execFileAsync = promisify(execFile)

/** Maximum characters to include from the merged diff sent to the verifier. */
const DIFF_SIZE_CAP = 8_000

/** Maximum characters to include from a verifyCmd's output in the prompt. */
const VERIFY_CMD_OUTPUT_CAP = 2_000


/**
 * In-memory dedup set. Once an originId has been triggered for verification
 * it is never triggered again in the same daemon process. Never cleared in
 * production; cleared between tests via {@link _clearTriggeredForTests}.
 */
export const triggeredOriginIds = new Set<string>()

/** For test isolation ONLY. Never call in production. */
export const _clearTriggeredForTests = (): void => {
  triggeredOriginIds.clear()
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD reachability context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The PRD-level reachability data the arc-verifier needs to judge whether
 * promised surfaces were delivered. Populated from the source Proposal when
 * the arc was produced by `mars proposal slice`; empty for task-originated
 * arcs that have no source Proposal.
 */
export interface PrdReachabilityContext {
  userStories: string[]
  outOfScope: string[]
  sourceProposalId: string | null
}

/**
 * Load the PRD reachability context for the given arc.
 *
 * For a Proposal Arc, `arcId` IS the proposal id (each slice task carries
 * `origin_id = proposalId`). The proposal row is looked up directly; its
 * `userStories` list and `out_of_scope` text (split into non-empty lines)
 * are returned verbatim.
 *
 * For a task-originated arc, `arcId` is a task id with no matching proposal
 * row, so empty arrays and a null `sourceProposalId` are returned.
 *
 * Never throws — a lookup failure is treated as "no source proposal".
 */
export async function loadPrdReachabilityContext(
  arcId: string,
): Promise<PrdReachabilityContext> {
  const proposal = await getProposal(arcId).catch(() => null)
  if (proposal === null) {
    return { userStories: [], outOfScope: [], sourceProposalId: null }
  }
  const outOfScope = proposal.outOfScope
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return {
    userStories: proposal.userStories,
    outOfScope,
    sourceProposalId: proposal.id,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill-switch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns `true` when `MARS_ARC_VERIFY_DISABLED=1` is set in the daemon.
 */
export const isArcVerifyDisabled = (): boolean =>
  process.env.MARS_ARC_VERIFY_DISABLED === '1'

// ─────────────────────────────────────────────────────────────────────────────
// Arc-level E2E pass types + injectable deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of the arc-level E2E browser pass.
 *
 * `ran: false` means the pass was skipped; `cantVerifyReason` explains why.
 * `ran: true` means the pass executed and `criterionResults` holds evidence.
 * The pass NEVER fails the arc — it only captures evidence.
 */
export interface ArcE2ePassResult {
  ran: boolean
  cantVerifyReason: 'no-criteria' | 'no-boot-plan' | 'already-done' | null
  criterionResults: CriterionResult[]
}

/**
 * Injectable side-effect seams for the arc-level E2E pass.
 * Override in tests so no real filesystem, lock, or browser is needed.
 */
export interface ArcE2eDeps {
  discoverAppBoot: (repoRoot: string) => BootPlan | null
  runBrowserCheck: (
    bootPlan: BootPlan,
    criteria: readonly string[],
    opts: { taskId: string; worktreeDir: string; logDir: string },
  ) => Promise<CriterionResult[]>
  acquireLock: (lockPath: string, timeoutMs: number) => Promise<() => Promise<void>>
  isE2ePassDone: (originId: string, marsStateDir: string) => boolean
  markE2ePassDone: (originId: string, marsStateDir: string) => Promise<void>
}

/** How long to wait for the machine-wide E2E lock before giving up. */
const E2E_LOCK_TIMEOUT_MS = 300_000

const defaultArcE2eDeps: ArcE2eDeps = {
  discoverAppBoot,
  runBrowserCheck: (bootPlan, criteria, opts) => runBrowserCheck(bootPlan, criteria, opts),
  acquireLock,
  isE2ePassDone: (originId, marsStateDir) =>
    existsSync(join(marsStateDir, 'e2e-passes', `${originId}.done`)),
  markE2ePassDone: async (originId, marsStateDir) => {
    const dir = join(marsStateDir, 'e2e-passes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${originId}.done`), '')
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict type
// ─────────────────────────────────────────────────────────────────────────────

export interface ArcVerificationVerdict {
  ok: boolean
  findings: string[]
  e2ePass?: ArcE2ePassResult
}

// ─────────────────────────────────────────────────────────────────────────────
// Reachable-surface judgement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured output the reachability LLM call returns.
 *
 * - `unsatisfiedStories`: stories that have NO Reachable surface (UI affordance,
 *   CLI command, or bot command) AND are not covered by an out-of-scope entry.
 * - `deferredStories`: stories that are textually covered by an out-of-scope entry.
 *
 * Satisfied stories appear in neither array.
 */
export interface ReachabilityJudgement {
  unsatisfiedStories: Array<{ story: string; humanCannotDo: string }>
  deferredStories: string[]
}

/**
 * Judge whether each user story in `userStories` has a Reachable surface
 * (UI affordance, CLI command, or bot command) in the merged diff.
 *
 * Returns immediately with empty arrays when `userStories` is empty.
 *
 * An API route, a passing test, or a database column alone does NOT satisfy
 * a user story.  Stories covered textually by `outOfScope` entries are
 * classified as deferred and produce no finding.
 */
export async function judgeReachableSurfaces(opts: {
  userStories: string[]
  outOfScope: string[]
  diff: string
  cwd: string
}): Promise<ReachabilityJudgement> {
  const { userStories, outOfScope, diff, cwd } = opts
  if (userStories.length === 0) {
    return { unsatisfiedStories: [], deferredStories: [] }
  }

  const promptParts: string[] = [
    'You are an arc-outcome verifier judging whether promised user surfaces were delivered.',
    '',
    'A user story is SATISFIED only when the merged diff contains a Reachable surface:',
    '  - A UI affordance (a page, button, form, screen, or route visible to the user), OR',
    '  - A CLI command a human can run, OR',
    '  - A bot command a human can invoke.',
    '',
    'The following do NOT satisfy a user story on their own:',
    '  - An API route or HTTP endpoint',
    '  - A passing test or spec',
    '  - A database column or table',
    '',
    'A user story is DEFERRED when it is textually covered by one of the',
    'out-of-scope entries below.',
    '',
    'Return ONLY a JSON object on a single line with this exact shape:',
    '  {"unsatisfiedStories":[{"story":"<text>","humanCannotDo":"<what a human still cannot do>"}],"deferredStories":["<text>"]}',
    '- unsatisfiedStories: stories that have NO Reachable surface and are NOT deferred.',
    '- deferredStories: stories textually covered by an out-of-scope entry.',
    '- Satisfied stories appear in neither array.',
    '',
    '## User stories',
    ...userStories.map((s) => `  - ${s}`),
  ]

  if (outOfScope.length > 0) {
    promptParts.push('', '## Out of scope')
    promptParts.push(...outOfScope.map((s) => `  - ${s}`))
  }

  if (diff.length > 0) {
    promptParts.push('', '## Merged diff (size-capped)')
    promptParts.push('```diff')
    promptParts.push(diff)
    promptParts.push('```')
  }

  promptParts.push('', 'Return ONLY the JSON object. No other text.')
  const prompt = promptParts.join('\n')

  const agentResult = await runHeadlessProvider(prompt, {
    cwd,
    modelTier: 'fast',
    timeoutMs: 60_000,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  })
  const rawText = collectAssistantText(agentResult.conversation) || agentResult.stdout

  // Extract the outermost JSON object.  Use a depth-counting scan instead of a
  // regex so nested `{…}` objects inside `unsatisfiedStories` are handled correctly.
  const start = rawText.indexOf('{')
  if (start === -1) return { unsatisfiedStories: [], deferredStories: [] }

  let depth = 0
  let inString = false
  let escape = false
  let end = -1
  for (let i = start; i < rawText.length; i++) {
    const c = rawText[i]
    if (escape) { escape = false; continue }
    if (c === '\\' && inString) { escape = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return { unsatisfiedStories: [], deferredStories: [] }

  try {
    const parsed = JSON.parse(rawText.slice(start, end + 1)) as {
      unsatisfiedStories?: unknown
      deferredStories?: unknown
    }
    return {
      unsatisfiedStories: Array.isArray(parsed.unsatisfiedStories)
        ? parsed.unsatisfiedStories.filter(
            (s): s is { story: string; humanCannotDo: string } =>
              typeof s === 'object' &&
              s !== null &&
              typeof (s as Record<string, unknown>).story === 'string' &&
              typeof (s as Record<string, unknown>).humanCannotDo === 'string',
          )
        : [],
      deferredStories: Array.isArray(parsed.deferredStories)
        ? parsed.deferredStories.filter((s): s is string => typeof s === 'string')
        : [],
    }
  } catch {
    return { unsatisfiedStories: [], deferredStories: [] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function runVerifyCmd(
  cmd: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', cmd], {
      cwd,
      timeout: 120_000,
    })
    return { ok: true, output: (stdout + stderr).slice(0, VERIFY_CMD_OUTPUT_CAP) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output =
      ((e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')).slice(
        0,
        VERIFY_CMD_OUTPUT_CAP,
      )
    return { ok: false, output }
  }
}

async function getMergedDiff(
  landedCommits: readonly string[],
  cwd: string,
): Promise<string> {
  if (landedCommits.length === 0) return ''
  const base = landedCommits[0]
  const tip = landedCommits[landedCommits.length - 1]
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', `${base}^`, tip, '--', '.'],
      { cwd, timeout: 30_000 },
    )
    return stdout.slice(0, DIFF_SIZE_CAP)
  } catch {
    return ''
  }
}

function buildVerifierPrompt(
  originId: string,
  arcTasks: Array<{
    id: string
    prompt: string
    doneCriteria: readonly string[]
    verifyCmd: string | null
  }>,
  verifyCmdResults: Array<{
    taskId: string
    cmd: string
    ok: boolean
    output: string
  }>,
  diff: string,
  prdContext: PrdReachabilityContext,
): string {
  const parts: string[] = [
    `You are an arc-outcome verifier. Arc origin id: ${originId}`,
    '',
    'Your job: determine whether the merged result satisfies all of the arc\'s',
    'done criteria and verify commands. Be strict — partial completion is a failure.',
    '',
    'Return ONLY a JSON object on a single line with this exact shape:',
    '  {"ok": <boolean>, "findings": [<string>, ...]}',
    '- ok: true if every criterion is satisfied and every verifyCmd passed.',
    '- findings: concise list of failures (empty array when ok is true).',
    '',
    '## Arc tasks',
  ]

  for (const t of arcTasks) {
    parts.push(`### Task ${t.id}`)
    parts.push(`Prompt (truncated): ${t.prompt.slice(0, 400)}`)
    if (t.doneCriteria.length > 0) {
      parts.push('Done criteria:')
      for (const c of t.doneCriteria) parts.push(`  - ${c}`)
    }
    if (t.verifyCmd) parts.push(`Verify command: ${t.verifyCmd}`)
  }

  if (verifyCmdResults.length > 0) {
    parts.push('', '## Verify command results')
    for (const r of verifyCmdResults) {
      parts.push(`Task ${r.taskId}: \`${r.cmd}\` → ${r.ok ? 'PASS (exit 0)' : 'FAIL (non-zero exit)'}`)
      if (!r.ok && r.output.length > 0) {
        parts.push('Output:')
        parts.push('```')
        parts.push(r.output)
        parts.push('```')
      }
    }
  }

  if (diff.length > 0) {
    parts.push('', '## Merged diff (size-capped)')
    parts.push('```diff')
    parts.push(diff)
    parts.push('```')
  }

  if (prdContext.sourceProposalId !== null) {
    parts.push('', '## PRD context')
    parts.push(`Source proposal: ${prdContext.sourceProposalId}`)
    if (prdContext.userStories.length > 0) {
      parts.push('', 'User stories:')
      for (const story of prdContext.userStories) parts.push(`  - ${story}`)
    }
    if (prdContext.outOfScope.length > 0) {
      parts.push('', 'Out of scope:')
      for (const item of prdContext.outOfScope) parts.push(`  - ${item}`)
    }
  }

  parts.push('', 'Return ONLY the JSON object. No other text.')
  return parts.join('\n')
}

function parseVerdict(text: string): ArcVerificationVerdict {
  const jsonMatch = text.match(/\{[\s\S]*?\}/)
  if (!jsonMatch) {
    return {
      ok: false,
      findings: [
        `Verifier returned unparseable output: ${text.slice(0, 200)}`,
      ],
    }
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      ok?: unknown
      findings?: unknown
    }
    return {
      ok: typeof parsed.ok === 'boolean' ? parsed.ok : false,
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.filter((f): f is string => typeof f === 'string')
        : [],
    }
  } catch {
    return {
      ok: false,
      findings: [
        `Verifier returned malformed JSON: ${text.slice(0, 200)}`,
      ],
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core verification logic
// ─────────────────────────────────────────────────────────────────────────────

/** Global action-queue signature for the E2E tooling alert (not per-arc). */
const E2E_TOOLING_SIGNATURE = 'e2e-tooling-missing'

/**
 * Run the arc-outcome verification for the given `originId`.
 *
 * Skips silently when the arc has not fully completed with at least one
 * merged commit (e.g. still in-progress or fully failed). This is the
 * testable core — it does NOT check the dedup set or the kill-switch;
 * those are enforced by {@link triggerArcVerification}.
 *
 * After the static spot-check, probes the E2E tooling environment. When the
 * tooling is unavailable, exactly one global `e2e-tooling-missing` action-queue
 * item is raised (deduped across all arcs via a fixed signature). When the
 * tooling is available, any open alert is auto-resolved. The arc is never
 * failed for missing E2E infra.
 *
 * @returns The verifier's verdict. When the arc has no landed commits or
 *   is not `arc-done`, returns `{ ok: true, findings: [] }` (no-op).
 */
export async function runArcVerification(
  originId: string,
  opts: {
    cwd: string
    integrationBranch?: string
    e2eDeps?: Partial<ArcE2eDeps>
  },
): Promise<ArcVerificationVerdict> {
  const store = await getDefaultTaskStore()
  const arcStatus = await store.arcStatus(originId, {
    cwd: opts.cwd,
    integrationBranch: opts.integrationBranch,
  })

  // Only verify arcs that completed with at least one merged commit.
  if (arcStatus.status !== 'arc-done' || arcStatus.landedCommits.length === 0) {
    return { ok: true, findings: [] }
  }

  // Collect task data for the verifier prompt.
  const arcMembers = await store.listArcMembers(originId)
  const tasks = await Promise.all(arcMembers.map((m) => store.getTask(m.id)))
  const doneTasks = tasks.filter(
    (t): t is NonNullable<typeof t> => t !== null && t.status === 'done',
  )

  const arcTaskData = doneTasks.map((t) => ({
    id: t.id,
    prompt: t.prompt,
    doneCriteria: t.spec?.doneCriteria ?? ([] as readonly string[]),
    verifyCmd: t.spec?.verifyCmd ?? null,
  }))

  // Run verify commands (outside Claude; results are passed to the prompt).
  const verifyCmdResults: Array<{
    taskId: string
    cmd: string
    ok: boolean
    output: string
  }> = []
  for (const task of arcTaskData) {
    if (task.verifyCmd) {
      const r = await runVerifyCmd(task.verifyCmd, opts.cwd)
      verifyCmdResults.push({ taskId: task.id, cmd: task.verifyCmd, ...r })
    }
  }

  // Get the merged diff (best-effort; empty string if git fails).
  const diff = await getMergedDiff(arcStatus.landedCommits, opts.cwd)

  // Load PRD reachability context (populated for Proposal Arcs, empty for task arcs).
  const prdContext = await loadPrdReachabilityContext(originId)

  // Build the verifier prompt and call the provider's fast-tier agent.
  const prompt = buildVerifierPrompt(originId, arcTaskData, verifyCmdResults, diff, prdContext)
  const agentResult = await runHeadlessProvider(prompt, {
    cwd: opts.cwd,
    modelTier: 'fast',
    timeoutMs: 120_000,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  })
  const rawText = collectAssistantText(agentResult.conversation) || agentResult.stdout
  let verdict = parseVerdict(rawText)

  // ── Reachable-surface check ───────────────────────────────────────────────────
  // For Proposal Arcs with user stories, judge whether each story has a
  // Reachable surface (UI affordance, CLI command, or bot command) in the
  // merged result.  API routes, passing tests, and DB columns do not qualify.
  // Skip entirely when no user stories were promised.
  if (prdContext.userStories.length > 0) {
    const reachability = await judgeReachableSurfaces({
      userStories: prdContext.userStories,
      outOfScope: prdContext.outOfScope,
      diff,
      cwd: opts.cwd,
    })
    if (reachability.unsatisfiedStories.length > 0) {
      const [primary, ...rest] = reachability.unsatisfiedStories
      let finding = `User story unsatisfied — "${primary.story}": ${primary.humanCannotDo}`
      if (rest.length > 0) {
        finding += ` (+${rest.length} other unsatisfied ${rest.length === 1 ? 'story' : 'stories'})`
      }
      verdict = { ok: false, findings: [...verdict.findings, finding] }
    }
  }

  // ── E2E tooling probe (level-triggered) ──────────────────────────────────────
  // Probe whether the repo has a working E2E environment. When tooling is absent
  // raise exactly one global `e2e-tooling-missing` action-queue item — the
  // fixed signature ensures N arcs produce at most one row. When tooling is
  // present, auto-resolve any stale open alert. The arc is never failed for
  // missing E2E infra.
  const toolingReport = probeE2eTooling(opts.cwd)
  if (!toolingReport.available) {
    const arcShort = originId.slice(0, 8)
    const missingList = toolingReport.missing.map((m) => `- ${m}`).join('\n')
    const stepsBlock = toolingReport.setupSteps
      .map((s, i) => `${i + 1}. \`${s}\``)
      .join('\n')
    await raiseActionQueueItem({
      kind: 'e2e-tooling-missing',
      category: 'orchestrator',
      priority: 'normal',
      title: 'E2E tooling not set up — live arc verification skipped',
      body: [
        `Arc \`${arcShort}\` completed without a live E2E pass because the E2E`,
        'tooling environment is not yet configured. Set it up once and every',
        'future arc will be exercised automatically.',
        '',
        '**What is missing:**',
        missingList,
        '',
        '**Setup steps:**',
        stepsBlock,
      ].join('\n'),
      payload: {
        missing: toolingReport.missing,
        setupSteps: toolingReport.setupSteps,
        mostRecentArcId: originId,
      },
      context: {},
      raisedBy: 'arc-verifier',
      signature: E2E_TOOLING_SIGNATURE,
    }).catch(() => {
      // Best-effort — never block the arc.
    })
  } else {
    // Tooling is now available — auto-resolve any stale alert.
    const openItems = await listActionQueueItems('open', { kind: 'e2e-tooling-missing' })
    for (const item of openItems) {
      await setActionQueueState(item.id, 'resolved', {
        resolution: 'auto-resolved',
        note: 'E2E tooling detected as available',
        by: 'arc-verifier',
      }).catch(() => {
        // Best-effort.
      })
    }

    // ── Arc-level E2E pass ────────────────────────────────────────────────────
    // Boot the app, capture a screenshot per done criterion, then tear down the
    // server. Serialized machine-wide via `.mars/.e2e.lock`. A durable marker
    // prevents re-runs after a daemon restart. The arc is NEVER failed here —
    // all errors are CAN'T-VERIFY outcomes, not arc failures.
    const marsStateDir = join(opts.cwd, '.mars')
    const e2eDepsResolved: ArcE2eDeps = { ...defaultArcE2eDeps, ...opts.e2eDeps }

    let e2ePass: ArcE2ePassResult | undefined

    if (e2eDepsResolved.isE2ePassDone(originId, marsStateDir)) {
      // Fast path: completed in a prior daemon lifetime — skip.
      e2ePass = { ran: false, cantVerifyReason: 'already-done', criterionResults: [] }
    } else {
      // Collect all done criteria across every task in the arc.
      const allCriteria = arcTaskData.flatMap((t) => [...t.doneCriteria])

      if (allCriteria.length === 0) {
        // CAN'T-VERIFY: no criteria authored on any arc task.
        e2ePass = { ran: false, cantVerifyReason: 'no-criteria', criterionResults: [] }
      } else {
        const bootPlan = e2eDepsResolved.discoverAppBoot(opts.cwd)

        if (bootPlan === null) {
          // CAN'T-VERIFY: no runnable app surface discovered.
          e2ePass = { ran: false, cantVerifyReason: 'no-boot-plan', criterionResults: [] }
        } else {
          // Acquire the machine-wide cross-process lock so only one E2E pass
          // runs at a time, then re-check the durable marker (double-checked
          // locking: another worker may have completed the pass while we waited).
          let releaseLock: (() => Promise<void>) | null = null
          try {
            releaseLock = await e2eDepsResolved.acquireLock(
              join(marsStateDir, '.e2e.lock'),
              E2E_LOCK_TIMEOUT_MS,
            )

            // Second marker check under the lock.
            if (e2eDepsResolved.isE2ePassDone(originId, marsStateDir)) {
              e2ePass = { ran: false, cantVerifyReason: 'already-done', criterionResults: [] }
            } else {
              const logDir = join(marsStateDir, 'dev-servers')
              const criterionResults = await e2eDepsResolved.runBrowserCheck(
                bootPlan,
                allCriteria,
                { taskId: originId, worktreeDir: opts.cwd, logDir },
              )
              await e2eDepsResolved.markE2ePassDone(originId, marsStateDir)
              e2ePass = { ran: true, cantVerifyReason: null, criterionResults }
            }
          } catch (e2eErr) {
            // Best-effort: E2E infra errors never fail the arc.
            console.error(`[arc-verifier] E2E pass for arc ${originId} errored:`, e2eErr)
            // e2ePass remains undefined — no evidence to attach.
          } finally {
            await releaseLock?.()
          }
        }
      }
    }

    if (e2ePass !== undefined) {
      verdict = { ...verdict, e2ePass }
    }
  }

  // On failure: raise exactly one arc-verification-failed action-queue item.
  // The signature `arc-verification-failed:<originId>` ensures dedup via
  // raiseActionQueueItem's fingerprint mechanism.
  if (!verdict.ok) {
    await raiseActionQueueItem({
      kind: 'arc-verification-failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Arc ${originId} verification failed`,
      body: [
        `The post-merge arc-outcome verifier found issues with arc \`${originId}\`.`,
        '',
        '**Findings:**',
        ...verdict.findings.map((f) => `- ${f}`),
        '',
        'Review the arc\'s merged output and remediate the issues, then resolve this',
        'item manually once the arc\'s output is confirmed correct.',
      ].join('\n'),
      payload: {
        originId,
        findings: verdict.findings,
        landedCommits: arcStatus.landedCommits,
      },
      context: {},
      raisedBy: 'arc-verifier',
      signature: `arc-verification-failed:${originId}`,
      originTaskId: originId,
    })
  }

  return verdict
}

// ─────────────────────────────────────────────────────────────────────────────
// Admission trigger (dedup + kill-switch guard)
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerResult =
  | 'triggered'
  | 'skipped-disabled'
  | 'skipped-dedup'

/**
 * Trigger arc verification for the given origin id.
 *
 * Returns immediately. The daemon owns scheduling and execution after this
 * admission succeeds, so verifier subprocesses remain visible to pause and
 * daemon status.
 *
 * Dedup: once triggered for an originId, subsequent calls with the same id
 * return `'skipped-dedup'` immediately (per daemon lifetime).
 *
 * Kill-switch: when `MARS_ARC_VERIFY_DISABLED=1`, all calls return
 * `'skipped-disabled'` without scheduling any work.
 */
export function triggerArcVerification(
  originId: string,
): TriggerResult {
  if (isArcVerifyDisabled()) return 'skipped-disabled'
  if (triggeredOriginIds.has(originId)) return 'skipped-dedup'
  triggeredOriginIds.add(originId)

  return 'triggered'
}
