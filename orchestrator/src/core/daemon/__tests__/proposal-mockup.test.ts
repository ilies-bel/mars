/**
 * Regression: `mars proposal mockup` must enqueue the task in status='queued',
 * not 'draft'. Without skipTriage:true in handleProposalMockup's enqueueTask
 * call, Arc.createOrigin defaults to status='draft' and the task is never
 * dispatched. Observed live: task mars-d735d8f9 sat in draft 10+ min.
 *
 * This file tests the enqueue contract relied on by handleProposalMockup
 * (orchestrator/src/core/daemon/server.ts) so a regression is caught even if
 * the skipTriage option is accidentally removed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  enqueueTask: typeof import('../../queue').enqueueTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-mockup-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{ q: QueueModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  return { q }
}

describe('proposal.mockup enqueue contract', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('skipTriage:true produces a task in status queued (the mockup path)', async () => {
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('Generate HTML mockup', undefined, {
      workflow: 'mockup',
      skipTriage: true,
    })
    expect(task.status).toBe('queued')
  })

  it('omitting skipTriage produces a task in status draft (the pre-fix bug)', async () => {
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('Generate HTML mockup', undefined, {
      workflow: 'mockup',
    })
    expect(task.status).toBe('draft')
  })
})
