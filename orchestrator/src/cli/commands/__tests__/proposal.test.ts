/**
 * Tests for `mars proposal slice` / `mars proposal reslice` around the
 * stranded-slicing-claim scenario.
 *
 * Acceptance criteria (must not regress):
 *   1. A proposal stranded at `slicing` with no live Slicer CAN be advanced:
 *      `mars proposal slice <id>` sends the `proposal.slice` RPC to the daemon
 *      even when the proposal's local DB status is `slicing` (the CLI does not
 *      locally gate on status — recovery is the daemon's responsibility).
 *   2. When the daemon rejects `proposal.slice` with a "not claimable" error
 *      (genuine concurrent slice in flight), the error output names the recovery
 *      command (`mars proposal slice` / `mars sync`).
 *   3. When `mars proposal reslice` is called on a `slicing` proposal the error
 *      names `mars proposal slice <id>` as the command to release the stale
 *      claim and retry.
 *
 * Root-cause note: the daemon's `handleProposalSlice` now auto-releases a
 * stale `slicing` claim (where `proposalSliceRuns` has no in-flight entry for
 * the proposal) before calling `runSlice`.  These tests validate the
 * user-facing contract rather than the daemon internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-test-'))
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

/** Seed a prd-ready proposal and return its id. */
const seedPrdReady = async (): Promise<string> => {
  const {
    createProposal,
    addProposalUserStory,
    promoteProposal,
    initProposals,
  } = await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Stranded slicing test', {
    source: 'human',
    problem: 'There is a problem',
    solution: 'Here is the solution',
  })
  await addProposalUserStory(p.id, 'As a user I can do the thing')
  await promoteProposal(p.id)
  return p.id
}

/**
 * Seed a proposal that is stranded at `slicing` (claim taken, no live Slicer).
 * This models a daemon restart after `claimProposalForSlicing` set status to
 * `slicing` but before the outer catch could revert it.
 */
const seedStranded = async (): Promise<string> => {
  const {
    createProposal,
    addProposalUserStory,
    promoteProposal,
    claimProposalForSlicing,
    initProposals,
  } = await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Stranded slicing test', {
    source: 'human',
    problem: 'There is a problem',
    solution: 'Here is the solution',
  })
  await addProposalUserStory(p.id, 'As a user I can do the thing')
  await promoteProposal(p.id)
  // Atomically claim for slicing — this is what handleProposalSlice does
  // internally.  Leaving the claim uncompleted models the stranded state.
  const claimed = await claimProposalForSlicing(p.id)
  if (!claimed) throw new Error('setup failed: could not claim proposal for slicing')
  return p.id
}

