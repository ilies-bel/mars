import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  addBlockers: typeof import('../../queue').addBlockers
  listBlockers: typeof import('../../queue').listBlockers
}

interface DiagnoseModule {
  setDiagnosis: typeof import('../diagnose').setDiagnosis
}

interface FollowupModule {
  runDiagnoseFollowup: typeof import('../diagnose-followup').runDiagnoseFollowup
}

interface InboxModule {
  getInboxItem: typeof import('../inbox').getInboxItem
  listInboxItems: typeof import('../inbox').listInboxItems
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-diagnose-followup-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  d: DiagnoseModule
  f: FollowupModule
  inbox: InboxModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const d = (await import('../diagnose')) as unknown as DiagnoseModule
  const f = (await import('../diagnose-followup')) as unknown as FollowupModule
  const inbox = (await import('../inbox')) as unknown as InboxModule
  return { q, d, f, inbox }
}

const seedParkedParent = async (
  q: QueueModule,
  parentPrompt = 'do the original work',
): Promise<{ parentId: string; choreId: string }> => {
  const parent = await q.enqueueTask(parentPrompt, undefined, {
    skipTriage: true,
  })
  const chore = await q.enqueueTask(
    '# Diagnose-only Chore for ' + parent.id,
    undefined,
    { skipTriage: true, kind: 'diagnose', originId: parent.id },
  )
  // Mark the Chore as done (the daemon stamps this before runDiagnoseFollowup
  // fires; the test reproduces the same sequence).
  await q.updateTask(chore.id, { status: 'done' })
  // Park the parent behind the Chore exactly the way the implement workflow's
  // too-hard branch does it.
  await q.addBlockers(parent.id, [chore.id])
  await q.updateTask(parent.id, { status: 'blocked', failedPhase: 'code' })
  return { parentId: parent.id, choreId: chore.id }
}

describe('runDiagnoseFollowup', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    delete process.env.MARS_REPO
  })

  it('on root-cause: dispatches exactly one fix attempt seeded with the diagnosis and re-parks the parent behind it', async () => {
    const { q, d, f } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'root-cause-found',
      evidence: 'helper foo() is not exported from src/utils.ts',
      involvedFiles: ['src/utils.ts', 'src/consumer.ts'],
      fixDirection: 'add `export` to foo and re-run the consumer',
    })

    const outcome = await f.runDiagnoseFollowup(choreId)
    expect(outcome.action).toBe('fix-dispatched')
    expect(outcome.fixTaskId).toBeDefined()
    expect(outcome.parentTaskId).toBe(parentId)

    // The fix prompt carries the recorded diagnosis verbatim.
    const fix = await q.getTask(outcome.fixTaskId!)
    expect(fix?.prompt).toContain('helper foo() is not exported')
    expect(fix?.prompt).toContain('src/utils.ts')
    expect(fix?.prompt).toContain('src/consumer.ts')
    expect(fix?.prompt).toContain('add `export` to foo')
    // The fix is an ordinary task, not another diagnose Chore.
    expect(fix?.kind).toBe('task')
    expect(fix?.status).toBe('queued')

    // The parent is parked blocked behind the fix only — the diagnose
    // Chore's stale edge has been removed.
    const parent = await q.getTask(parentId)
    expect(parent?.status).toBe('blocked')
    const blockers = await q.listBlockers(parentId)
    expect(blockers).toEqual([outcome.fixTaskId])
  })

  it('on inconclusive: parks the parent failed, raises one inbox item carrying what-was-checked and why-unscoped, dispatches no fix', async () => {
    const { q, d, f, inbox } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'walked src/foo, src/bar, looked for the missing helper',
      whyUnscoped: 'task references a module that does not exist in the repo',
    })

    const outcome = await f.runDiagnoseFollowup(choreId)
    expect(outcome.action).toBe('inbox-raised')
    expect(outcome.inboxItemId).toBeDefined()

    const parent = await q.getTask(parentId)
    expect(parent?.status).toBe('failed')
    expect(parent?.failedPhase).toBe('code')

    // No fix attempt was created.
    const item = await inbox.getInboxItem(outcome.inboxItemId!)
    expect(item?.kind).toBe('diagnose-inconclusive')
    expect(item?.body).toContain('walked src/foo')
    expect(item?.body).toContain('does not exist in the repo')
  })

  it('on no-verdict (Chore exited without recording): treats as inconclusive — parent failed, one inbox item, no fix', async () => {
    const { q, f, inbox } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    // Deliberately skip setDiagnosis — emulate a Chore that exited cleanly
    // but forgot to record a verdict.

    const outcome = await f.runDiagnoseFollowup(choreId)
    expect(outcome.action).toBe('inbox-raised')
    expect(outcome.verdictKind).toBe('no-verdict')

    const parent = await q.getTask(parentId)
    expect(parent?.status).toBe('failed')

    const item = await inbox.getInboxItem(outcome.inboxItemId!)
    expect(item?.title).toMatch(/no verdict/i)
    expect(item?.body).toMatch(/treated as inconclusive/i)
  })

  it('dedups the inbox item under re-processing of the same dead end (one item, not a pile)', async () => {
    const { q, d, f, inbox } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'x',
      whyUnscoped: 'y',
    })

    const first = await f.runDiagnoseFollowup(choreId)
    // Re-running the followup is a no-op (parent already failed, no
    // blocker edge), but if the daemon re-fires `task.done` after a
    // crash/restart, the dedup must still hold. Simulate that by
    // re-adding the edge and re-running.
    await q.getClient().execute({
      sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
      args: [parentId, choreId, new Date().toISOString()],
    })
    const second = await f.runDiagnoseFollowup(choreId)

    expect(first.action).toBe('inbox-raised')
    expect(second.action).toBe('inbox-raised')
    expect(second.inboxItemId).toBe(first.inboxItemId)

    const allItems = await inbox.listInboxItems('open')
    const diagnoseItems = allItems.filter(
      (i) => i.kind === 'diagnose-inconclusive',
    )
    expect(diagnoseItems).toHaveLength(1)
  })

  it('never spawns another diagnose Chore on any verdict', async () => {
    const { q, d, f } = await loadModules(repo)
    const { choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'root-cause-found',
      evidence: 'e',
      involvedFiles: ['f.ts'],
      fixDirection: 'do z',
    })

    await f.runDiagnoseFollowup(choreId)

    const all = await q
      .getClient()
      .execute({ sql: `SELECT kind FROM tasks`, args: [] })
    const kinds = (all.rows as unknown as { kind: string | null }[]).map((r) =>
      r.kind,
    )
    const diagnoseCount = kinds.filter((k) => k === 'diagnose').length
    expect(diagnoseCount).toBe(1) // only the original Chore
  })

  it('no-ops cleanly when called on a non-diagnose task', async () => {
    const { q, f } = await loadModules(repo)
    const ordinary = await q.enqueueTask('ordinary', undefined, {
      skipTriage: true,
    })
    await q.updateTask(ordinary.id, { status: 'done' })

    const outcome = await f.runDiagnoseFollowup(ordinary.id)
    expect(outcome.action).toBe('noop')
  })

  it('no-ops cleanly when the diagnose Chore has no parent edge (orphan)', async () => {
    const { q, f } = await loadModules(repo)
    // Build a diagnose Chore that nobody points at.
    const orphan = await q.enqueueTask('orphan chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(orphan.id, { status: 'done' })
    const outcome = await f.runDiagnoseFollowup(orphan.id)
    expect(outcome.action).toBe('noop')
    expect(outcome.parentTaskId).toBeNull()
  })
})
