/**
 * Migration 0037 — the illegible-proposals backfill.
 *
 * The write boundary now splits prose into title + body, but every draft filed
 * BEFORE that change is still a 2000-3800 char blob in `title` with an empty
 * `problem` — and those are exactly the rows the operator is looking at today.
 * This exercises the backfill against a real database rather than asserting on
 * the SQL string: it inserts legacy-shaped rows, re-runs `ensureSchema`, and
 * checks what actually landed.
 *
 * The backfill must mirror `splitProposalProse` (see split-proposal-prose.test.ts)
 * and must never touch a row that already has a populated `problem` — those
 * came from structured callers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-backfill-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface Row {
  id: string
  title: string
  problem: string
}

describe('proposal title backfill (migration 0037)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('splits legacy blob rows and leaves structured rows alone', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo

    const proposals = await import('../proposals')
    const queue = await import('../queue')
    const { ensureSchema } = await import('../lib/pg-schema.js')

    await proposals.initProposals()
    const client = queue.resolveQueueClient()

    const insert = async (id: string, title: string, problem: string): Promise<void> => {
      await client.execute({
        sql: `INSERT INTO proposals (id, title, problem, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [id, title, problem, Date.now(), Date.now()],
      })
    }

    // 1. The canonical illegible draft: markdown heading + multi-paragraph body.
    await insert(
      'legacy-blob',
      '# Proposals are illegible\n\n## Symptom\n\nA wall of text.\n\nMore body.',
      '',
    )
    // 2. A single over-long line with no newline at all.
    await insert('legacy-longline', 'z '.repeat(200).trim(), '')
    // 3. A structured row from e.g. failure-reflector — must NOT be touched,
    //    even though its title is multi-line.
    await insert('structured', 'A title\nwith a second line', 'the structured problem')
    // 4. An already-short single-line row — outside the WHERE clause entirely.
    await insert('already-fine', 'Add a typecheck verify gate', '')

    // Re-run the migration batch over the now-populated table.
    await ensureSchema(client)

    const result = await client.execute({
      sql: `SELECT id, title, problem FROM proposals ORDER BY id`,
      args: [],
    })
    const byId = new Map(
      (result.rows as unknown as Row[]).map((r) => [r.id, r]),
    )

    const blob = byId.get('legacy-blob')
    expect(blob?.title).toBe('Proposals are illegible')
    expect(blob?.problem).toBe('## Symptom\n\nA wall of text.\n\nMore body.')

    const longLine = byId.get('legacy-longline')
    expect(longLine?.title.endsWith('…')).toBe(true)
    expect(longLine?.title.length).toBeLessThanOrEqual(proposals.PROPOSAL_TITLE_LIMIT)
    expect(longLine?.problem).toBe('')

    // Untouched: an explicit problem means a structured caller wrote this row.
    const structured = byId.get('structured')
    expect(structured?.title).toBe('A title\nwith a second line')
    expect(structured?.problem).toBe('the structured problem')

    const fine = byId.get('already-fine')
    expect(fine?.title).toBe('Add a typecheck verify gate')
    expect(fine?.problem).toBe('')

    // The done criterion: no row is left with an empty problem next to a
    // multi-line or over-long title.
    const offenders = await client.execute({
      sql: `SELECT count(*)::int AS n FROM proposals
             WHERE problem = ''
               AND (title LIKE '%' || chr(10) || '%' OR char_length(title) > 120)`,
      args: [],
    })
    expect((offenders.rows[0] as unknown as { n: number }).n).toBe(0)

    // Idempotent: a second pass must be a no-op, not a re-truncation.
    const before = JSON.stringify([...byId.values()])
    await ensureSchema(client)
    const again = await client.execute({
      sql: `SELECT id, title, problem FROM proposals ORDER BY id`,
      args: [],
    })
    expect(JSON.stringify(again.rows as unknown as Row[])).toBe(before)
  })
})