/** Run the command in-process using fresh module instances. */
const run = async (
  argv: readonly string[],
  responder?: (req: Record<string, unknown>) => unknown,
): Promise<{
  code: number
  out: string[]
  err: string[]
  daemonCalls: Record<string, unknown>[]
}> => {
  const { runCommandInProcess, makeFakeDaemon } = await import('../../test-adapter')
  const daemonCalls: Record<string, unknown>[] = []
  const fake = makeFakeDaemon((req) => {
    daemonCalls.push(req)
    if (responder) return responder(req)
    if (req['op'] === 'proposal.slice') {
      return { proposalId: req['proposalId'], status: 'sliced', taskIds: ['mars-test-001'] }
    }
    if (req['op'] === 'proposal.reslice') {
      return { proposalId: req['proposalId'], status: 'sliced', taskIds: ['mars-test-002'] }
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
// 1. Stranded proposal — CLI sends the RPC without local status gating
// ---------------------------------------------------------------------------

describe('mars proposal slice — stranded slicing claim', () => {
  it('sends proposal.slice RPC even when the proposal DB status is slicing', async () => {
    // A proposal stranded at slicing has its DB status = 'slicing'. The CLI
    // must NOT gate on that locally — it must forward the RPC to the daemon,
    // which owns the stale-claim release logic.
    const id = await seedStranded()

    const { code, daemonCalls } = await run(['proposal', 'slice', id])

    expect(code).toBe(0)
    const sliceCalls = daemonCalls.filter((c) => c['op'] === 'proposal.slice')
    expect(sliceCalls).toHaveLength(1)
    expect(sliceCalls[0]).toMatchObject({ op: 'proposal.slice', proposalId: id })
  })

  it('prints the task ids returned by the daemon after releasing a stranded claim', async () => {
    const id = await seedStranded()

    const { code, out } = await run(['proposal', 'slice', id])

    expect(code).toBe(0)
    // The daemon returns taskIds which the CLI should echo.
    const combined = out.join('\n')
    expect(combined).toContain('mars-test-001')
  })
})

// ---------------------------------------------------------------------------
// 2. Error message names recovery when daemon rejects (genuine concurrent slice)
// ---------------------------------------------------------------------------

describe('mars proposal slice — not-claimable error names recovery', () => {
  it('error output includes mars sync or mars proposal slice as recovery when daemon rejects', async () => {
    // Simulate the error the daemon emits when a genuine concurrent slice holds
    // the claim.  The improved error message must name a recovery command so the
    // operator knows what to do.
    const id = await seedStranded()

    const { code, err } = await run(['proposal', 'slice', id], (req) => {
      if (req['op'] === 'proposal.slice') {
        throw new Error(
          `proposal ${req['proposalId']} is not claimable for slicing ` +
            `(status='slicing'; already slicing or sliced). ` +
            `If this is a stale claim from a prior daemon run, run ` +
            `\`mars proposal slice ${req['proposalId']}\` — the daemon auto-releases ` +
            `the stale claim before re-slicing. Alternatively run \`mars sync\` ` +
            `to sweep all stranded claims.`,
        )
      }
      return {}
    })

    expect(code).toBe(1)
    const errText = err.join('\n')
    // The error must name at least one actionable recovery command.
    const namesRecovery =
      errText.includes('mars proposal slice') || errText.includes('mars sync')
    expect(namesRecovery).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. mars proposal reslice on a slicing proposal → error names recovery
// ---------------------------------------------------------------------------

describe('mars proposal reslice — slicing proposal error names recovery', () => {
  it('error message for a slicing proposal names mars proposal slice as recovery', async () => {
    // reslice requires status='sliced'.  When status='slicing' the daemon
    // should name the command that unblocks the operator.
    const id = await seedStranded()

    const { code, err } = await run(['proposal', 'reslice', id, '--feedback', 'redo slices'], (req) => {
      if (req['op'] === 'proposal.reslice') {
        throw new Error(
          `proposal ${req['proposalId']} is 'slicing'; only 'sliced' proposals can be resliced. ` +
            `To release a stale slicing claim (e.g. after a daemon restart), run ` +
            `\`mars proposal slice ${req['proposalId']}\` — it auto-releases the claim and re-slices.`,
        )
      }
      return {}
    })

    expect(code).toBe(1)
    const errText = err.join('\n')
    expect(errText).toContain('slicing')
    // Must name the recovery command.
    expect(errText).toContain('mars proposal slice')
  })
})

// ---------------------------------------------------------------------------
// 4. Verify that revertSlicingProposalToReady returns proposal to prd-ready
//    (the primitive the daemon auto-release relies on)
// ---------------------------------------------------------------------------

describe('revertSlicingProposalToReady — stranded claim is recoverable', () => {
  it('a slicing proposal returns to prd-ready after revert', async () => {
    // This verifies the low-level primitive that handleProposalSlice calls.
    // If this breaks, the auto-release in the daemon cannot work.
    const id = await seedStranded()

    const { getProposal, revertSlicingProposalToReady } =
      await import('../../../core/proposals')

    const before = await getProposal(id)
    expect(before?.status).toBe('slicing')

    await revertSlicingProposalToReady(id)

    const after = await getProposal(id)
    expect(after?.status).toBe('prd-ready')
  })

  it('after revert a new claimProposalForSlicing succeeds', async () => {
    // The full cycle: strand → revert → re-claim.  Mirrors what the daemon's
    // auto-release does before calling runSlice.
    const id = await seedStranded()

    const { getProposal, revertSlicingProposalToReady, claimProposalForSlicing } =
      await import('../../../core/proposals')

    await revertSlicingProposalToReady(id)
    const afterRevert = await getProposal(id)
    expect(afterRevert?.status).toBe('prd-ready')

    const claimed = await claimProposalForSlicing(id)
    expect(claimed).toBe(true)
    const afterClaim = await getProposal(id)
    expect(afterClaim?.status).toBe('slicing')
  })
})

// ---------------------------------------------------------------------------
// 5. @<path>-in-title guard: proposal add / proposal set title
// ---------------------------------------------------------------------------

describe('@<path>-in-title guard', () => {
  let bodyFile: string

  beforeEach(() => {
    // Create a real file so existsSync() returns true for our @<path> token.
    bodyFile = resolve(mkdtempSync(resolve(tmpdir(), 'mars-at-path-test-')), 'body.md')
    writeFileSync(bodyFile, 'proposal body content\n')
  })

  afterEach(() => {
    rmSync(resolve(bodyFile, '..'), { recursive: true, force: true })
  })

  it('proposal add --title containing a resolvable @<path> is rejected non-zero', async () => {
    const { code, err } = await run(['proposal', 'add', 'body text', '--title', `My Title @${bodyFile}`])

    expect(code).not.toBe(0)
    const errText = err.join('\n')
    expect(errText).toContain(`@${bodyFile}`)
    // Must name the correct alternative so the operator knows what to do.
    expect(errText).toContain('mars proposal add')
  })

  it('proposal add --title with a non-path @ (e.g. email, @media) is accepted', async () => {
    // '@media' and 'user@example.com' do not resolve to existing files on disk
    // so the guard must NOT reject them.
    const { code } = await run(
      ['proposal', 'add', 'body text', '--title', 'My @media DEC-8 proposal'],
    )
    // The CLI reaches the daemon call; our fake daemon returns {} for
    // proposal.create which the real handler would reject, but the guard
    // itself does not fire — so code must NOT be 2 (the guard's exit code).
    expect(code).not.toBe(2)
  })

  it('proposal add --title without @ is accepted normally', async () => {
    const { code } = await run(
      ['proposal', 'add', 'body text', '--title', 'Plain title no at-sign'],
    )
    expect(code).not.toBe(2)
  })

  it('proposal set <id> title containing a resolvable @<path> is rejected non-zero', async () => {
    const id = await seedPrdReady()

    const { code, err } = await run(['proposal', 'set', id, 'title', `My Title @${bodyFile}`])

    expect(code).not.toBe(0)
    const errText = err.join('\n')
    expect(errText).toContain(`@${bodyFile}`)
    // Must point the operator at a body field.
    expect(errText).toContain('mars proposal set')
  })

  it('proposal set <id> title with a non-path @ is accepted', async () => {
    const id = await seedPrdReady()

    const { code } = await run(['proposal', 'set', id, 'title', 'My @media proposal'])
    // Guard does not fire; command reaches the daemon. Our fake returns {} which
    // is treated as a successful update (code 0).
    expect(code).not.toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 6. `proposal add --problem/--solution`: PRD body fields at creation time
// ---------------------------------------------------------------------------

describe('proposal add --problem/--solution', () => {
  let bodyDir: string
  let problemFile: string

  beforeEach(() => {
    bodyDir = mkdtempSync(resolve(tmpdir(), 'mars-prd-body-test-'))
    problemFile = resolve(bodyDir, 'problem.md')
    // Trailing newline is deliberate: it must be stripped, exactly as the
    // positional @<file> channel strips it.
    writeFileSync(problemFile, 'The CLI cannot populate PRD fields.\n')
  })

  afterEach(() => {
    rmSync(bodyDir, { recursive: true, force: true })
  })

  it('forwards --problem @<file> contents, minus one trailing newline', async () => {
    const { code, daemonCalls } = await run([
      'proposal', 'add', 'goal text', '--problem', `@${problemFile}`,
    ])

    expect(code).toBe(0)
    expect(daemonCalls[0]).toMatchObject({
      op: 'proposal.create',
      goal: 'goal text',
      problem: 'The CLI cannot populate PRD fields.',
    })
  })

  it('forwards an inline --solution verbatim', async () => {
    const { code, daemonCalls } = await run([
      'proposal', 'add', 'goal text', '--solution', 'Add the two flags.',
    ])

    expect(code).toBe(0)
    expect(daemonCalls[0]).toMatchObject({
      op: 'proposal.create',
      solution: 'Add the two flags.',
    })
  })

  it('omits both fields entirely when neither flag is supplied', async () => {
    // Absence must stay absence: `createProposal` distinguishes "no problem
    // given" (derive it from a multi-line goal) from an explicit one, so
    // sending `problem: undefined` would change behaviour.
    const { code, daemonCalls } = await run(['proposal', 'add', 'goal text'])

    expect(code).toBe(0)
    expect(daemonCalls[0]).not.toHaveProperty('problem')
    expect(daemonCalls[0]).not.toHaveProperty('solution')
  })

  it('rejects an unreadable --problem file, naming the flag and the path', async () => {
    const missing = resolve(bodyDir, 'does-not-exist.md')

    const { code, err, daemonCalls } = await run([
      'proposal', 'add', 'goal text', '--problem', `@${missing}`,
    ])

    expect(code).not.toBe(0)
    const errText = err.join('\n')
    expect(errText).toContain('--problem')
    expect(errText).toContain(missing)
    // No proposal may be created from a body that could not be read.
    expect(daemonCalls).toHaveLength(0)
  })

  it('rejects two arguments both reading stdin instead of storing an empty field', async () => {
    const { code, err, daemonCalls } = await run([
      'proposal', 'add', '-', '--problem', '-',
    ])

    expect(code).not.toBe(0)
    expect(err.join('\n')).toContain('--problem')
    expect(daemonCalls).toHaveLength(0)
  })

  it('names the accepted flags and `proposal set` when given an undeclared flag', async () => {
    const { code, err, daemonCalls } = await run([
      'proposal', 'add', 'goal text', '--notes', 'some notes',
    ])

    expect(code).not.toBe(0)
    const errText = err.join('\n')
    expect(errText).toContain('--notes')
    // The whole point of the hint: both routes to a PRD body are named.
    expect(errText).toContain('--problem')
    expect(errText).toContain('mars proposal set')
    expect(daemonCalls).toHaveLength(0)
  })
})
