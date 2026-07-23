/**
 * Arc-outcome verifier (ADR-XXXX).
 *
 * After the last task of an arc merges into the integration branch the daemon
 * fires a cheap headless Claude (haiku tier) agent against main that:
 *   1. Re-runs each task's verifyCmd where present.
 *   2. Spot-checks the arc's done criteria against the actual merged diff.
 *   3. Returns a structured verdict { ok, findings[] }.
 *   4. Attempts a live end-to-end pass against the origin task's previewCmd
 *      (if defined), driving the shipped behaviour on a live surface.
 *      When no E2E environment is available (no previewCmd, spawn failure,
 *      health-check timeout, or no browser/UI-driving MCP tools), a Reflector
 *      draft proposal (source: 'reflection') is emitted describing what the
 *      operator needs to set up — the arc is never failed for missing infra.
 *
 * On a failing verdict one `arc-verification-failed` action-queue item is raised
 * (deduped per originId; the operator decides the remediation). On a passing
 * verdict the outcome is recorded as a trace event for the Studio timeline.
 *
 * Kill-switch: `mars daemon set-flag arc-verify on` sets
 * `MARS_ARC_VERIFY_DISABLED=1` (in-memory) and suppresses all runs. Useful
 * during incident storms to stop the verifier from adding noise.
 *
 * Concurrency: at most one verifier run at a time, implemented via a promise
 * chain (concurrencyTail). The merge path never blocks — `triggerArcVerification`
 * returns immediately and the work executes after the current run finishes.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDefaultTaskStore, type ArcStatusOptions } from '../store/task-store.js'
import { raiseActionQueueItem } from './action-queue.js'
import { runClaudeCode } from './git/claude.js'
import { collectAssistantText } from './reflector.js'
import { createProposal, findOpenDraftByKpiTag } from '../proposals.js'
import { startDevServer, killDevServer } from './dev-server.js'

const execFileAsync = promisify(execFile)

/** Haiku-tier model: cheap, fast, sufficient for spot-check evaluation. */
const VERIFIER_MODEL = 'claude-haiku-4-5-20251001'

/** Maximum characters to include from the merged diff sent to the verifier. */
const DIFF_SIZE_CAP = 8_000

/** Maximum characters to include from a verifyCmd's output in the prompt. */
const VERIFY_CMD_OUTPUT_CAP = 2_000

/** Health-check budget (ms) for the arc-level E2E dev server. */
const ARC_E2E_HEALTH_CHECK_TIMEOUT_MS = 60_000

/**
 * In-memory dedup set. Once an originId has been triggered for verification
 * it is never triggered again in the same daemon process. Never cleared in
 * production; cleared between tests via {@link _clearTriggeredForTests}.
 */
export const triggeredOriginIds = new Set<string>()

/** For test isolation ONLY. Never call in production. */
export const _clearTriggeredForTests = (): void => {
  triggeredOriginIds.clear()
  concurrencyTail = Promise.resolve()
}

/** At-most-one concurrency gate: each scheduled run waits for the previous. */
let concurrencyTail: Promise<void> = Promise.resolve()

// ─────────────────────────────────────────────────────────────────────────────
// Kill-switch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns `true` when `MARS_ARC_VERIFY_DISABLED=1` is set (in-memory;
 * toggled via `mars daemon set-flag arc-verify on|off`).
 */
export const isArcVerifyDisabled = (): boolean =>
  process.env.MARS_ARC_VERIFY_DISABLED === '1'

// ─────────────────────────────────────────────────────────────────────────────
// Verdict type
// ─────────────────────────────────────────────────────────────────────────────

