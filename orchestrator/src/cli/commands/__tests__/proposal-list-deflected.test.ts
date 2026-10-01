/**
 * Tests for the capacity-ceiling deflected tail on `mars proposal list`
 * (PRD 96ce989c, slice 8).
 *
 * The default listing excludes rows with a non-null `deflection_reason` and
 * ends with one line naming what it hid — `N deflected (mars proposal list
 * --deflected)` — so the tail stays one flag away instead of invisible.
 * `--deflected` flips the view to show only that hidden tail, each row
 * carrying its `deflection_reason`. The footer goes to stderr; proposal rows
 * always go to stdout, so a scripted reader diffing stdout never mistakes
 * the footer for a row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-list-deflected-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadEnv = async () => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const proposals = await import('../../../core/proposals')
  await proposals.initProposals()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  const stateClientModule = await import('../../../core/store/state-client')
  const { runCommandInProcess, makeFakeDaemon } = await import('../../test-adapter')
  return {
    proposals,
    db: stateClientModule.resolveStateClient(),
    run: async (argv: readonly string[]) => {
      const opts: InProcessOptions = {
        store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
        ctx: contextModule.resolveContext(repo),
        daemon: makeFakeDaemon(),
      }
      return runCommandInProcess(argv, opts)
    },
  }
}

/** Bypass the validated write path to simulate a capacity-ceiling deflection. */
const markDeflected = async (
  db: ReturnType<typeof import('../../../core/store/state-client').resolveStateClient>,
  id: string,
  reason: string,
) => {
  await db.execute({
    sql: `UPDATE proposals SET status = 'expired', deflection_reason = ? WHERE id = ?`,
    args: [reason, id],
  })
}

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('mars proposal list — deflected tail', () => {
  it('hides deflected rows and prints the count footer on stderr when N > 0', async () => {
    const { proposals, db, run } = await loadEnv()

    const kept = await proposals.createProposal('Kept draft')
    const hidden = await proposals.createProposal('Over-budget draft')
    await markDeflected(db, hidden.id, 'source-budget:reflection:5/3')

    const result = await run(['proposal', 'list'])

    expect(result.code).toBe(0)
    expect(result.out.some((l) => l.includes(kept.id.slice(0, 8)))).toBe(true)
    expect(result.out.some((l) => l.includes(hidden.id.slice(0, 8)))).toBe(false)
    // The footer is stderr-only — it must never appear in stdout, where a
    // scripted reader would otherwise mistake it for a proposal row.
    expect(result.out.some((l) => l.includes('deflected'))).toBe(false)
    expect(result.err).toEqual(['1 deflected (mars proposal list --deflected)'])
  })

  it('prints nothing extra when there are zero deflected rows', async () => {
    const { proposals, run } = await loadEnv()
    await proposals.createProposal('Only draft')

    const result = await run(['proposal', 'list'])

    expect(result.code).toBe(0)
    expect(result.err).toEqual([])
  })

  it('--deflected lists only deflected rows, each showing its deflection_reason', async () => {
    const { proposals, db, run } = await loadEnv()

    const kept = await proposals.createProposal('Kept draft')
    const hidden = await proposals.createProposal('Over-budget draft')
    const reason = 'source-budget:reflection:5/3'
    await markDeflected(db, hidden.id, reason)

    const result = await run(['proposal', 'list', '--deflected'])

    expect(result.code).toBe(0)
    expect(result.out.some((l) => l.includes(kept.id.slice(0, 8)))).toBe(false)
    const hiddenLine = result.out.find((l) => l.includes(hidden.id.slice(0, 8)))
    expect(hiddenLine).toBeDefined()
    expect(hiddenLine).toContain(reason)
    // The --deflected view is already the hidden tail — no footer to repeat.
    expect(result.err).toEqual([])
  })

  it('--source and --status filters still work unchanged alongside --deflected', async () => {
    const { proposals, db, run } = await loadEnv()

    const humanDraft = await proposals.createProposal('Human draft', { source: 'human' })
    const reflectionDraft = await proposals.createProposal('Reflection draft', {
      source: 'reflection',
    })
    const reflectionDeflected = await proposals.createProposal('Reflection over budget', {
      source: 'reflection',
    })
    await markDeflected(db, reflectionDeflected.id, 'source-budget:reflection:5/3')

    // --source still scopes to one source, and still hides that source's
    // deflected row by default.
    const bySource = await run(['proposal', 'list', '--source', 'reflection'])
    expect(bySource.code).toBe(0)
    expect(bySource.out.some((l) => l.includes(reflectionDraft.id.slice(0, 8)))).toBe(true)
    expect(bySource.out.some((l) => l.includes(humanDraft.id.slice(0, 8)))).toBe(false)
    expect(bySource.out.some((l) => l.includes(reflectionDeflected.id.slice(0, 8)))).toBe(false)

    // An explicit --status bypasses the default deflection exclusion, per
    // ListProposalsFilter semantics — the row is 'expired', so filtering on
    // that status surfaces it.
    const byStatus = await run(['proposal', 'list', '--status', 'expired'])
    expect(byStatus.code).toBe(0)
    expect(byStatus.out.some((l) => l.includes(reflectionDeflected.id.slice(0, 8)))).toBe(true)
    expect(byStatus.out.some((l) => l.includes(humanDraft.id.slice(0, 8)))).toBe(false)

    // Plain --status draft is unaffected by the new flag.
    const drafts = await run(['proposal', 'list', '--status', 'draft'])
    expect(drafts.code).toBe(0)
    expect(drafts.out.some((l) => l.includes(humanDraft.id.slice(0, 8)))).toBe(true)
    expect(drafts.out.some((l) => l.includes(reflectionDraft.id.slice(0, 8)))).toBe(true)
    expect(drafts.out.some((l) => l.includes(reflectionDeflected.id.slice(0, 8)))).toBe(false)
  })
})
