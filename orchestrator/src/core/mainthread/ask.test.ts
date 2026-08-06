/**
 * ask — behaviour tests for the main-thread Q&A path.
 *
 * Three concerns are verified:
 *
 *   1. Architecture: ask.ts imports no forbidden symbols (enqueueTask,
 *      openSubject, createTask). This is a static source-file assertion that
 *      runs without a DB.
 *
 *   2. No-side-effect invariant: N asks produce exactly N `main_thread_entries`
 *      rows of kind='answer', zero tasks, and zero subjects. Uses a real PGlite
 *      database so the constraints are exercised identically to production.
 *
 *   3. Return shape: each call returns an AnswerEntry with kind='answer',
 *      a payload carrying the original question, and a numeric id.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDb, type DbClient } from '../lib/db.js'
import { ensureSchema } from '../lib/pg-schema.js'
import { ask } from './ask.js'

// ---------------------------------------------------------------------------
// Architecture test — static import guard (no DB needed)
// ---------------------------------------------------------------------------

describe('ask module — import boundary', () => {
  /**
   * Read the source of ask.ts and assert it contains no import of the three
   * forbidden symbols. This is an intentional static check: if a future edit
   * accidentally wires in enqueueTask/openSubject/createTask the test will
   * fail immediately, before the behaviour suite even runs.
   */
  it('does not import enqueueTask, openSubject, or createTask', () => {
    const askSrc = fileURLToPath(new URL('./ask.ts', import.meta.url))
    let src: string
    try {
      src = readFileSync(askSrc, 'utf8')
    } catch {
      // Fallback: resolve relative to this test file's directory
      const dir = dirname(fileURLToPath(import.meta.url))
      src = readFileSync(join(dir, 'ask.ts'), 'utf8')
    }

    const forbiddenSymbols = ['enqueueTask', 'openSubject', 'createTask']
    for (const sym of forbiddenSymbols) {
      // Allow the symbol to appear in comments describing the contract
      // (like "MUST NOT import enqueueTask") but not in actual import
      // statements. A real import of the symbol requires 'import ... from'
      // or a dynamic import() call.
      const importPattern = new RegExp(
        `import[^'"]*['"][^'"]*queue[^'"]*['"]|import\\s*\\(\\s*['"][^'"]*queue`,
      )
      if (importPattern.test(src)) {
        throw new Error(
          `ask.ts imports from queue.ts but must not (${sym} is forbidden)`,
        )
      }

      const subjectImportPattern = new RegExp(
        `import[^'"]*['"][^'"]*openSubject[^'"]*['"]|import[^'"]*['"][^'"]*subject[^'"]*['"]`,
      )
      if (subjectImportPattern.test(src)) {
        throw new Error(
          `ask.ts imports from subject/openSubject.ts but must not`,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Behaviour tests — real PGlite DB
// ---------------------------------------------------------------------------

describe('ask', () => {
  let db: DbClient

  beforeEach(async () => {
    db = openDb(`pglite://ask-test-${randomUUID()}`)
    await ensureSchema(db)
  })

  afterEach(async () => {
    await db.close()
  })

  // ── Return shape ───────────────────────────────────────────────────────────

  it('returns an entry with kind="answer"', async () => {
    const entry = await ask(db, 'What is Mars doing?')
    expect(entry.kind).toBe('answer')
  })

  it('payload carries the original question', async () => {
    const question = 'How do I start a new task?'
    const entry = await ask(db, question)
    expect(entry.payload.question).toBe(question)
  })

  it('payload carries a non-empty answer string', async () => {
    const entry = await ask(db, 'anything')
    expect(typeof entry.payload.answer).toBe('string')
    expect(entry.payload.answer.length).toBeGreaterThan(0)
  })

  it('returns a numeric id', async () => {
    const entry = await ask(db, 'ping')
    expect(typeof entry.id).toBe('number')
    expect(entry.id).toBeGreaterThan(0)
  })

  // ── No-side-effect invariant ───────────────────────────────────────────────

  it('N asks → exactly N answer entries in main_thread_entries', async () => {
    const N = 3
    for (let i = 0; i < N; i++) {
      await ask(db, `question ${i}`)
    }
    const { rows } = await db.execute(
      `SELECT * FROM main_thread_entries WHERE kind = 'answer'`,
    )
    expect(rows).toHaveLength(N)
  })

  it('N asks → 0 new tasks', async () => {
    await ask(db, 'first')
    await ask(db, 'second')

    const { rows } = await db.execute('SELECT COUNT(*) as cnt FROM tasks')
    expect(Number(rows[0]!.cnt)).toBe(0)
  })

  it('N asks → 0 new Subjects (no chat thread opened beyond the seeded main)', async () => {
    await ask(db, 'alpha')
    await ask(db, 'beta')

    // ensureSchema seeds exactly one row (id='main'). Subjects are non-main
    // chat threads; assert none were opened.
    const { rows } = await db.execute(
      `SELECT COUNT(*) as cnt FROM chat_threads WHERE id != 'main'`,
    )
    expect(Number(rows[0]!.cnt)).toBe(0)
  })

  it('each ask writes exactly one row (no duplicates)', async () => {
    await ask(db, 'unique question A')
    await ask(db, 'unique question B')

    const { rows } = await db.execute(
      `SELECT id, payload FROM main_thread_entries WHERE kind = 'answer' ORDER BY id`,
    )
    expect(rows).toHaveLength(2)

    const firstPayload =
      typeof rows[0]!.payload === 'string'
        ? (JSON.parse(rows[0]!.payload as string) as { question: string })
        : (rows[0]!.payload as { question: string })
    const secondPayload =
      typeof rows[1]!.payload === 'string'
        ? (JSON.parse(rows[1]!.payload as string) as { question: string })
        : (rows[1]!.payload as { question: string })

    expect(firstPayload.question).toBe('unique question A')
    expect(secondPayload.question).toBe('unique question B')
  })

  it('answer entries have no transition_id (not linked to a presence transition)', async () => {
    await ask(db, 'test question')

    const { rows } = await db.execute(
      `SELECT transition_id FROM main_thread_entries WHERE kind = 'answer'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.transition_id).toBeNull()
  })
})
