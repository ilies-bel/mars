/**
 * Integration test for `mars stop <id>` end-to-end (PRD mars-9234e1b2 slice 4/4).
 *
 * STATUS: blocked on slice 3 (mars-b3e7ef69). The slice-3 CLI ships the
 * `stop-task` RPC op + client wiring; without it `daemon/protocol.ts`
 * does not yet expose a `'stop-task'` request kind, and the daemon
 * handler in `daemon/server.ts` only knows how to *react* to
 * CANCELLED_FAILURE_REASON, not to receive a stop request over the UDS
 * RPC channel. Until slice 3 lands on `main`, these integration cases
 * have nothing concrete to exercise — they would be testing an API that
 * does not exist.
 *
 * This file is a scaffold so the test surface is committed and the
 * recovery task can land. Each `it.todo` names one of the five cases the
 * PRD calls out; the next agent (after slice 3 merges) fills in each
 * body and flips `.todo` to a real `it`. Do NOT delete a case — the five
 * are required for slice 4 to be considered complete.
 *
 *   1) Stop in-flight implement task during run-claude-code step.
 *   2) Stop in-flight task during the verify step (sleep verifyCmd,
 *      assert PID disappears from liveChildPids).
 *   3) Stop a queued task that never started; assert killed=false.
 *   4) Stop a blocked task with a queued dependent; assert cascade +
 *      inbox item naming the cancelled blocker.
 *   5) Stop a task already in terminal `done` state; assert refusal
 *      with a 'terminal state' message and row unchanged.
 *
 * See orchestrator/src/mastra/daemon/__tests__/http-restart.test.ts for
 * the in-process queue + repo bootstrap pattern this file should adopt
 * once the RPC exists.
 */
import { describe, it } from 'vitest'

describe('mars stop <id> — end-to-end (slice 4/4, blocked on slice 3)', () => {
  it.todo('stops an in-flight implement task during run-claude-code')
  it.todo('stops an in-flight task during verify and kills the subprocess')
  it.todo('stops a queued task without attempting SIGKILL (killed=false)')
  it.todo(
    'cascades cancellation to queued dependents and raises an inbox item',
  )
  it.todo('refuses to stop a task already in terminal `done` state')
})
