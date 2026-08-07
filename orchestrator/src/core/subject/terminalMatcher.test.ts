/**
 * terminalMatcher — behaviour tests.
 *
 * Tests verify observable outcomes through the public interface only:
 *
 * - matchTerminal correctly identifies terminal events (pure function).
 * - drainTerminalMatcher: on a matching event, alert_resolved flips to 1,
 *   closed_at stays null (lifecycle_status remains 'open'), and exactly one
 *   Closure card row is inserted for the Subject.
 * - Non-matching events leave the Subject unchanged.
 * - raiseClosureCard is idempotent — a second call inserts no extra card.
 * - terminalMatcher.ts never assigns closed_at (architecture guard).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../lib/db.js'
import type { BusEvent } from '../../bus/events.js'
import { ensureTerminalMatcher, matchTerminal, drainTerminalMatcher, raiseClosureCard, TERMINAL_MATCHER_SUBSCRIBER } from './terminalMatcher.js'
import { setLever } from '../levers/store.js'
import { __resetContextCacheForTests } from '../context.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

const publishEvent = async (
  client: DbClient,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
    args: [type, JSON.stringify(payload), Date.now()],
  })
}

/**
 * Insert a minimal Subject row directly. Returns the new Subject's id.
 * `objective` and `terminal_condition` default to '' (the schema default).
 */
