/**
 * The derived `failed` action-queue row must say whether the task's worktree
 * holds uncommitted work.
 *
 * That single fact is what decides between `mars continue` and the destructive
 * `mars restart` / `mars drop` — and both destructive verbs are buttons on this
 * very row. Before this, the row named the failure signature, the branch and an
 * error excerpt, but never the one thing that made Restart dangerous. On
 * 2026-08-20 mars-70dc2672 failed with 145 uncommitted lines across three files
 * and survived only because the operator went and ran `git status` by hand.
 *
 * Probed against a REAL git worktree: the row's claim is only worth anything if
 * it agrees with what git reports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createConditionItemsSource } from '../derived-conditions.js'
import { humanSummary as recipeHumanSummary } from '../../../lib/action-queue-recipes.js'
import type { DbClient } from '../../../lib/db.js'

let repo: string
let wtPath: string

/** A DbClient that reports exactly one failed task, pointed at `wtPath`. */
const oneFailedTask = (worktreePath: string | null): DbClient => ({
  execute: async (stmt: unknown) => {
    const sql = typeof stmt === 'string' ? stmt : String((stmt as { sql?: string })?.sql ?? '')
    if (!sql.includes("t.status = 'failed'")) return { rows: [], rowsAffected: 0 }
    return {
      rows: [
        {
          id: 'mars-70dc2672',
          failure_signature: 'code:context-exhausted',
          prompt: 'implement the thing',
          updated_at: '2026-08-20T10:00:00.000Z',
          failure_reason_code: 'context-exhausted',
          failure_reason: 'context-exhausted',
          stall_diagnostics: null,
          branch: 'task/mars-70dc2672',
          worktree_path: worktreePath,
          error: 'context-exhausted: coder hit the context token budget limit.',
        },
      ],
      rowsAffected: 1,
    }
  },
  batch: async () => [],
  close: async () => {},
})

const deriveFailedRow = async (worktreePath: string | null) => {
  const source = createConditionItemsSource({
    getClient: () => oneFailedTask(worktreePath),
    crashMarkerPath: resolve(repo, 'no-crash-marker.json'),
  })
  const rows = await source.derive({ kinds: new Set(['failed']) })
  expect(rows).toHaveLength(1)
  return rows[0]!
}

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-failed-row-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repo })

  const wtDir = resolve(repo, 'worktrees')
  mkdirSync(wtDir, { recursive: true })
  wtPath = resolve(wtDir, 'mars-70dc2672')
  execFileSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'task/mars-70dc2672', wtPath, 'main'],
    { cwd: repo },
  )
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('derived `failed` row — uncommitted worktree work', () => {
  it('carries the dirty path count when the worktree holds uncommitted work', async () => {
    writeFileSync(resolve(wtPath, 'checkpoint.ts'), 'a\n')
    writeFileSync(resolve(wtPath, 'coder-exit.ts'), 'b\n')
    writeFileSync(resolve(wtPath, 'merge.ts'), 'c\n')

    const row = await deriveFailedRow(wtPath)
    expect(row.payload).toMatchObject({ worktreeDirtyCount: 3 })
  })

  it('reports 0 for a clean worktree', async () => {
    const row = await deriveFailedRow(wtPath)
    expect(row.payload).toMatchObject({ worktreeDirtyCount: 0 })
  })

  it('leaves the count null — not 0 — when the worktree cannot be inspected', async () => {
    // "I could not look" must not render as "there is nothing to lose".
    const row = await deriveFailedRow(resolve(repo, 'worktrees', 'vanished'))
    expect(row.payload['worktreeDirtyCount']).toBeNull()
  })

  it('warns in the row summary, where the Restart button is', async () => {
    writeFileSync(resolve(wtPath, 'checkpoint.ts'), 'a\n')
    writeFileSync(resolve(wtPath, 'merge.ts'), 'c\n')

    const row = await deriveFailedRow(wtPath)
    const summary = recipeHumanSummary(row.kind, row.payload)

    expect(summary).toContain('2 uncommitted path(s)')
    expect(summary).toMatch(/destroy/i)
  })

  it('says nothing extra when the worktree is clean', async () => {
    const row = await deriveFailedRow(wtPath)
    const summary = recipeHumanSummary(row.kind, row.payload)

    expect(summary).not.toMatch(/uncommitted/i)
  })
})
