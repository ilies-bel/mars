/**
 * Health-pass shared contract.
 *
 * This module defines the types and primitives that every scheduled health
 * pass route handler depends on:
 *
 *   1. HealthCheckPosture  — per-check operator posture (automatic|manual|off).
 *   2. PassFinding         — a failing check result bundled with its posture,
 *                            passed to route handlers (notice / alert / fix-task).
 *   3. PassResult          — the aggregate output of running a full pass.
 *   4. NoticeStore         — persistence contract for the notice route:
 *                            stateable-once, silenceable, deduped across passes.
 *   5. AlertStore          — persistence contract for the alert route:
 *                            condition-keyed, auto-clears on a clean pass.
 *   6. runPass             — drives a pass over a set of checks, honouring
 *                            posture='off' skipping.
 *   7. createInMemoryNoticeStore / createInMemoryAlertStore — canonical
 *                            in-memory implementations used in tests and
 *                            by the Steward before a DB-backed implementation
 *                            is wired in.
 *
 * Route handlers (notice, alert, fix-task) consume a PassResult after runPass
 * returns and are responsible for taking the appropriate action per finding.
 * This module is route-agnostic — it only runs the checks and bundles results.
 */

import type { HealthCheck, HealthCheckResult } from './index.js'
import { listChecks, runChecks, type CheckContext } from './registry.js'
import { routeFixFinding, type FixRouteDeps } from './routes/fix.js'
import { routeAlert, clearHealthAlert, type AlertRouteDeps } from './routes/alert.js'
import { routeNotice, type NoticeRouteDeps } from './routes/notice.js'
import type { PostureStore } from './posture.js'

// ── Posture ───────────────────────────────────────────────────────────────────

/**
 * Per-check operator posture.
 *
 *   'automatic' — Default. Mars acts on a finding immediately: enqueues the
 *                 fix task, states the notice, or raises the action-queue row
 *                 without waiting for operator input.
 *   'manual'    — Mars presents the finding as an offer but takes no action
 *                 until the operator approves. The route handler receives the
 *                 finding and can offer a one-click fix without executing it.
 *   'off'       — The check is suppressed. The Steward skips it during a
 *                 scheduled pass; doctor still enumerates it (last known state).
 */
export type HealthCheckPosture = 'automatic' | 'manual' | 'off'

// ── Pass-level finding ────────────────────────────────────────────────────────

/**
 * A failing check result bundled with the check's descriptor and the
 * operator's effective posture for it.
 *
 * This is the common currency route handlers receive.  By carrying posture
 * alongside result and check, a handler can make its routing decision without
 * reaching back into the registry or any external configuration.
 */
interface PassFinding {
  readonly check: HealthCheck
  readonly result: Extract<HealthCheckResult, { status: 'fail' }>
  readonly posture: HealthCheckPosture
}

// ── Pass result ───────────────────────────────────────────────────────────────

/**
 * Aggregate output of one full health pass.
 *
 * `findings` — one entry per check that (a) was not disabled by posture='off'
 *              and (b) returned status='fail'.  Passing checks are absent.
 * `skipped`  — ids of checks whose posture was 'off' and that were therefore
 *              not run at all.
 */
export interface PassResult {
  readonly findings: PassFinding[]
  readonly skipped: string[]
}

// ── Pass deps ─────────────────────────────────────────────────────────────────

/**
 * Dependencies injected into runPass.
 *
 * Keeping posture lookup behind a function boundary lets callers source
 * posture from an in-memory map, a DB, or operator config without changing
 * the pass runner.
 */
export interface PassDeps {
  /**
   * Return the effective posture for a check id.
   * Must return 'automatic' (the default) when no explicit posture is set.
   */
  getPosture(checkId: string): HealthCheckPosture
}

// ── Pass runner ───────────────────────────────────────────────────────────────

/**
 * Run every check in `checks` (in order), honouring posture='off' skipping,
 * and collect failures into a PassResult.
 *
 * - Checks with posture='off' are placed in `skipped` and not run.
 * - Checks with posture='automatic' or 'manual' are run; failures are
 *   collected as PassFindings with the posture carried through so route
 *   handlers can honour it.
 * - Passing checks (status='pass') do not appear in `findings`.
 *
 * runPass never throws: each check.run() is responsible for its own error
 * handling (per the HealthCheck contract in index.ts).
 */
