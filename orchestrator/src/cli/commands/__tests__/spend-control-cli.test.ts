/**
 * Integration tests for `mars daemon spend-control show` and
 * `mars daemon spend-control set` (slice mars-fc44e7b9).
 *
 * Covers the acceptance criteria:
 *   1. `show` sends the correct RPC and prints current levers as a table.
 *   2. `set` upserts supplied fields via the spend-control.set RPC.
 *   3. Invalid resume-at >= pause-at exits non-zero before contacting daemon.
 *   4. Invalid threshold outside 0–100 exits non-zero before contacting daemon.
 *   5. Invalid ceiling < 0 exits non-zero before contacting daemon.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon.
 * spend-control commands do not touch the task store, so we use a minimal stub
 * instead of the full PGlite DB stack — avoiding WASM re-init flakiness.
 */

import { describe, expect, it } from 'vitest'
import { runCommandInProcess, makeFakeDaemon } from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

// ---------------------------------------------------------------------------
// Minimal stubs — spend-control commands never access store or ctx internals.
// ---------------------------------------------------------------------------

const fakeStore = {} as unknown as DomainTaskStore

const fakeCtx: OrchestratorContext = {
  repoRoot: '/tmp/spend-ctrl-test-repo',
  stateDir: '/tmp/spend-ctrl-test-repo/.mars',
  queueDbPath: '/tmp/spend-ctrl-test-repo/.mars/queue.db',
  observabilityDbPath: '/tmp/spend-ctrl-test-repo/.mars/obs.db',
  stateDbPath: '/tmp/spend-ctrl-test-repo/.mars/state.db',
}

const DEFAULT_LEVERS = {
  perKindCeilings: null as Record<string, number> | null,
  pauseThresholdPct: 90,
  resumeThresholdPct: 70,
  suppressRecovery: false,
  rampBackStepPct: 10,
}

// ---------------------------------------------------------------------------
// spend-control show
// ---------------------------------------------------------------------------

describe('mars daemon spend-control show', () => {
  it('sends spend-control.show RPC and prints a table of levers', async () => {
    const levers = {
      perKindCeilings: { coder: 5 } as Record<string, number> | null,
      pauseThresholdPct: 80,
      resumeThresholdPct: 60,
      suppressRecovery: true,
      rampBackStepPct: 15,
    }
    const fake = makeFakeDaemon(() => levers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'show'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string }
    expect(req.op).toBe('spend-control.show')

    const output = r.out.join('\n')
    expect(output).toContain('80')   // pauseThresholdPct
    expect(output).toContain('60')   // resumeThresholdPct
    expect(output).toContain('coder') // perKindCeilings key
  })

  it('shows "(none)" when perKindCeilings is null', async () => {
    const fake = makeFakeDaemon(() => DEFAULT_LEVERS)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'show'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('none')
    expect(output).toContain('90')
    expect(output).toContain('70')
  })
})

// ---------------------------------------------------------------------------
// spend-control set — happy path
// ---------------------------------------------------------------------------

describe('mars daemon spend-control set', () => {
  it('sends spend-control.set with correct threshold patch', async () => {
    const updatedLevers = { ...DEFAULT_LEVERS, pauseThresholdPct: 85, resumeThresholdPct: 65 }
    const fake = makeFakeDaemon(() => updatedLevers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--pause-at', '85', '--resume-at', '65'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; patch: Record<string, unknown> }
    expect(req.op).toBe('spend-control.set')
    expect(req.patch['pauseThresholdPct']).toBe(85)
    expect(req.patch['resumeThresholdPct']).toBe(65)
  })

  it('sends correct coder-ceiling patch', async () => {
    const updatedLevers = { ...DEFAULT_LEVERS, perKindCeilings: { coder: 4 } }
    const fake = makeFakeDaemon(() => updatedLevers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--coder-ceiling', '4'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    const req = fake.calls[0] as { op: string; patch: Record<string, unknown> }
    expect(req.op).toBe('spend-control.set')
    const ceilings = req.patch['perKindCeilings'] as Record<string, number>
    expect(ceilings['coder']).toBe(4)
  })

  it('sends suppressRecovery=true when --suppress-recovery on', async () => {
    const updatedLevers = { ...DEFAULT_LEVERS, suppressRecovery: true }
    const fake = makeFakeDaemon(() => updatedLevers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--suppress-recovery', 'on'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const req = fake.calls[0] as { op: string; patch: Record<string, unknown> }
    expect(req.patch['suppressRecovery']).toBe(true)
  })

  it('sends suppressRecovery=false when --suppress-recovery off', async () => {
    const updatedLevers = { ...DEFAULT_LEVERS, suppressRecovery: false }
    const fake = makeFakeDaemon(() => updatedLevers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--suppress-recovery', 'off'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const req = fake.calls[0] as { op: string; patch: Record<string, unknown> }
    expect(req.patch['suppressRecovery']).toBe(false)
  })

  it('sends rampBackStepPct patch correctly', async () => {
    const updatedLevers = { ...DEFAULT_LEVERS, rampBackStepPct: 20 }
    const fake = makeFakeDaemon(() => updatedLevers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--ramp-back-step', '20'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const req = fake.calls[0] as { op: string; patch: Record<string, unknown> }
    expect(req.patch['rampBackStepPct']).toBe(20)
  })

  it('clears perKindCeilings when --coder-ceiling 0', async () => {
    const updatedLevers = { ...DEFAULT_LEVERS, perKindCeilings: null }
    const fake = makeFakeDaemon(() => updatedLevers)

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--coder-ceiling', '0'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).toBe(0)
    const req = fake.calls[0] as { op: string; patch: Record<string, unknown> }
    expect(req.patch['perKindCeilings']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// spend-control set — validation errors (CLI exits before daemon contact)
// ---------------------------------------------------------------------------

describe('mars daemon spend-control set — validation', () => {
  it('exits non-zero when resume-at == pause-at', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--pause-at', '70', '--resume-at', '70'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    const errOut = r.err.join('\n')
    expect(errOut).toMatch(/resume-at|resume/)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when resume-at > pause-at', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--pause-at', '70', '--resume-at', '80'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when pause-at is above 100', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--pause-at', '110'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    const errOut = r.err.join('\n')
    expect(errOut).toMatch(/0.{1,5}100|0–100|0-100/)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when resume-at is below 0', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--resume-at', '-5'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when coder-ceiling is negative', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--coder-ceiling', '-1'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    const errOut = r.err.join('\n')
    expect(errOut).toMatch(/non-negative|positive|>= 0|>=0/)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when suppress-recovery is not on|off', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--suppress-recovery', 'yes'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when no flags are provided', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('exits non-zero when ramp-back-step is out of range', async () => {
    const fake = makeFakeDaemon()

    const r = await runCommandInProcess(
      ['daemon', 'spend-control', 'set', '--ramp-back-step', '0'],
      { store: fakeStore, ctx: fakeCtx, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})
