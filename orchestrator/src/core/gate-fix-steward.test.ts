import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { GateSystemicFailureEvent } from './agents/steward.js'

const event: GateSystemicFailureEvent = {
  kind: 'gate-systemic-failure',
  gate: { id: 'gate-1', scope: 'orchestrator', name: 'typecheck' },
  currentDefinition: { cmd: 'npx', args: ['tsc', '--noEmit'], required: true, tier: 'task' },
  quarantineSignature: 'verify:typecheck/exit-1',
  failureEvidence: 'error TS5023: Unknown compiler option.',
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-gate-fix-steward-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('runGateFixSteward', () => {
  it('submits a concrete changed definition for human validation', async () => {
    const { runGateFixSteward } = await import('./gate-fix-steward.js')
    const proposeGateFix = vi.fn().mockResolvedValue({ proposalId: 'proposal-1', created: true })
    const result = await runGateFixSteward(event, {
      worker: async () => JSON.stringify({
        cmd: 'npx', args: ['tsc', '--build'], required: true, tier: 'task', rationale: 'The project uses build mode.',
      }),
      proposeGateFix,
    })

    expect(result).toEqual({ outcome: 'proposed', proposalId: 'proposal-1' })
    expect(proposeGateFix).toHaveBeenCalledWith(expect.objectContaining({
      proposedDefinition: { cmd: 'npx', args: ['tsc', '--build'], required: true, tier: 'task' },
    }))
  })

  it.each([
    ['', 'empty'],
    ['not json', 'invalid'],
    [JSON.stringify({ cmd: 'npx', args: ['tsc', '--noEmit'], required: true, tier: 'task', rationale: 'unchanged' }), 'unchanged'],
  ])('keeps the gate quarantined when the result is %s', async (output, outcome) => {
    const { runGateFixSteward } = await import('./gate-fix-steward.js')
    const proposeGateFix = vi.fn()
    const raiseDiagnostic = vi.fn().mockResolvedValue(undefined)
    const result = await runGateFixSteward(event, {
      worker: async () => output,
      proposeGateFix,
      raiseDiagnostic,
    })

    expect(result.outcome).toBe(outcome)
    expect(proposeGateFix).not.toHaveBeenCalled()
    expect(raiseDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ gateId: 'gate-1' }))
  })
})

describe('stewardProposeGateFix', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates one awaiting-human proposal and a separate chat validation item', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { ensureQueueSchema } = await import('./queue.js')
    await ensureQueueSchema()
    const { getThread } = await import('./lib/chat-store.js')
    const { getGateFixProposal, stewardProposeGateFix } = await import('./gate-fix-steward.js')

    const proposal = await stewardProposeGateFix({
      event,
      proposedDefinition: { cmd: 'npx', args: ['tsc', '--build'], required: true, tier: 'task' },
      rationale: 'Use the project build entrypoint.',
    })
    const duplicate = await stewardProposeGateFix({
      event,
      proposedDefinition: { cmd: 'npx', args: ['tsc', '--build'], required: true, tier: 'task' },
      rationale: 'Use the project build entrypoint.',
    })

    expect(proposal.created).toBe(true)
    expect(duplicate).toEqual({ proposalId: proposal.proposalId, created: false })
    expect((await getGateFixProposal(proposal.proposalId))!).toMatchObject({
      status: 'awaiting-human',
      gateId: 'gate-1',
      proposedDefinition: { cmd: 'npx', args: ['tsc', '--build'], required: true, tier: 'task' },
    })
    const thread = await getThread(proposal.threadId!)
    expect(thread?.messages[0]).toMatchObject({ kind: 'validation', backing_entity_id: proposal.proposalId })
  })

  it('raises an actionable diagnostic instead of fabricating an invalid repair', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { ensureQueueSchema } = await import('./queue.js')
    await ensureQueueSchema()
    const { listActionQueueItems } = await import('./lib/action-queue.js')
    const { runGateFixSteward } = await import('./gate-fix-steward.js')

    await runGateFixSteward(event, { worker: async () => '{"cmd":""}' })

    expect(await listActionQueueItems('open')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'gate-broken',
        signature: 'gate-fix-steward:gate-1:verify:typecheck/exit-1',
      }),
    ]))
  })
})