export const runPass = async (
  checks: HealthCheck[],
  deps: PassDeps,
): Promise<PassResult> => {
  const findings: PassFinding[] = []
  const skipped: string[] = []

  for (const check of checks) {
    const posture = deps.getPosture(check.descriptor.id)
    if (posture === 'off') {
      skipped.push(check.descriptor.id)
      continue
    }

    const result = await check.run()
    if (result.status === 'fail') {
      findings.push({ check, result, posture })
    }
  }

  return { findings, skipped }
}

// ── Notice store ──────────────────────────────────────────────────────────────

/**
 * Persistence contract for the notice route.
 *
 * The notice route states a finding once (stateable-once) and lets the
 * operator silence it permanently.  Implementations back this with an
 * in-memory map for tests, or a DB table for production.
 *
 * Lifecycle:
 *   - First failing pass:  hasBeenStated → false  → state the notice →
 *                          markStated → hasBeenStated → true (not re-stated).
 *   - Condition clears:    resetStated → hasBeenStated → false (re-stateable
 *                          if the condition recurs).
 *   - Operator silences:   silence → isSilenced → true (never re-stated,
 *                          even after resetStated).
 */
export interface NoticeStore {
  /**
   * True when the notice for this check was stated on a prior pass and has
   * not been reset since.  A stated notice is skipped on subsequent passes
   * to avoid repeating the same message.
   */
  hasBeenStated(checkId: string): Promise<boolean>

  /**
   * Mark the notice for this check as stated so subsequent passes skip it.
   * Idempotent.
   */
  markStated(checkId: string): Promise<void>

  /**
   * Clear the stated flag so the notice will be re-stated on the next failing
   * pass.  Called when the check returns 'pass' after a prior fail (the
   * condition went away and may recur).
   * No-op when the notice has not been stated.
   */
  resetStated(checkId: string): Promise<void>

  /**
   * True when the operator has permanently silenced this notice.  A silenced
   * notice is never re-stated, even after resetStated is called.
   */
  isSilenced(checkId: string): Promise<boolean>

  /**
   * Silence this notice permanently.  Idempotent.
   */
  silence(checkId: string): Promise<void>
}

/**
 * Create a pure in-memory NoticeStore.
 *
 * Used in tests and as the default before a DB-backed implementation is wired
 * in.  State does not survive process restarts.
 */
export const createInMemoryNoticeStore = (): NoticeStore => {
  const stated = new Set<string>()
  const silenced = new Set<string>()

  return {
    async hasBeenStated(checkId) {
      return stated.has(checkId)
    },
    async markStated(checkId) {
      stated.add(checkId)
    },
    async resetStated(checkId) {
      stated.delete(checkId)
    },
    async isSilenced(checkId) {
      return silenced.has(checkId)
    },
    async silence(checkId) {
      silenced.add(checkId)
    },
  }
}

// ── Alert store ───────────────────────────────────────────────────────────────

/**
 * Persistence contract for the alert route.
 *
 * The alert route raises exactly one action-queue row per condition (keyed by
 * check id) and auto-resolves it when a later pass sees the condition gone.
 * Implementations back this with an in-memory map for tests, or a DB table
 * for production.
 *
 * Lifecycle:
 *   - First failing pass:  getOpenAlertId → null → raise AQ item →
 *                          setOpenAlertId → getOpenAlertId → aqItemId
 *                          (not re-raised on next failing pass).
 *   - Condition clears:    clearAlert → resolve the AQ item →
 *                          getOpenAlertId → null (fresh row on next failure).
 */
export interface AlertStore {
  /**
   * Returns the action-queue item id currently open for this check,
   * or null when no alert is open.
   */
  getOpenAlertId(checkId: string): Promise<string | null>

  /**
   * Record that an action-queue item has been raised for this check.
   * Replaces any prior record for the same checkId (last writer wins).
   */
  setOpenAlertId(checkId: string, aqItemId: string): Promise<void>

  /**
   * Clear the open-alert record for this check so a future failing pass
   * raises a fresh action-queue item.
   * No-op when no alert is open.
   */
  clearAlert(checkId: string): Promise<void>
}