export interface ArcVerificationVerdict {
  ok: boolean
  findings: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fingerprint for the CAN'T-VERIFY arc E2E Reflector draft proposal.
 * Deduplicates across daemon restarts via the `kpi_tag` column.
 */
export const arcE2eProposalFingerprint = (originId: string): string =>
  `arc-e2e-unverifiable:${originId}`

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

/**
 * Emit a Reflector draft proposal (source: 'reflection') describing a missing
 * arc E2E environment, deduped by `fingerprint` via the `kpi_tag` column.
 * Best-effort: errors are swallowed so a DB hiccup never fails the arc.
 *
 * Called from multiple branches of the E2E pass (no previewCmd, spawn failure,
 * health-check timeout, no browser tools) — four callers justify the extract.
 */
async function emitArcE2eProposalIfNew(
  originId: string,
  fingerprint: string,
  problem: string,
  solution: string,
  notes: string,
): Promise<void> {
  const existing = await findOpenDraftByKpiTag(fingerprint).catch(() => null)
  if (existing !== null) return
  await createProposal(`Set up E2E environment for arc ${originId}`, {
    source: 'reflection',
    author: { kind: 'agent', name: 'arc-verifier' },
    problem,
    solution,
    notes,
    kpiTag: fingerprint,
  }).catch(() => {
    // Draft proposal creation is best-effort — never block the arc.
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Core verification logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the arc-outcome verification for the given `originId`.
 *
 * Skips silently when the arc has not fully completed with at least one
 * merged commit (e.g. still in-progress or fully failed). This is the
 * testable core — it does NOT check the dedup set or the kill-switch;
 * those are enforced by {@link triggerArcVerification}.
 *
 * After the static spot-check, attempts a live E2E pass via the origin task's
 * `previewCmd`. If no E2E environment is available, a Reflector draft proposal
 * is emitted (source: 'reflection') and the arc is not failed.
 *
 * @returns The verifier's verdict. When the arc has no landed commits or
 *   is not `arc-done`, returns `{ ok: true, findings: [] }` (no-op).
 */
export async function runArcVerification(
  originId: string,
  opts: {
    cwd: string
    integrationBranch?: string
    /**
     * Health-check timeout (ms) for the arc-level E2E dev server.
     * Defaults to {@link ARC_E2E_HEALTH_CHECK_TIMEOUT_MS}.
     * Override in tests to avoid real wait times.
     */
    e2eHealthCheckTimeoutMs?: number
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
    previewCmd: t.spec?.previewCmd ?? null,
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

  // Build the verifier prompt and call the haiku agent.
  const prompt = buildVerifierPrompt(originId, arcTaskData, verifyCmdResults, diff)
  const agentResult = await runClaudeCode({
    cwd: opts.cwd,
    prompt,
    model: VERIFIER_MODEL,
    timeoutMs: 120_000,
  })
  const rawText = collectAssistantText(agentResult.conversation) || agentResult.stdout
  let verdict = parseVerdict(rawText)

  // ── Arc-level E2E pass ────────────────────────────────────────────────────
  // After the static spot-check, attempt to exercise the arc's shipped behaviour
  // on a live surface via the origin task's previewCmd. Graceful degradation:
  // any infrastructure gap (no previewCmd, spawn failure, health-check timeout,
  // no browser tools) emits a Reflector draft proposal (source: 'reflection')
  // describing what the operator needs to set up, and leaves the verdict
  // unchanged — the arc is never failed for missing E2E infrastructure.
  const originE2eData = arcTaskData.find((t) => t.id === originId)
  const arcPreviewCmd = originE2eData?.previewCmd ?? null
  const arcE2eCriteria: readonly string[] = originE2eData?.doneCriteria ?? []
  const e2eFingerprint = arcE2eProposalFingerprint(originId)
  const e2eTimeoutMs = opts.e2eHealthCheckTimeoutMs ?? ARC_E2E_HEALTH_CHECK_TIMEOUT_MS

  if (arcPreviewCmd === null || arcE2eCriteria.length === 0) {
    // No live surface or no criteria to exercise: emit a Reflector draft
    // proposal so the operator knows what to set up for proper E2E coverage.
    const cantReason =
      arcPreviewCmd === null
        ? 'no previewCmd on origin task'
        : 'no done criteria on origin task'
    await emitArcE2eProposalIfNew(
      originId,
      e2eFingerprint,
      `Arc ${originId} completed without a live E2E pass: ${cantReason}.`,
      arcPreviewCmd === null
        ? 'Add a previewCmd to the origin task spec (`mars task add ... --preview "npm run dev"`) so the arc verifier can boot a live surface and exercise the Definition of Done.'
        : 'Add done criteria to the origin task spec so the arc verifier knows what to exercise on the live surface.',
      `Arc origin: ${originId}`,
    )
  } else {
    // previewCmd and criteria are both present — attempt live E2E verification.
    let e2eDev: { pid: number; url: string; logPath: string; port: number } | null = null

    try {
      // Boot a dev server against the integration branch at cwd.
      try {
        e2eDev = await startDevServer({
          command: arcPreviewCmd,
          cwd: opts.cwd,
          taskId: originId,
          logDir: opts.cwd,
        })
      } catch {
        // Spawn failure is an infra gap: emit draft proposal, don't fail arc.
        await emitArcE2eProposalIfNew(
          originId,
          e2eFingerprint,
          `Arc ${originId} E2E pass: previewCmd \`${arcPreviewCmd}\` failed to spawn — the dev-server process could not be started.`,
          `Ensure the preview command boots cleanly and serves HTTP on the injected \$PORT environment variable.`,
          `Arc origin: ${originId}\nPreview command: ${arcPreviewCmd}`,
        )
      }

      if (e2eDev !== null) {
        // Poll the server URL until it answers any HTTP request or the timeout elapses.
        const e2eDeadline = Date.now() + e2eTimeoutMs
        let e2eHealthy = false
        for (;;) {
          try {
            await fetch(e2eDev.url, { signal: AbortSignal.timeout(2_000) })
            e2eHealthy = true
            break
          } catch {
            if (Date.now() >= e2eDeadline) break
            await new Promise<void>((r) => setTimeout(r, 500))
          }
        }

        if (!e2eHealthy) {
          await emitArcE2eProposalIfNew(
            originId,
            e2eFingerprint,
            `Arc ${originId} E2E pass: previewCmd \`${arcPreviewCmd}\` spawned but never answered its health check within ${e2eTimeoutMs}ms.`,
            `Fix the preview command so it serves HTTP on \$PORT within the allotted time (current budget: ${e2eTimeoutMs}ms).`,
            `Arc origin: ${originId}\nPreview command: ${arcPreviewCmd}\nDev server URL: ${e2eDev.url}`,
          )
        } else {
          // Live surface is up — run Claude haiku against it to drive the flow.
          const e2ePrompt = [
            `You are an arc-level E2E verifier for arc ${originId}.`,
            '',
            `A live dev server is running at: ${e2eDev.url}`,
            '',
            'Your job: verify each Definition-of-Done criterion against the RUNNING',
            'surface using browser/UI-driving MCP tools if available in your environment.',
            '',
            '## Definition-of-Done criteria',
            ...arcE2eCriteria.map((c, i) => `  [${i}] ${c}`),
            '',
            'Return ONLY a JSON object on a single line:',
            '  {"ok": <boolean>, "canVerify": <boolean>, "findings": [<string>, ...]}',
            '- Set canVerify:false (and ok:true) when no browser/UI-driving tools are',
            '  available in your environment — this is an infra gap, not a product failure.',
            '- Set ok:false with findings when criteria are positively contradicted on',
            '  the live surface.',
            '- Set ok:true when every exercised criterion is satisfied.',
            'Return ONLY the JSON object. No other text.',
          ].join('\n')

          const e2eResult = await runClaudeCode({
            cwd: opts.cwd,
            prompt: e2ePrompt,
            model: VERIFIER_MODEL,
            timeoutMs: 120_000,
          })
          const e2eText =
            collectAssistantText(e2eResult.conversation) || e2eResult.stdout

          // Parse the E2E verdict, which extends the base verdict with canVerify.
          const e2eJsonMatch = e2eText.match(/\{[\s\S]*?\}/)
          let e2eOk = true
          let e2eCanVerify = true
          let e2eFindings: string[] = []
          if (e2eJsonMatch !== null) {
            try {
              const parsed = JSON.parse(e2eJsonMatch[0]) as {
                ok?: unknown
                canVerify?: unknown
                findings?: unknown
              }
              e2eOk = typeof parsed.ok === 'boolean' ? parsed.ok : true
              e2eCanVerify =
                typeof parsed.canVerify === 'boolean' ? parsed.canVerify : true
              e2eFindings = Array.isArray(parsed.findings)
                ? parsed.findings.filter((f): f is string => typeof f === 'string')
                : []
            } catch {
              e2eCanVerify = false
            }
          } else {
            // Unparseable response — treat as can't-verify (infra gap).
            e2eCanVerify = false
          }

          if (!e2eCanVerify) {
            // No browser tools or unparseable: emit draft proposal, don't fail arc.
            await emitArcE2eProposalIfNew(
              originId,
              e2eFingerprint,
              `Arc ${originId} E2E pass: the verifier agent could not exercise the live surface (no browser/UI-driving MCP tools available, or the response was unparseable).`,
              'Configure a browser automation MCP (e.g. Playwright MCP) in the operator environment so the arc verifier can drive the UI and verify Definition-of-Done criteria against the live surface.',
              `Arc origin: ${originId}\nPreview command: ${arcPreviewCmd}\nDev server URL: ${e2eDev.url}`,
            )
          } else if (!e2eOk) {
            // Positive evidence of contradiction on the live surface: fold into verdict.
            verdict = {
              ok: false,
              findings: [
                ...verdict.findings,
                ...e2eFindings.map((f) => `[e2e] ${f}`),
              ],
            }
          }
        }
      }
    } finally {
      if (e2eDev !== null) {
        await killDevServer(e2eDev.pid).catch(() => {
          // Teardown is best-effort; an already-dead process is fine.
        })
      }
    }
  }
  // ─── end arc E2E pass ─────────────────────────────────────────────────────

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
// Fire-and-forget trigger (dedup + concurrency guard)
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerResult =
  | 'triggered'
  | 'skipped-disabled'
  | 'skipped-dedup'

/**
 * Trigger arc verification for the given origin id.
 *
 * Returns immediately. The actual verification runs asynchronously, chained
 * behind any currently-running verification (at-most-one concurrency). The
 * merge path must NOT await this return value — fire-and-forget is intentional
 * so the merge step is never blocked.
 *
 * Dedup: once triggered for an originId, subsequent calls with the same id
 * return `'skipped-dedup'` immediately (per daemon lifetime).
 *
 * Kill-switch: when `MARS_ARC_VERIFY_DISABLED=1`, all calls return
 * `'skipped-disabled'` without scheduling any work.
 */
export function triggerArcVerification(
  originId: string,
  opts?: ArcStatusOptions & { cwd?: string },
): TriggerResult {
  if (isArcVerifyDisabled()) return 'skipped-disabled'
  if (triggeredOriginIds.has(originId)) return 'skipped-dedup'
  triggeredOriginIds.add(originId)

  const cwd = opts?.cwd ?? process.env.MARS_REPO ?? process.cwd()

  // Schedule the verification after the current run finishes.
  const prev = concurrencyTail
  let resolveNext!: () => void
  concurrencyTail = new Promise<void>((r) => {
    resolveNext = r
  })

  void prev.then(async () => {
    try {
      await runArcVerification(originId, {
        cwd,
        integrationBranch: opts?.integrationBranch,
      })
    } catch {
      // Non-fatal: errors are swallowed so a verifier crash never propagates
      // to the merge path or daemon dispatch loop.
    } finally {
      resolveNext()
    }
  })

  return 'triggered'
}
