import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-gate-fix-subscriber-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('gate-fix-steward outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('dispatches one diagnosis per quarantined gate episode while preserving a separate quarantine notice', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { ensureQueueSchema, resolveQueueClient } = await import('../../core/queue.js')
    await ensureQueueSchema()
    const client = resolveQueueClient()
    const { addVerifyGate, quarantineVerifyGate } = await import('../../core/verify-gates.js')
    const { publishWithRetry } = await import('../../bus/publisher.js')
    const { createThread, getThread } = await import('../../core/lib/chat-store.js')
    const { MAIN_THREAD_ID } = await import('../../core/lib/pg-schema.js')
    const subscriber = await import('./gate-fix-steward.js')
    const gateId = await addVerifyGate({
      scope: 'orchestrator', name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'],
    })
    await quarantineVerifyGate(client, gateId, 'verify:typecheck/exit-1', 'origin-1')
    await subscriber.ensureGateFixStewardSubscriber(client)
    const operatorThread = await createThread('Gate monitoring')

    await publishWithRetry(client, 'verify-gate.quarantined', {
      gateId,
      originId: 'origin-1',
      failureSignature: 'verify:typecheck/exit-1',
      failureEvidence: 'error TS5023: Unknown compiler option.',
    })

    const dispatch = vi.fn().mockResolvedValue({ outcome: 'proposed', proposalId: 'proposal-1' })
    expect((await subscriber.drainGateFixSteward(client, dispatch)).processed).toBe(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      gate: { id: gateId, scope: 'orchestrator', name: 'typecheck' },
      failureEvidence: 'error TS5023: Unknown compiler option.',
    }))
    // No run is active, so the quarantine Notice lands on the main thread
    // rather than on the idle Subject the operator happens to have open.
    expect((await getThread(MAIN_THREAD_ID))?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'notice', content: expect.stringContaining('remains quarantined') }),
    ]))
    expect((await getThread(operatorThread.id))?.messages).toEqual([])

    expect((await subscriber.drainGateFixSteward(client, dispatch)).processed).toBe(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
