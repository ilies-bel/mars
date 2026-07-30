/**
 * Assembles the `DecisionInputs` needed by `decideDispatchControl` from live
 * system signals. Extracted here so the dispatcher loop stays focused on
 * routing logic and so tests can inject lightweight stubs for the spend-window
 * and health probes without touching the DB or breaker singleton.
 */

import { loadSpendControl } from '../core/daemon/spend-control/store.js';
import { getLatestUsageSnapshot } from '../core/lib/usage-snapshot-store.js';
import { readDaemonConfigFile } from '../core/daemon/config.js';
import type { DbClient } from '../core/lib/db.js';
import type {
  BreakerSnapshot,
  DecisionInputs,
  SpendWindow,
  HealthCounters,
} from '../core/daemon/spend-control/decide.js';

/**
 * Dependencies needed to gather a spend-control decision snapshot.
 *
 * All probes are optional and default to zero-pressure values so callers
 * without a live spend meter are unaffected.
 *
 * **Breaker note**: `getBreakerSnapshot` defaults to a permanently-closed
 * snapshot rather than reading `apiCircuitBreaker` directly. The API circuit
 * breaker already gates code-phase subscribers individually via the
 * `gatedByApiBreaker` flag. Duplicating that signal here would globally pause
 * non-code subscribers — which is not the intent. Inject `getBreakerSnapshot`
 * only when you explicitly want the spend-control to react to breaker state
 * (e.g. in a test that exercises the full multi-signal decision).
 */
export interface SpendControlDeps {
  /** DB client used to load the persisted operator levers. */
  client: DbClient;
  /** Override the spend-window probe (injectable for testing). */
  getSpendWindow?: () => SpendWindow | Promise<SpendWindow>;
  /** Override the health-counters probe (injectable for testing). */
  getHealthCounters?: () => HealthCounters | Promise<HealthCounters>;
  /**
   * Override the breaker-snapshot probe. Defaults to a permanently-closed
   * snapshot so the spend-control decision is driven by spend-rate pressure,
   * not API connectivity (which is handled per-subscriber via
   * `gatedByApiBreaker`).
   */
  getBreakerSnapshot?: () => BreakerSnapshot | Promise<BreakerSnapshot>;
}

/**
 * Probe the current spend window from the DB.
 *
 * Reads `budget.windowTokens` from daemon.json as the configured token-budget
 * ceiling and the most recent row from `usage_snapshots` for the current
 * cumulative token count. Returns zero-pressure (`usedPct: 0`) when:
 *   - no `budget.windowTokens` is configured, or
 *   - the `usage_snapshots` table has no rows yet.
 *
 * @param client      DB client to read `usage_snapshots` from.
 * @param wasPaused   Whether the previous spend-control decision was to pause.
 *                    Callers thread this through to implement hysteresis: the
 *                    `decideDispatchControl` function uses it to hold the paused
 *                    state until spend drops below the resume threshold.
 * @param opts        Override `windowTokens` for testing without daemon.json.
 */
export async function probeSpendWindow(
  client: DbClient,
  wasPaused: boolean,
  opts?: { windowTokens?: number },
): Promise<SpendWindow> {
  // Resolve the configured token-budget ceiling.
  let windowTokens: number | null = opts?.windowTokens ?? null
  if (windowTokens === null) {
    const config = readDaemonConfigFile()
    const budget = config['budget']
    if (budget !== null && typeof budget === 'object' && !Array.isArray(budget)) {
      const wt = (budget as Record<string, unknown>)['windowTokens']
      if (typeof wt === 'number' && Number.isFinite(wt) && wt > 0) {
        windowTokens = wt
      }
    }
  }
  if (windowTokens === null || windowTokens <= 0) {
    return { usedPct: 0, wasPaused }
  }

  // Read cumulative token totals from the latest usage snapshot.
  const snapshot = await getLatestUsageSnapshot(client)
  if (snapshot === null) {
    return { usedPct: 0, wasPaused }
  }

  const totalTokens = snapshot.inputTokens + snapshot.outputTokens
  const usedPct = Math.min(100, (totalTokens / windowTokens) * 100)
  return { usedPct, wasPaused }
}

/**
 * Read current signals and return the `DecisionInputs` required by
 * `decideDispatchControl`. Performs I/O (DB + optional probe calls).
 */
export async function gatherDecisionInputs(deps: SpendControlDeps): Promise<DecisionInputs> {
  const neutralBreaker: BreakerSnapshot = { open: false, reason: null, openedAt: null };

  const [levers, spendWindow, health, breaker] = await Promise.all([
    loadSpendControl(deps.client),
    deps.getSpendWindow
      ? deps.getSpendWindow()
      : { usedPct: 0, wasPaused: false },
    deps.getHealthCounters
      ? deps.getHealthCounters()
      : { recentRecoveryFailures: 0 },
    deps.getBreakerSnapshot
      ? deps.getBreakerSnapshot()
      : neutralBreaker,
  ]);

  return {
    spendWindow,
    breaker,
    health,
    levers,
    nowMs: Date.now(),
  };
}
