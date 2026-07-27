/**
 * Round-trip test: setReviewPacket → getReviewPacket preserves the packet
 * shape exactly. Verifies schema parse, JSON serialisation, and DB plumbing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ReviewPacket } from '../../lib/review-packet'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-review-packet-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const storeModule = await import('../task-store')
  const queueModule = await import('../../queue')
  await queueModule.migrateQueueSchema()
  return { storeModule, queueModule }
}

describe('review-packet round-trip', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('writes a full-review packet and reads it back with deep equality', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('test task for review packet', undefined, {
      skipTriage: true,
    })

    const packet: ReviewPacket = {
      type: 'full-review',
      generatedAt: '2026-07-27T00:00:00.000Z',
      findings: [
        {
          category: 'correctness',
          severity: 'error',
          message: 'Off-by-one in loop bound',
          file: 'src/foo.ts',
          line: 42,
        },
        {
          category: 'security',
          severity: 'warn',
          message: 'User input not sanitised',
        },
      ],
    }

    await store.setReviewPacket(task.id, packet)
    const retrieved = await store.getReviewPacket(task.id)

    expect(retrieved).toEqual(packet)
  })

  it('returns null when no packet has been stored', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('no packet task', undefined, {
      skipTriage: true,
    })

    const retrieved = await store.getReviewPacket(task.id)
    expect(retrieved).toBeNull()
  })

  it('writes a targeted-diff packet and reads it back with deep equality', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const store = storeModule.createTaskStore(queueModule.resolveQueueClient())

    const task = await store.enqueueTask('targeted diff task', undefined, {
      skipTriage: true,
    })

    const packet: ReviewPacket = {
      type: 'targeted-diff',
      generatedAt: '2026-07-27T12:00:00.000Z',
      byFile: [
        {
          path: 'src/bar.ts',
          hunks: [
            {
              header: '@@ -10,5 +10,6 @@',
              findings: [
                {
                  category: 'style',
                  severity: 'info',
                  message: 'Prefer const over let here',
                  line: 12,
                },
              ],
            },
          ],
        },
      ],
    }

    await store.setReviewPacket(task.id, packet)
    const retrieved = await store.getReviewPacket(task.id)

    expect(retrieved).toEqual(packet)
  })
})