const insertSubject = async (
  client: DbClient,
  opts: {
    terminalEventType: string | null
    terminalEntityId: string | null
  },
): Promise<string> => {
  const id = randomUUID()
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_threads
          (id, title, status, terminal_event_type, terminal_entity_id, created_at, updated_at)
          VALUES (?, '', 'idle', ?, ?, ?, ?)`,
    args: [id, opts.terminalEventType, opts.terminalEntityId, now, now],
  })
  return id
}

// ── Suite setup ──────────────────────────────────────────────────────────────

describe('terminalMatcher', () => {
  let client: DbClient

  beforeEach(async () => {
    client = openDb(`pglite://terminal-matcher-test-${randomUUID()}`)
    await ensureTerminalMatcher(client)
  })

  afterEach(async () => {
    await client.close()
  })

  // ── matchTerminal — pure predicate ──────────────────────────────────────────

  describe('matchTerminal', () => {
    it('returns false when the Subject has no terminal_event_type', () => {
      const subject = { id: 'thread-1', terminal_event_type: null, terminal_entity_id: null }
      const event: BusEvent = {
        id: 1,
        type: 'task.terminal',
        payload: { taskId: 'task-1', reason: 'done' },
        ts: Date.now(),
      }
      expect(matchTerminal(subject, event)).toBe(false)
    })

    it('returns false when event type does not match', () => {
      const subject = {
        id: 'thread-1',
        terminal_event_type: 'task.terminal',
        terminal_entity_id: null,
      }
      const event: BusEvent = {
        id: 1,
        type: 'task.blocked',
        payload: { taskId: 'task-1', fixTaskId: null, failureSignature: 'x', failingStep: 'verify' },
        ts: Date.now(),
      }
      expect(matchTerminal(subject, event)).toBe(false)
    })

    it('returns true when event type matches and no entity id filter is set', () => {
      const subject = {
        id: 'thread-1',
        terminal_event_type: 'task.terminal',
        terminal_entity_id: null,
      }
      const event: BusEvent = {
        id: 1,
        type: 'task.terminal',
        payload: { taskId: 'any-task', reason: 'done' },
        ts: Date.now(),
      }
      expect(matchTerminal(subject, event)).toBe(true)
    })

    it('returns true when event type and entity id both match', () => {
      const subject = {
        id: 'thread-1',
        terminal_event_type: 'task.terminal',
        terminal_entity_id: 'task-abc',
      }
      const event: BusEvent = {
        id: 1,
        type: 'task.terminal',
        payload: { taskId: 'task-abc', reason: 'done' },
        ts: Date.now(),
      }
      expect(matchTerminal(subject, event)).toBe(true)
    })

    it('returns false when entity id does not match any payload value', () => {
      const subject = {
        id: 'thread-1',
        terminal_event_type: 'task.terminal',
        terminal_entity_id: 'task-xyz',
      }
      const event: BusEvent = {
        id: 1,
        type: 'task.terminal',
        payload: { taskId: 'task-abc', reason: 'done' },
        ts: Date.now(),
      }
      expect(matchTerminal(subject, event)).toBe(false)
    })
  })

  // ── drainTerminalMatcher — database behaviour ───────────────────────────────

  describe('drainTerminalMatcher', () => {
    it('sets alert_resolved=1, leaves closed_at null, inserts exactly one Closure card', async () => {
      const subjectId = await insertSubject(client, {
        terminalEventType: 'task.terminal',
        terminalEntityId: 'task-abc',
      })
      await publishEvent(client, 'task.terminal', { taskId: 'task-abc', reason: 'done' })

      const { processed } = await drainTerminalMatcher(client)
      expect(processed).toBe(1)

      // alert.status = 'resolved'
      const threadResult = await client.execute({
        sql: `SELECT alert_resolved, closed_at FROM chat_threads WHERE id = ?`,
        args: [subjectId],
      })
      const thread = threadResult.rows[0] as Record<string, unknown>
      expect(Number(thread.alert_resolved)).toBe(1)

      // lifecycle_status = 'open' (closed_at remains null)
      expect(thread.closed_at).toBeNull()

      // Exactly one Closure card referencing this Subject
      const cardResult = await client.execute({
        sql: `SELECT id FROM cards WHERE kind = 'closure' AND subject_id = ?`,
        args: [subjectId],
      })
      expect(cardResult.rows).toHaveLength(1)
    })

    it('does not affect a Subject whose entity id does not match the event', async () => {
      const subjectId = await insertSubject(client, {
        terminalEventType: 'task.terminal',
        terminalEntityId: 'task-abc',
      })
      await publishEvent(client, 'task.terminal', { taskId: 'task-xyz', reason: 'done' })

      await drainTerminalMatcher(client)

      const threadResult = await client.execute({
        sql: `SELECT alert_resolved FROM chat_threads WHERE id = ?`,
        args: [subjectId],
      })
      const thread = threadResult.rows[0] as Record<string, unknown>
      expect(Number(thread.alert_resolved)).toBe(0)

      const cardResult = await client.execute({
        sql: `SELECT id FROM cards WHERE kind = 'closure' AND subject_id = ?`,
        args: [subjectId],
      })
      expect(cardResult.rows).toHaveLength(0)
    })

    it('does not process events of a different type', async () => {
      const subjectId = await insertSubject(client, {
        terminalEventType: 'task.terminal',
        terminalEntityId: null,
      })
      await publishEvent(client, 'task.blocked', {
        taskId: 'task-1',
        fixTaskId: null,
        failureSignature: 'verify:has-diff',
        failingStep: 'verify',
      })

      const { processed } = await drainTerminalMatcher(client)
      expect(processed).toBe(0)

      const threadResult = await client.execute({
        sql: `SELECT alert_resolved FROM chat_threads WHERE id = ?`,
        args: [subjectId],
      })
      const thread = threadResult.rows[0] as Record<string, unknown>
      expect(Number(thread.alert_resolved)).toBe(0)
    })
  })

  // ── raiseClosureCard — idempotency ──────────────────────────────────────────

  describe('raiseClosureCard', () => {
    it('inserts exactly one Closure card even when called twice for the same Subject', async () => {
      const subjectId = await insertSubject(client, {
        terminalEventType: 'task.terminal',
        terminalEntityId: null,
      })
      const subject = {
        id: subjectId,
        terminal_event_type: 'task.terminal',
        terminal_entity_id: null,
      }

      await raiseClosureCard(client, subject)
      await raiseClosureCard(client, subject)

      const cardResult = await client.execute({
        sql: `SELECT id FROM cards WHERE kind = 'closure' AND subject_id = ?`,
        args: [subjectId],
      })
      expect(cardResult.rows).toHaveLength(1)
    })

    it('inserts zero cards when the terminal-matcher lever is set to off', async () => {
      // Set up a temporary repo dir so the lever config is isolated per-test.
      const tmpDir = mkdtempSync(join(tmpdir(), 'mars-tm-lever-test-'))
      mkdirSync(join(tmpDir, '.mars'), { recursive: true })
      process.env.MARS_REPO = tmpDir
      __resetContextCacheForTests()

      try {
        setLever(TERMINAL_MATCHER_SUBSCRIBER, 'off')

        const subjectId = await insertSubject(client, {
          terminalEventType: 'task.terminal',
          terminalEntityId: null,
        })
        const subject = {
          id: subjectId,
          terminal_event_type: 'task.terminal',
          terminal_entity_id: null,
        }

        await raiseClosureCard(client, subject)

        const cardResult = await client.execute({
          sql: `SELECT id FROM cards WHERE kind = 'closure' AND subject_id = ?`,
          args: [subjectId],
        })
        expect(cardResult.rows).toHaveLength(0)
      } finally {
        delete process.env.MARS_REPO
        __resetContextCacheForTests()
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  // ── Architecture guards ──────────────────────────────────────────────────────

  it('terminalMatcher.ts does not auto-close Subjects (no closed_at assignment)', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/subject/terminalMatcher.ts'),
      'utf8',
    )
    // The matcher must never stamp closed_at — the Subject stays open until
    // the operator accepts the Closure card.
    expect(src).not.toMatch(/closed_at\s*=/)
    expect(src).not.toContain('closeSubthread')
  })

  it('terminalMatcher.ts does not hardcode producer_key or autonomy_level at an INSERT site', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/subject/terminalMatcher.ts'),
      'utf8',
    )
    // The INSERT must use variables from createCard(), not string literals.
    // This guards against the regression where 'terminal-matcher' and 'tell'
    // were hardcoded directly in the SQL.
    expect(src).not.toMatch(/INSERT INTO cards[\s\S]*?'terminal-matcher'/)
    expect(src).not.toMatch(/INSERT INTO cards[\s\S]*?'tell'/)
  })
})