/**
 * Create a pure in-memory AlertStore.
 *
 * Used in tests and as the default before a DB-backed implementation is wired
 * in.  State does not survive process restarts.
 */
export const createInMemoryAlertStore = (): AlertStore => {
  const open = new Map<string, string>()

  return {
    async getOpenAlertId(checkId) {
      return open.get(checkId) ?? null
    },
    async setOpenAlertId(checkId, aqItemId) {
      open.set(checkId, aqItemId)
    },
    async clearAlert(checkId) {
      open.delete(checkId)
    },
  }
}

// ── Scheduled health pass ─────────────────────────────────────────────────────

/**
 * Injectable dependencies for a full scheduled health pass.
 *
 * Keeping these injected makes the pass runner testable without a live DB or
 * daemon: tests supply in-memory stubs; the production scheduler builds the
 * same interface from a DB client and `enqueueTask`.
 */
export interface HealthPassDeps {
  /**
   * Runtime prerequisites the calling context can satisfy. Passed directly to
   * runChecks() — checks whose `requires` list contains a prereq absent from
   * this Set are skipped (status='skipped', reason='prereq:<name>').
   */
  ctx: CheckContext

  /**
   * Dependencies for the fix route handler. Required; checks with route='fix'
   * are dispatched through routeFixFinding() which calls into these.
   */
  fix: FixRouteDeps

  /**
   * Dependencies for the alert route handler. Optional; when absent, alert-
   * route findings are counted but not acted upon. Checks with route='alert'
   * call routeAlert() to raise/dedup and clearHealthAlert() when the
   * condition clears.
   *
   * Also required when posture='manual' is set on a fix-route check — in
   * that case the finding is routed as an offer via this alert route rather
   * than directly enqueuing a task.
   */
  alert?: AlertRouteDeps

  /**
   * Dependencies for the notice route handler. Optional; when provided, checks
   * with route='notice' are dispatched through routeNotice(). When absent,
   * notice findings are counted but not acted upon.
   */
  notice?: NoticeRouteDeps

  /**
   * Posture store for per-check operator posture. Optional; when absent all
   * checks use 'automatic' (the default).
   *
   * - 'automatic' — acts immediately (enqueue fix, raise alert). Default.
   * - 'manual'    — fix-route check: raises an offer row (no task until taken).
   * - 'off'       — skips routing for this check; others are unaffected.
   */
  posture?: PostureStore
}

/**
 * Aggregate output of one scheduled health pass.
 *
 * `checked`         — checks that ran (ok + finding; does NOT include skipped).
 * `skippedByPrereq` — checks whose prereqs were not met and were not run.
 * `findings`        — count of checks that returned a finding.
 * `enqueued`        — task ids created by the fix route during this pass.
 * `alreadyActive`   — findingKeys that already had an active fix task (skipped).
 * `alertsRaised`    — AQ item ids raised by the alert route this pass.
 * `alertsCleared`   — AQ item ids resolved by the alert route this pass
 *                     (condition was gone and the open row was auto-closed).
 * `noticed`         — findingKeys for which a new notice was filed this pass.
 * `alreadyStated`   — findingKeys whose notice was already stated (deduped).
 * `silenced`        — findingKeys that are silenced and therefore skipped.
 */
export interface PassSummary {
  readonly checked: number
  readonly skippedByPrereq: number
  readonly findings: number
  readonly enqueued: readonly string[]
  readonly alreadyActive: readonly string[]
  readonly alertsRaised: readonly string[]
  readonly alertsCleared: readonly string[]
  readonly noticed: readonly string[]
  readonly alreadyStated: readonly string[]
  readonly silenced: readonly string[]
}

/**
 * Run every registered check (via the singleton registry) and dispatch findings
 * through their declared route handlers.
 *
 * Fix, alert, and notice routes are all handled here. A route whose deps are
 * absent is counted but not acted upon, so the pass is safe to run at any time.
 *
 * Never throws: individual check errors are caught by runChecks(); route
 * handler errors are logged and the pass continues.
 */
