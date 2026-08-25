/**
 * The observational detectors, against a real embedded Postgres.
 *
 * These decide whether Mars speaks unprompted, so the cases that matter most
 * are the ones where it must NOT: an empty history, a quiet week, a habit
 * that is really a single event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../db.js'
import { MAIN_THREAD_ID } from '../../pg-schema.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-notice-detectors-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const load = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../../chat-store.js')
  await chat.initChatStore()
  const { resolveStateClient } = await import('../../../store/state-client.js')
  return {
    db: resolveStateClient() as DbClient,
    idle: await import('../idle-proposal.js'),
    trend: await import('../token-spend-trend.js'),
    push: await import('../manual-push.js'),
    graph: await import('../codegraph-suggestion.js'),
    chat,
  }
}

describe('notice detectors', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  describe('detectIdleProposal', () => {
    const addProposal = async (db: DbClient, id: string, title: string, createdAt: number) => {
      await db.execute({
        sql: `INSERT INTO proposals (id, title, status, created_at, updated_at)
              VALUES (?, ?, 'draft', ?, ?)`,
        args: [id, title, createdAt, createdAt],
      })
    }

    const addTask = async (db: DbClient, id: string, status: string) => {
      await db.execute({
        sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
              VALUES (?, 'x', ?, now(), now())`,
        args: [id, status],
      })
    }

    it('offers the oldest waiting draft when nothing is in flight', async () => {
      const { db, idle } = await load(repo)
      await addProposal(db, 'prop-old', 'Rework the merge gate', 1)
      await addProposal(db, 'prop-new', 'Something later', 2)

      expect(await idle.detectIdleProposal(db)).toEqual({
        proposalId: 'prop-old',
        title: 'Rework the merge gate',
      })
    })

    it('stays quiet while Mars still has work in hand', async () => {
      const { db, idle } = await load(repo)
      await addProposal(db, 'prop-1', 'A draft', 1)
      await addTask(db, 'mars-1', 'running')

      expect(await idle.detectIdleProposal(db)).toBeNull()
    })

    it('counts a blocked task as work in hand', async () => {
      const { db, idle } = await load(repo)
      await addProposal(db, 'prop-1', 'A draft', 1)
      await addTask(db, 'mars-1', 'blocked')

      expect(await idle.detectIdleProposal(db)).toBeNull()
    })

    it('has nothing to say when there is no draft', async () => {
      const { db, idle } = await load(repo)
      expect(await idle.detectIdleProposal(db)).toBeNull()
    })

    it('never offers the same draft twice', async () => {
      const { db, idle, chat } = await load(repo)
      await addProposal(db, 'prop-1', 'A draft', 1)
      await addProposal(db, 'prop-2', 'Another draft', 2)

      await chat.appendMessage(MAIN_THREAD_ID, 'assistant', 'Nothing on my side.', [
        { type: 'text', text: 'Nothing on my side.' },
        {
          type: 'preloaded_responses',
          responses: [{
            id: 'grill',
            label: 'Grill it',
            target: { type: 'client', op: 'open-proposal-subject', entityId: 'prop-1' },
          }],
        },
      ], { kind: 'notice' })

      expect((await idle.detectIdleProposal(db))?.proposalId).toBe('prop-2')
    })
  })

  describe('detectTokenSpendTrend', () => {
    const snapshot = async (db: DbClient, atMs: number, tokens: number) => {
      await db.execute({
        sql: `INSERT INTO usage_snapshots (captured_at, input_tokens, output_tokens, window_kind, raw_json)
              VALUES (to_timestamp(? / 1000.0), ?, 0, 'test', '{}'::jsonb)`,
        args: [atMs, tokens],
      })
    }

    it('reports a real rise against the operator’s own baseline', async () => {
      const { db, trend } = await load(repo)
      await snapshot(db, NOW - 20 * DAY, 1_000_000)
      await snapshot(db, NOW - 3 * DAY, 1_400_000)

      expect(await trend.detectTokenSpendTrend(db, { now: () => NOW })).toMatchObject({
        changePct: 40,
        windowDays: 14,
      })
    })

    it('stays quiet about a fall — good news that interrupts still interrupts', async () => {
      const { db, trend } = await load(repo)
      await snapshot(db, NOW - 20 * DAY, 1_000_000)
      await snapshot(db, NOW - 3 * DAY, 400_000)

      expect(await trend.detectTokenSpendTrend(db, { now: () => NOW })).toBeNull()
    })

    it('refuses to turn a quiet baseline into a dramatic percentage', async () => {
      const { db, trend } = await load(repo)
      await snapshot(db, NOW - 20 * DAY, 100)
      await snapshot(db, NOW - 3 * DAY, 100_000)

      expect(await trend.detectTokenSpendTrend(db, { now: () => NOW })).toBeNull()
    })

    it('says nothing at all with no history', async () => {
      const { db, trend } = await load(repo)
      expect(await trend.detectTokenSpendTrend(db, { now: () => NOW })).toBeNull()
    })
  })

  describe('detectManualPush', () => {
    const landed = async (db: DbClient, taskId: string, sha: string, atMs: number) => {
      await db.execute({
        sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
              VALUES (?, 'x', 'done', now(), now())`,
        args: [taskId],
      })
      await db.execute({
        sql: `INSERT INTO merge_jobs
                (id, task_id, status, integration_branch, worktree_path, branch, merged_sha, finished_at)
              VALUES (gen_random_uuid(), ?, 'done', 'main', '/wt', 'task/x', ?, to_timestamp(? / 1000.0))`,
        args: [taskId, sha, atMs],
      })
    }

    it('counts only the commits no merge job put there', async () => {
      const { db, push } = await load(repo)
      await landed(db, 'mars-1', 'a'.repeat(40), NOW - 2 * DAY)

      const result = await push.detectManualPush(db, {
        branch: 'main',
        now: () => NOW,
        listCommits: async () => ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)],
      })

      expect(result).toEqual({ commits: 3, windowDays: 14, branch: 'main', marsCommits: 1 })
    })

    it('never accuses the operator on an empty ledger', async () => {
      const { db, push } = await load(repo)

      const result = await push.detectManualPush(db, {
        branch: 'main',
        now: () => NOW,
        listCommits: async () => Array.from({ length: 50 }, (_, i) => String(i).padStart(40, '0')),
      })

      expect(result).toBeNull()
    })

    it('treats one hand-landed commit as an event, not a habit', async () => {
      const { db, push } = await load(repo)
      await landed(db, 'mars-1', 'a'.repeat(40), NOW - 2 * DAY)

      const result = await push.detectManualPush(db, {
        branch: 'main',
        now: () => NOW,
        listCommits: async () => ['a'.repeat(40), 'b'.repeat(40)],
      })

      expect(result).toBeNull()
    })

    it('attributes intermediate task-branch commits to Mars', async () => {
      const { db, push } = await load(repo)
      // SHA-C is the recorded tip of a 3-commit task branch: A → B → C.
      const shaC = 'c'.repeat(40)
      const shaB = 'b'.repeat(40)
      const shaA = 'a'.repeat(40)
      // SHA-manual was already on main before the task branch started.
      const shaManual = 'm'.repeat(40)
      await landed(db, 'mars-1', shaC, NOW - 2 * DAY)

      const result = await push.detectManualPush(db, {
        branch: 'main',
        threshold: 1,
        now: () => NOW,
        // listCommits returns all commits newest-first; shaManual is oldest.
        listCommits: async () => [shaC, shaB, shaA, shaManual],
        // git rev-list shaManual..shaC covers the 3 task-branch commits.
        listCommitRange: async (from, to) => {
          if (from === shaManual && to === shaC) return [shaC, shaB, shaA]
          return []
        },
      })

      // Only shaManual is unaccounted; the whole task branch is Mars-attributed.
      expect(result).toEqual({ commits: 1, windowDays: 14, branch: 'main', marsCommits: 1 })
    })

    it('does not misattribute a manual push interleaved between two merges', async () => {
      const { db, push } = await load(repo)
      // SHA-X: tip of the first Mars merge (single-commit task).
      // SHA-Z: tip of the second Mars merge (2-commit task: Y → Z).
      // SHA-manual: landed on main between the two Mars merges.
      const shaX = 'x'.repeat(40)
      const shaY = 'y'.repeat(40)
      const shaZ = 'z'.repeat(40)
      const shaManual = 'm'.repeat(40)
      await landed(db, 'mars-1', shaX, NOW - 4 * DAY)
      await landed(db, 'mars-2', shaZ, NOW - 1 * DAY)

      const result = await push.detectManualPush(db, {
        branch: 'main',
        threshold: 1,
        now: () => NOW,
        // Commits newest-first; shaX is oldest (it was landed first).
        listCommits: async () => [shaZ, shaY, shaManual, shaX],
        listCommitRange: async (from, to) => {
          // Range before first merge: oldest==shaX, to==shaX → empty (no commits between itself).
          if (from === shaX && to === shaX) return []
          // Range between the two merges: shaX → shaZ covers the second task branch.
          if (from === shaX && to === shaZ) return [shaZ, shaY]
          return []
        },
      })

      // shaManual falls between the two Mars ranges and must remain unaccounted.
      expect(result).toEqual({ commits: 1, windowDays: 14, branch: 'main', marsCommits: 2 })
    })
  })

  describe('detectCodegraphSuggestion', () => {
    const finishTasks = async (db: DbClient, count: number) => {
      for (let i = 0; i < count; i += 1) {
        await db.execute({
          sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
                VALUES (?, 'x', 'done', now(), now())`,
          args: [`mars-${i}`],
        })
      }
    }

    it('suggests an index once enough work has gone in without one', async () => {
      const { db, graph } = await load(repo)
      await finishTasks(db, 30)

      expect(await graph.detectCodegraphSuggestion(db, { repoRoot: repo })).toEqual({
        tasksRun: 30,
        windowDays: 7,
      })
    })

    it('does not advertise to an operator who already has traversal wired up', async () => {
      const { db, graph } = await load(repo)
      await finishTasks(db, 30)
      writeFileSync(resolve(repo, '.mcp.json'), JSON.stringify({ mcpServers: { codegraph: {} } }))

      expect(await graph.detectCodegraphSuggestion(db, { repoRoot: repo })).toBeNull()
    })

    it('accepts a different traversal tool as having solved the problem', async () => {
      const { db, graph } = await load(repo)
      await finishTasks(db, 30)
      writeFileSync(resolve(repo, '.mcp.json'), JSON.stringify({ mcpServers: { 'ast-graph': {} } }))

      expect(await graph.detectCodegraphSuggestion(db, { repoRoot: repo })).toBeNull()
    })

    it('keeps quiet on a codebase that has barely been touched', async () => {
      const { db, graph } = await load(repo)
      await finishTasks(db, 3)

      expect(await graph.detectCodegraphSuggestion(db, { repoRoot: repo })).toBeNull()
    })
  })
})
