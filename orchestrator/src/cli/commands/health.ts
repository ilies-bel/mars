/**
 * `health` command group: posture management for registered health checks.
 *
 * `health posture <check-id> <automatic|manual|off>` — set the operator
 *   posture for a specific check and persist it to the `health_postures` DB
 *   table. Takes effect on the next scheduled pass.
 *
 * `health posture list` — list every check that has an explicitly configured
 *   posture. Checks absent from the list are on 'automatic' (the default).
 *
 * Posture semantics:
 *   'automatic' — Default. Mars acts on a finding immediately: fix-route checks
 *                 enqueue a repair task; alert-route checks raise an action-queue
 *                 row. No operator gesture required.
 *   'manual'    — Finding surfaces as an action-queue offer (fix spec embedded).
 *                 Nothing is enacted until the operator takes the offer, at which
 *                 point the fix task is enqueued.
 *   'off'       — Check runs but no route fires for it. Other checks are
 *                 unaffected. `mars doctor` still enumerates the check.
 */

import type { Command } from '../command'
import { createDbPostureStore, type HealthCheckPosture } from '../../core/health/posture.js'

const VALID_POSTURES: readonly HealthCheckPosture[] = ['automatic', 'manual', 'off']

const isValidPosture = (v: string): v is HealthCheckPosture =>
  VALID_POSTURES.includes(v as HealthCheckPosture)

// ── health posture ─────────────────────────────────────────────────────────────

const healthPosture: Command = {
  path: 'health posture',
  summary: 'set or list per-check operator posture (automatic|manual|off)',
  usage: [
    'usage:',
    '  mars health posture <check-id> <automatic|manual|off>',
    '  mars health posture list',
  ].join('\n'),
  helpBody: [
    'Posture controls how the Steward routes a failing health-check finding.',
    '',
    '  automatic  Default. Mars acts immediately (enqueue fix, raise alert).',
    '  manual     Finding surfaces as an offer; operator enacts it explicitly.',
    '  off        Check runs but no route fires; other checks are unaffected.',
    '',
    'Takes effect on the next scheduled health pass.',
    '',
    'Examples:',
    '  mars health posture daemon-reachable off',
    '  mars health posture fragmented-repo-layout manual',
    '  mars health posture list',
  ].join('\n'),
  run: async (args, deps) => {
    const [first, second] = args.positional

    // `mars health posture list` — show all configured postures
    if (first === 'list') {
      const { resolveStateClient } = await import('../../core/store/state-client.js')
      const store = createDbPostureStore(resolveStateClient())
      const postures = await store.listPostures()
      if (postures.length === 0) {
        deps.out('no postures configured — all checks use automatic (default)')
        return { code: 0 }
      }
      for (const { checkId, posture } of postures) {
        deps.out(`${checkId}: ${posture}`)
      }
      return { code: 0 }
    }

    // `mars health posture <check-id> <value>` — set posture
    if (!first || !second) {
      deps.err(
        'usage: mars health posture <check-id> <automatic|manual|off>\n' +
          '       mars health posture list',
      )
      return { code: 1 }
    }

    if (!isValidPosture(second)) {
      deps.err(
        `invalid posture '${second}' — expected: automatic, manual, or off`,
      )
      return { code: 1 }
    }

    const { resolveStateClient } = await import('../../core/store/state-client.js')
    const store = createDbPostureStore(resolveStateClient())
    await store.setPosture(first, second)
    deps.out(`posture for '${first}' set to '${second}'`)
    return { code: 0 }
  },
}

export const healthCommands: readonly Command[] = [healthPosture]