export const healthPass = async (deps: HealthPassDeps): Promise<PassSummary> => {
  const defs = listChecks()
  const results = await runChecks(deps.ctx)

  const enqueued: string[] = []
  const alreadyActive: string[] = []
  const alertsRaised: string[] = []
  const alertsCleared: string[] = []
  const noticed: string[] = []
  const alreadyStated: string[] = []
  const silenced: string[] = []
  let skippedByPrereq = 0
  let findings = 0

  for (const result of results) {
    if (result.status === 'skipped') {
      skippedByPrereq++
      continue
    }

    const def = defs.find((d) => d.id === result.id)

    if (result.status === 'finding') {
      findings++

      // Consult posture before routing: 'off' suppresses all routing for this
      // check; 'manual' on a fix-route check routes as an offer via the alert
      // route instead of immediately enqueuing a task.
      const posture = deps.posture ? await deps.posture.getPosture(result.id) : 'automatic'

      if (posture === 'off') {
        // Suppressed — no routing fires for this check. Other checks continue.
      } else if (posture === 'manual' && def?.route === 'fix' && deps.alert !== undefined) {
        // Offer path: surface as an action-queue offer with the fix spec
        // embedded so the operator can enact it with one click.
        const offerPayload = {
          findingKey: result.outcome?.findingKey ?? '',
          checkId: result.id,
          detail: result.outcome?.detail,
        }
        const outcome = await routeAlert(
          {
            findingKey: result.outcome?.findingKey,
            detail: result.outcome?.detail,
            checkId: result.id,
            label: def.description,
            offerPayload,
          },
          deps.alert,
        )
        if (outcome.action === 'raised' && outcome.aqItemId !== undefined) {
          alertsRaised.push(outcome.aqItemId)
        }
      } else if (def?.route === 'fix') {
        const outcome = await routeFixFinding(
          {
            findingKey: result.outcome?.findingKey,
            detail: result.outcome?.detail,
            checkId: result.id,
          },
          deps.fix,
        )

        if (outcome.action === 'enqueued' && outcome.taskId !== undefined) {
          enqueued.push(outcome.taskId)
        } else if (outcome.action === 'already-active' && outcome.findingKey !== undefined) {
          alreadyActive.push(outcome.findingKey)
        }
      } else if (def?.route === 'alert' && deps.alert !== undefined) {
        const outcome = await routeAlert(
          {
            findingKey: result.outcome?.findingKey,
            detail: result.outcome?.detail,
            checkId: result.id,
            label: def.description,
          },
          deps.alert,
        )

        if (outcome.action === 'raised' && outcome.aqItemId !== undefined) {
          alertsRaised.push(outcome.aqItemId)
        }
      } else if (def?.route === 'notice' && deps.notice !== undefined) {
        const outcome = await routeNotice(
          {
            findingKey: result.outcome?.findingKey,
            detail: result.outcome?.detail,
            checkId: result.id,
          },
          deps.notice,
        )

        if (outcome.action === 'stated' && outcome.findingKey !== undefined) {
          noticed.push(outcome.findingKey)
        } else if (outcome.action === 'already-stated' && outcome.findingKey !== undefined) {
          alreadyStated.push(outcome.findingKey)
        } else if (outcome.action === 'silenced' && outcome.findingKey !== undefined) {
          silenced.push(outcome.findingKey)
        }
      }
    } else if (result.status === 'ok') {
      if (def?.route === 'alert' && deps.alert !== undefined) {
        // Condition cleared — auto-resolve any open alert for this check.
        const clearedId = await clearHealthAlert(result.id, deps.alert)
        if (clearedId !== null) {
          alertsCleared.push(clearedId)
        }
      } else if (def?.route === 'notice' && deps.notice !== undefined) {
        // Condition cleared — reset the stated flag so the notice can re-file
        // if the condition recurs.
        const findingKey = result.outcome?.findingKey
        if (findingKey) {
          await deps.notice.noticeStore.resetStated(findingKey)
        }
      }
    }
  }

  return {
    checked: results.filter((r) => r.status !== 'skipped').length,
    skippedByPrereq,
    findings,
    enqueued,
    alreadyActive,
    alertsRaised,
    alertsCleared,
    noticed,
    alreadyStated,
    silenced,
  }
}
