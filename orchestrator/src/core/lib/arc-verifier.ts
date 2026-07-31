/**
 * Arc-outcome verifier (ADR-XXXX).
 *
 * After the last task of an arc merges into the integration branch the daemon
 * fires the selected provider's fast-tier headless agent against main that:
 *   1. Re-runs each task's verifyCmd where present.
 *   2. Spot-checks the arc's done criteria against the actual merged diff.
 *   3. Returns a structured verdict { ok, findings[] }.
 *   4. Emits a Reflector draft proposal describing what the operator needs to
 *      set up for live E2E coverage — the arc is never failed for missing infra.
 *
 * On a failing verdict one `arc-verification-failed` action-queue item is raised
 * (deduped per originId; the operator decides the remediation). On a passing
 * verdict the outcome is recorded as a trace event for the Studio timeline.
 *
 * Kill-switch: `mars daemon set-flag arc-verify on` sets
 * `MARS_ARC_VERIFY_DISABLED=1` (in-memory) and suppresses all runs. Useful
 * during incident storms to stop the verifier from adding noise.
 *
 * Concurrency: the daemon owns arc-verifier admission and execution through its
 * tracked worker pool. This module only performs the synchronous kill-switch and
 * dedup admission checks.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDefaultTaskStore, type ArcStatusOptions } from '../store/task-store.js'
import { raiseActionQueueItem } from './action-queue.js'
import { runHeadlessProvider } from '../workers/providers.js'
import { collectAssistantText } from './reflector.js'
import { createProposal, findOpenDraftByKpiTag } from '../proposals.js'

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
 * Emit a draft proposal (source: 'arc-verifier') describing a missing arc E2E
 * environment, deduped by `fingerprint` via the `kpi_tag` column.
 * Best-effort: errors are swallowed so a DB hiccup never fails the arc.
 *
 * The source is `arc-verifier`, NOT `reflection`: these rows come from arc
 * verification, not from the reflector, and sharing one value made it
 * impossible to tell from the data which subsystem wrote a proposal.
 *
 * Called when no live E2E environment is available for this arc.
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
    source: 'arc-verifier',
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
 * After the static spot-check, emits a Reflector draft proposal when no
 * live E2E environment is available — the arc is not failed for missing infra.
 *
 * @returns The verifier's verdict. When the arc has no landed commits or
 *   is not `arc-done`, returns `{ ok: true, findings: [] }` (no-op).
 */
export async function runArcVerification(
  originId: string,
  opts: {
    cwd: string
    integrationBranch?: string
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

  // Build the verifier prompt and call the provider's fast-tier agent.
  const prompt = buildVerifierPrompt(originId, arcTaskData, verifyCmdResults, diff)
  const agentResult = await runHeadlessProvider(prompt, {
    cwd: opts.cwd,
    modelTier: 'fast',
    timeoutMs: 120_000,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  })
  const rawText = collectAssistantText(agentResult.conversation) || agentResult.stdout
  let verdict = parseVerdict(rawText)

  // ── Arc-level E2E pass (CAN'T-VERIFY: no runnable surface) ──────────────────
  // No per-task preview command exists any more (removed in PRD f354b404 slice 1).
  // Emit a Reflector draft proposal so the operator knows the arc went unexercised.
  const originE2eData = arcTaskData.find((t) => t.id === originId)
  const arcE2eCriteria: readonly string[] = originE2eData?.doneCriteria ?? []
  const e2eFingerprint = arcE2eProposalFingerprint(originId)
  const cantReason = arcE2eCriteria.length === 0
    ? 'no done criteria on origin task'
    : 'no runnable preview surface configured for this arc'
  await emitArcE2eProposalIfNew(
    originId,
    e2eFingerprint,
    `Arc ${originId} completed without a live E2E pass: ${cantReason}.`,
    arcE2eCriteria.length === 0
      ? 'Add done criteria to the origin task spec so the arc verifier knows what to exercise on the live surface.'
      : 'Wire a dev server into the workflow or the task\'s environment so the arc verifier has a live URL to exercise.',
    `Arc origin: ${originId}`,
  )

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
