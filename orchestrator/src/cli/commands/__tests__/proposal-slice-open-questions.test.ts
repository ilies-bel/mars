/**
 * CLI-level tests for `mars proposal slice` — open-questions gate.
 *
 * Acceptance criteria:
 *   1. `mars proposal slice <id>` on a prd-ready proposal whose notes contain
 *      an OPEN QUESTIONS block exits non-zero and sends zero `proposal.slice`
 *      RPC requests to the daemon (no tasks enqueued).
 *   2. `mars proposal slice <id> --accept-defaults` on the same proposal exits
 *      zero and DOES send a `proposal.slice` request with acceptDefaults=true.
 *   3. A proposal with no OPEN QUESTIONS block slices normally (control case).
 *   4. After --accept-defaults, a dated DEFAULTS ACCEPTED line is appended to
 *      the proposal notes before the RPC is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-slice-oq-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Dynamically import store + ctx helpers AFTER module cache reset. */
const loadStoreAndCtx = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

/** Seed a prd-ready proposal with optional notes. */
const seedPrdReady = async (notes?: string): Promise<string> => {
  const {
    createProposal,
    addProposalUserStory,
    promoteProposal,
    initProposals,
    setProposalField,
  } = await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Slice open-questions test proposal', {
    source: 'human',
    problem: 'There is a problem',
    solution: 'Here is the solution',
  })
  await addProposalUserStory(p.id, 'As a user I can do the thing')
  if (notes !== undefined) {
    await setProposalField(p.id, 'notes', notes)
  }
  await promoteProposal(p.id)
  return p.id
}

/** Open-questions notes block (mirrors the real incident). */
const OPEN_QUESTIONS_NOTES = [
  'Background: the proposal covers a broadcast system.',
  '',
  'OPEN QUESTIONS — deliberately unresolved, flagged for the follow-up shaping pass:',
  '1. Changelog source of truth: DB table authored in admin (recommended), or ...',
  '2. Admin deliverable: REST endpoints only (recommended), or endpoints plus a page.',
].join('\n')

/** Run the command in-process using fresh module instances. */
const run = async (
  argv: readonly string[],
  responder?: (req: Record<string, unknown>) => unknown,
): Promise<{ code: number; out: string[]; err: string[]; daemonCalls: Record<string, unknown>[] }> => {
  const { runCommandInProcess, makeFakeDaemon } = await import('../../test-adapter')
  const daemonCalls: Record<string, unknown>[] = []
  const fake = makeFakeDaemon((req) => {
    daemonCalls.push(req)
    if (responder) return responder(req)
    if (req['op'] === 'proposal.slice') {
      return {
        proposalId: req['proposalId'],
        status: 'sliced',
        taskIds: ['mars-test-task-001'],
      }
    }
    return {}
  })
  const { store, ctx } = await loadStoreAndCtx()
  const result = await runCommandInProcess(argv, { store, ctx, daemon: fake })
  return { ...result, daemonCalls }
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Open-questions block → exit non-zero, no RPC sent
// ---------------------------------------------------------------------------

describe('mars proposal slice — OPEN QUESTIONS gate', () => {
  it('exits non-zero and sends zero slice RPCs when proposal has open questions', async () => {
    const id = await seedPrdReady(OPEN_QUESTIONS_NOTES)
    const { daemonCalls, code, err } = await run(['proposal', 'slice', id])

    expect(code).toBe(1)
    const sliceCalls = daemonCalls.filter((c) => c['op'] === 'proposal.slice')
    expect(sliceCalls).toHaveLength(0)

    // Error message must mention the proposal id and point toward resolution.
    const errText = err.join('\n')
    expect(errText).toContain(id)
    expect(errText).toContain('open-questions')
  })

  it('error output includes the notes block verbatim', async () => {
    const id = await seedPrdReady(OPEN_QUESTIONS_NOTES)
    const { err } = await run(['proposal', 'slice', id])
    const errText = err.join('\n')
    // The operator must see the actual questions, not just an abstract message.
    expect(errText).toContain('OPEN QUESTIONS')
    expect(errText).toContain('(recommended)')
  })
})

// ---------------------------------------------------------------------------
// 2. --accept-defaults → exit zero, RPC sent with acceptDefaults=true
// ---------------------------------------------------------------------------

describe('mars proposal slice --accept-defaults', () => {
  it('exits zero and sends a slice RPC with acceptDefaults=true', async () => {
    const id = await seedPrdReady(OPEN_QUESTIONS_NOTES)
    const { code, daemonCalls } = await run(['proposal', 'slice', id, '--accept-defaults'])

    expect(code).toBe(0)
    const sliceCalls = daemonCalls.filter((c) => c['op'] === 'proposal.slice')
    expect(sliceCalls).toHaveLength(1)
    expect(sliceCalls[0]).toMatchObject({ op: 'proposal.slice', proposalId: id, acceptDefaults: true })
  })

  it('appends a DEFAULTS ACCEPTED line to notes before sending the RPC', async () => {
    const id = await seedPrdReady(OPEN_QUESTIONS_NOTES)
    await run(['proposal', 'slice', id, '--accept-defaults'])

    // After the command the notes should contain the acceptance trace.
    const { getProposal } = await import('../../../core/proposals')
    const proposal = await getProposal(id)
    expect(proposal?.notes).toContain('DEFAULTS ACCEPTED')
  })
})

// ---------------------------------------------------------------------------
// 3. Control case — no OPEN QUESTIONS block → slices normally
// ---------------------------------------------------------------------------

describe('mars proposal slice — control case (no open questions)', () => {
  it('slices normally when notes contain no OPEN QUESTIONS block', async () => {
    const id = await seedPrdReady('Straightforward proposal with no open items.')
    const { code, daemonCalls } = await run(['proposal', 'slice', id])

    expect(code).toBe(0)
    const sliceCalls = daemonCalls.filter((c) => c['op'] === 'proposal.slice')
    expect(sliceCalls).toHaveLength(1)
    expect(sliceCalls[0]).toMatchObject({ op: 'proposal.slice', proposalId: id })
    // acceptDefaults should not be present when there are no open questions.
    expect(sliceCalls[0]).not.toHaveProperty('acceptDefaults')
  })

  it('slices normally when notes are empty', async () => {
    const id = await seedPrdReady('')
    const { code, daemonCalls } = await run(['proposal', 'slice', id])

    expect(code).toBe(0)
    const sliceCalls = daemonCalls.filter((c) => c['op'] === 'proposal.slice')
    expect(sliceCalls).toHaveLength(1)
  })
})
