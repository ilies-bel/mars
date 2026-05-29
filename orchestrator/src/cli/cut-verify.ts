/**
 * `mars cut verify <phase>` — gate checks for the hard-cut to 4-letter id tags.
 *
 * Three phases, each corresponding to a gate in the runbook:
 *
 *   drain     — exits 0 only when no tasks are in queued/blocked/running.
 *   reset     — exits 0 only when every id-bearing table has zero rows.
 *   recreate  — exits 0 only when no forbidden ids appear, and prints a
 *               checklist of the seven carry-forward proposal titles.
 *
 * See orchestrator/docs/runbook-cut-tagged-ids.md for the full procedure.
 */

import { openLibsql } from '../mastra/lib/libsql'
import { resolveContext } from '../mastra/context'

/** The seven proposals that must be re-entered after the cut (PRD 52ec700f slice 9). */
const CARRY_FORWARD: ReadonlyArray<{ readonly hex: string; readonly title: string }> = [
  {
    hex: '5f10ed5f',
    title: 'Opt-in self-evolve trigger: KPI drift raises a draft proposal, off by default',
  },
  {
    hex: '6b38e6f9',
    title: 'Surface the ADR-0038 KPI vector and KPI drift on the read-only dashboard via daemon HTTP',
  },
  {
    hex: '9a2ab5f8',
    title:
      'Persist the ADR-0038 four-KPI vector and a rolling baseline off the queryable workflow surface',
  },
  {
    hex: '3a1350a3',
    title:
      'Relocate the UI and its server out of the orchestrator’s working directory; remove all direct .mars/mars.db reads from the UI; route every UI-to-daemon interaction through the daemon’s HTTP server',
  },
  {
    hex: '0b913df6',
    title: 'Synapse-style visual workflow canvas',
  },
  {
    hex: 'e7fde97b',
    title:
      'Route every task status write through one validated transition checkpoint that refuses illegal lifecycle edges',
  },
  {
    hex: '38898433',
    title: 'Guard merge step: abort early if main has unstaged changes',
  },
]

/**
 * Hex suffixes of ids that MUST NOT reappear after the cut.
 *
 *   04830c8e — superseded PRD (centralise-id-generation).
 *   07201a16 — dropped bug-fix proposal (failing tests).
 *   26471262 — dropped bug-fix proposal (TypeScript errors).
 */
const FORBIDDEN_HEX: ReadonlyArray<string> = ['04830c8e', '07201a16', '26471262']

/**
 * All user-facing tables that must be empty after a DB reset.
 * Junction tables are included because they hold edges that reference entities
 * and must also be cleared as part of a clean reset.
 */
const ENTITY_TABLES: ReadonlyArray<string> = [
  'tasks',
  'proposals',
  'task_blockers',
  'task_signals',
  'task_proposal_blockers',
  'task_acceptance',
  'task_transcripts',
  'self_heal_attempts',
  'events',
  'kpi_snapshots',
  'inbox_items',
  'inbox_history',
  'proposal_user_stories',
  'proposal_dependencies',
]

/**
 * Tables that carry TEXT Mars ids (for the recreate forbidden-id scan).
 * Only these can contain the forbidden hex suffixes.
 */
const ID_COLUMNS: ReadonlyArray<{ readonly table: string; readonly col: string }> = [
  { table: 'tasks', col: 'id' },
  { table: 'proposals', col: 'id' },
  { table: 'task_acceptance', col: 'id' },
  { table: 'kpi_snapshots', col: 'id' },
  { table: 'inbox_items', col: 'id' },
  { table: 'inbox_history', col: 'id' },
]

export type CutPhase = 'drain' | 'reset' | 'recreate'

export const isCutPhase = (s: unknown): s is CutPhase =>
  s === 'drain' || s === 'reset' || s === 'recreate'

/**
 * Run a single cut-verify gate check. Writes human-readable output to stdout
 * and exits non-zero on failure.
 *
 * @param phase   Which gate to check.
 * @param repo    Override repo root (uses MARS_REPO / git detection when omitted).
 */
export async function runCutVerify(phase: CutPhase, repo?: string): Promise<void> {
  const ctx = resolveContext(repo)
  const c = openLibsql({ url: `file:${ctx.queueDbPath}` })

  if (phase === 'drain') {
    let inFlight: Array<{ id: string; status: string; prompt: string }> = []
    try {
      const r = await c.execute(
        `SELECT id, status, prompt FROM tasks
          WHERE status IN ('queued','blocked','running')
          ORDER BY id`,
      )
      inFlight = r.rows.map((row) => ({
        id: String((row as unknown as { id: string }).id ?? ''),
        status: String((row as unknown as { status: string }).status ?? ''),
        prompt: String((row as unknown as { prompt: string }).prompt ?? ''),
      }))
    } catch {
      // tasks table may not exist on a fresh or deleted DB — treat as empty.
    }
    if (inFlight.length === 0) {
      console.log('drain: ✓ no in-flight tasks')
      return
    }
    console.error(`drain: ${inFlight.length} in-flight task(s) remain:`)
    for (const { id, status, prompt } of inFlight) {
      console.error(`  ${id}  [${status}]  ${prompt.slice(0, 70)}`)
    }
    process.exit(1)
  }

  if (phase === 'reset') {
    const nonEmpty: string[] = []
    for (const table of ENTITY_TABLES) {
      let n = 0
      try {
        const r = await c.execute(`SELECT COUNT(*) AS n FROM ${table}`)
        n = Number((r.rows[0] as unknown as { n: number | bigint }).n ?? 0)
      } catch {
        // Table may not exist yet (freshly created DB) — treat as empty.
        n = 0
      }
      if (n > 0) nonEmpty.push(`${table} (${n} row${n !== 1 ? 's' : ''})`)
    }
    if (nonEmpty.length === 0) {
      console.log(`reset: ✓ all ${ENTITY_TABLES.length} tables empty`)
      return
    }
    console.error(`reset: ${nonEmpty.length} table(s) still have rows:`)
    for (const entry of nonEmpty) console.error(`  ${entry}`)
    process.exit(1)
  }

  // phase === 'recreate'
  const hits: string[] = []
  for (const { table, col } of ID_COLUMNS) {
    let ids: string[] = []
    try {
      const r = await c.execute(`SELECT ${col} FROM ${table}`)
      ids = r.rows.map((row) =>
        String((row as unknown as Record<string, string>)[col] ?? ''),
      )
    } catch {
      // Table may not exist (fresh DB) — no ids to check.
    }
    for (const id of ids) {
      for (const forbidden of FORBIDDEN_HEX) {
        if (id === forbidden || id.includes(forbidden)) {
          hits.push(`${table}.${col}='${id}' contains forbidden hex '${forbidden}'`)
        }
      }
    }
  }

  // Collect all proposal ids for the carry-forward checklist.
  let proposalIds: string[] = []
  try {
    const r = await c.execute(`SELECT id FROM proposals`)
    proposalIds = r.rows.map((row) =>
      String((row as unknown as { id: string }).id ?? ''),
    )
  } catch {
    // Fresh DB — no proposals yet.
  }

  console.log('Carry-forward proposals:')
  for (const { hex, title } of CARRY_FORWARD) {
    const found = proposalIds.some((id) => id.includes(hex))
    const mark = found ? '✓' : '✗'
    console.log(`  [${mark}] ${title}`)
  }

  if (hits.length > 0) {
    console.error(`recreate: ${hits.length} forbidden id(s) found:`)
    for (const hit of hits) console.error(`  ${hit}`)
    process.exit(1)
  }

  console.log('recreate: ✓ no forbidden ids found')
}
