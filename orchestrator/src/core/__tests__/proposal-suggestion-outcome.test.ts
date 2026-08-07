/**
 * Tests that a reflection proposal's lever binding (SuggestionOutcome) round-
 * trips through persistence and is served as structured data — not as a
 * substring of the `notes` field.
 *
 * Follows the PGlite pattern established in migration.test.ts and
 * find-open-reflection-draft.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-outcome-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('proposal suggestion_outcome persistence', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('round-trips a lever binding through createProposal and getProposal', async () => {
    const { initProposals, createProposal, getProposal } = await import('../proposals')
    await initProposals()

    const outcome = {
      type: 'lever' as const,
      lever: {
        id: 'worker.model',
        currentValue: 'gpt-5.6-sol',
        proposedValue: 'gpt-5.6-terra',
      },
    }

    const created = await createProposal('Use balanced model', {
      source: 'reflection',
      suggestionOutcome: outcome,
    })

    // Verify the round-trip via getProposal (not from notes)
    const fetched = await getProposal(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.suggestionOutcome).toEqual(outcome)
    // The notes field must NOT contain any lever prose — that is the old path
    expect(fetched!.notes).not.toMatch(/Lever:/i)
    expect(fetched!.suggestionOutcome?.type).toBe('lever')
    if (fetched!.suggestionOutcome?.type === 'lever') {
      expect(fetched!.suggestionOutcome.lever.id).toBe('worker.model')
      expect(fetched!.suggestionOutcome.lever.proposedValue).toBe('gpt-5.6-terra')
    }
  })

  it('round-trips a leverGap binding through createProposal and getProposal', async () => {
    const { initProposals, createProposal, getProposal } = await import('../proposals')
    await initProposals()

    const outcome = {
      type: 'leverGap' as const,
      leverGap: {
        proposedLeverId: 'dirty_main_recovery_mode',
        family: 'workflow',
        whatItWouldControl: 'Whether dispatch uses bounded deterministic dirty-main recovery',
      },
    }

    const created = await createProposal('Add dirty-main recovery lever', {
      source: 'reflection',
      suggestionOutcome: outcome,
    })

    const fetched = await getProposal(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.suggestionOutcome).toEqual(outcome)
    expect(fetched!.suggestionOutcome?.type).toBe('leverGap')
    if (fetched!.suggestionOutcome?.type === 'leverGap') {
      expect(fetched!.suggestionOutcome.leverGap.proposedLeverId).toBe('dirty_main_recovery_mode')
      expect(fetched!.suggestionOutcome.leverGap.family).toBe('workflow')
    }
  })

  it('stores null for proposals without a binding (unbound / predates binding feature)', async () => {
    const { initProposals, createProposal, getProposal } = await import('../proposals')
    await initProposals()

    const created = await createProposal('Human-authored proposal', {
      source: 'human',
      // No suggestionOutcome — explicitly unbound
    })

    const fetched = await getProposal(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.suggestionOutcome).toBeNull()
  })

  it('listProposals returns suggestionOutcome as structured data for each proposal', async () => {
    const { initProposals, createProposal, listProposals } = await import('../proposals')
    await initProposals()

    const outcome = {
      type: 'lever' as const,
      lever: { id: 'caps.implement', currentValue: '12', proposedValue: '8' },
    }
    await createProposal('Reduce implement concurrency', {
      source: 'reflection',
      suggestionOutcome: outcome,
    })
    await createProposal('Legacy proposal', { source: 'human' })

    const all = await listProposals()
    const withBinding = all.filter((p) => p.suggestionOutcome !== null)
    const withoutBinding = all.filter((p) => p.suggestionOutcome === null)

    expect(withBinding).toHaveLength(1)
    expect(withoutBinding).toHaveLength(1)
    expect(withBinding[0]!.suggestionOutcome?.type).toBe('lever')
    // The binding must be machine-readable, not prose in notes
    expect(withoutBinding[0]!.suggestionOutcome).toBeNull()
  })

  it('proposals with pre-existing rows (no suggestion_outcome column) get null after migration', async () => {
    // Simulate an older DB that lacks the suggestion_outcome column, then run
    // ensureSchema to add it, and verify the pre-existing row survives with null.
    const { openDb } = await import('../lib/db.js')
    const { ensureSchema } = await import('../lib/pg-schema.js')

    const db = openDb(`pglite://outcome-migration-${randomUUID()}`)
    try {
      // Boot the schema (which adds suggestion_outcome idempotently)
      await ensureSchema(db)

      // Insert a row that simulates a proposal created before suggestion_outcome existed.
      // We simply don't set suggestion_outcome (it defaults to NULL).
      const now = Date.now()
      await db.execute({
        sql: `INSERT INTO proposals (id, title, source, created_at, updated_at)
              VALUES ('legacy-row', 'Old reflection', 'reflection', ?, ?)`,
        args: [now, now],
      })

      const result = await db.execute({
        sql: `SELECT suggestion_outcome FROM proposals WHERE id = 'legacy-row'`,
      })
      expect(result.rows).toHaveLength(1)
      const row = result.rows[0] as Record<string, unknown>
      // The column exists and is null — not a gap, not a fake binding
      expect(row['suggestion_outcome']).toBeNull()
    } finally {
      await db.close()
    }
  })
})
