import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
}

const loadMods = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = await import('../proposals')
  const q = (await import('../queue')) as unknown as QueueMod
  await p.initProposals()
  await q.migrateQueueSchema()
  return { p, q }
}

const countAdded = async (q: QueueMod): Promise<number> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT COUNT(*) AS n FROM events WHERE type = 'proposal.added'`,
    args: [],
  })
  return Number((r.rows[0] as unknown as { n: unknown }).n)
}

describe('over-budget proposal deflection', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-deflect-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ proposalBudgets: { 'failure-reflector': 1, human: 1 } }),
    )
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('agent source past its ceiling is recorded expired with a reason and no bus event', async () => {
    const { p, q } = await loadMods(repo)
    const agent = { kind: 'agent', name: 'reflector' } as const
    const opts = { source: 'failure-reflector', author: agent } as const
    const a = await p.createProposal('Alpha crash in the merge gate', opts)
    const b = await p.createProposal('Zulu timeout in the dispatcher', opts)
    const c = await p.createProposal('Kilo leak in the watcher loop', opts)

    expect(a.status).toBe('draft')
    expect(a.deflectionReason).toBeNull()
    expect(b.status).toBe('draft')
    expect(c.status).toBe('expired')
    expect(c.deflectionReason).toBe('source-budget:failure-reflector:2/1')
    expect((await p.getProposal(c.id))?.deflectionReason).toBe(c.deflectionReason)
    expect(await countAdded(q)).toBe(2)
  })

  it('human source at the same volume stays a normal draft with a bus event', async () => {
    const { p, q } = await loadMods(repo)
    const titles = ['Alpha crash in the merge gate', 'Zulu timeout in the dispatcher', 'Kilo leak in the watcher loop']
    const out = []
    for (const t of titles) out.push(await p.createProposal(t, { source: 'human' }))

    expect(out.map((x) => x.status)).toEqual(['draft', 'draft', 'draft'])
    expect(out.every((x) => x.deflectionReason === null)).toBe(true)
    expect(await countAdded(q)).toBe(3)
  })
})
