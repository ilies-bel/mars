/**
 * Notice class lifecycle tests.
 *
 * Verifies that:
 *   - CONDITION_KINDS, NOTICE_KINDS, and classifyKind correctly classify
 *     action-queue kinds.
 *   - A Notice-kind row can be raised and listed.
 *   - Dismissing a Notice durably records the dismissal.
 *   - After dismissal, the notice stays dismissed (isNoticeDismissed returns
 *     true and listDismissedNotices includes the record).
 *   - The two pre-existing classes (condition and decision) are unaffected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  CONDITION_KINDS,
  NOTICE_KINDS,
  classifyKind,
} from '../action-queue-kinds'

// ── Classification unit tests (no DB) ────────────────────────────────────────

describe('classifyKind — three-class model', () => {
  it('classifies known condition kinds as condition', () => {
    expect(classifyKind('failed')).toBe('condition')
    expect(classifyKind('stale-queued')).toBe('condition')
    expect(classifyKind('gate-broken')).toBe('condition')
    expect(classifyKind('daemon-died')).toBe('condition')
    expect(classifyKind('orphaned-origin')).toBe('condition')
  })

  it('classifies known notice kinds as notice', () => {
    expect(classifyKind('spend-control-notice')).toBe('notice')
    expect(classifyKind('scheduling-decision')).toBe('notice')
    expect(classifyKind('requeue-warning')).toBe('notice')
    expect(classifyKind('arc-superseded-on-main')).toBe('notice')
  })

  it('classifies all other known kinds as decision', () => {
    expect(classifyKind('draft-proposal')).toBe('decision')
    expect(classifyKind('awaiting-human')).toBe('decision')
    expect(classifyKind('reflect-recommended')).toBe('decision')
    expect(classifyKind('recovery-abandoned')).toBe('decision')
  })

  it('CONDITION_KINDS and NOTICE_KINDS are disjoint', () => {
    for (const kind of NOTICE_KINDS) {
      expect(CONDITION_KINDS.has(kind)).toBe(false)
    }
  })
})

// ── Notice lifecycle integration tests (with DB) ─────────────────────────────

interface NoticeModule {
  raiseActionQueueItem: typeof import('../action-queue').raiseActionQueueItem
  listVisibleActionQueueItems: typeof import('../action-queue').listVisibleActionQueueItems
  listActionQueueItems: typeof import('../action-queue').listActionQueueItems
  isNoticeDismissed: typeof import('../action-queue').isNoticeDismissed
  dismissNoticeItem: typeof import('../action-queue').dismissNoticeItem
  listDismissedNotices: typeof import('../action-queue').listDismissedNotices
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-notice-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<NoticeModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('../action-queue')) as unknown as NoticeModule
}

describe('Notice class — raise, list, dismiss, stays dismissed', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('a notice-kind item can be raised and appears in the visible listing', async () => {
    const m = await loadModule(repo)

    const id = await m.raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'daemon',
      priority: 'normal',
      title: 'Spend controller paused dispatch',
      body: 'Token spend crossed the configured threshold.',
      payload: { direction: 'paused', noticeKey: 'spend-control-notice' },
      context: {},
      raisedBy: 'daemon:spend-control',
      signature: 'spend-control-notice',
    })

    const visible = await m.listVisibleActionQueueItems()
    expect(visible.some((item) => item.id === id)).toBe(true)
    expect(visible.find((item) => item.id === id)?.kind).toBe('spend-control-notice')
  })

  it('a notice is not dismissed before dismissNoticeItem is called', async () => {
    const m = await loadModule(repo)

    const dismissed = await m.isNoticeDismissed('spend-control-notice')
    expect(dismissed).toBe(false)
  })

  it('dismissing a notice resolves the row and writes a durable dismissal record', async () => {
    const m = await loadModule(repo)

    const id = await m.raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'daemon',
      priority: 'normal',
      title: 'Spend controller paused dispatch',
      body: 'Token spend crossed the configured threshold.',
      payload: { direction: 'paused', noticeKey: 'spend-control-notice' },
      context: {},
      raisedBy: 'daemon:spend-control',
      signature: 'spend-control-notice',
    })

    await m.dismissNoticeItem(id, 'spend-control-notice', 'cli:operator')

    // Row must be resolved (no longer in the visible open listing).
    const visible = await m.listVisibleActionQueueItems()
    expect(visible.some((item) => item.id === id)).toBe(false)

    // Row must be in the resolved listing.
    const resolved = await m.listActionQueueItems('resolved', { kind: 'spend-control-notice' })
    expect(resolved.some((item) => item.id === id)).toBe(true)
  })

  it('isNoticeDismissed returns true after dismissal', async () => {
    const m = await loadModule(repo)

    const id = await m.raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'daemon',
      priority: 'normal',
      title: 'Spend controller paused dispatch',
      body: 'Token spend crossed the configured threshold.',
      payload: { direction: 'paused', noticeKey: 'spend-control-notice' },
      context: {},
      raisedBy: 'daemon:spend-control',
      signature: 'spend-control-notice',
    })

    await m.dismissNoticeItem(id, 'spend-control-notice')

    const dismissed = await m.isNoticeDismissed('spend-control-notice')
    expect(dismissed).toBe(true)
  })

  it('listDismissedNotices includes the dismissed record', async () => {
    const m = await loadModule(repo)

    const id = await m.raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'daemon',
      priority: 'normal',
      title: 'Spend controller paused dispatch',
      body: 'Token spend crossed the configured threshold.',
      payload: { direction: 'paused', noticeKey: 'spend-control-notice' },
      context: {},
      raisedBy: 'daemon:spend-control',
      signature: 'spend-control-notice',
    })

    await m.dismissNoticeItem(id, 'spend-control-notice', 'cli:operator')

    const records = await m.listDismissedNotices()
    const record = records.find((r) => r.noticeKey === 'spend-control-notice')
    expect(record).toBeDefined()
    expect(record?.dismissedBy).toBe('cli:operator')
    expect(typeof record?.dismissedAt).toBe('number')
    expect(record!.dismissedAt).toBeGreaterThan(0)
  })

  it('dismissNoticeItem is idempotent: a second dismissal does not throw', async () => {
    const m = await loadModule(repo)

    const id = await m.raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'daemon',
      priority: 'normal',
      title: 'Spend controller paused dispatch',
      body: 'Token spend crossed the configured threshold.',
      payload: { direction: 'paused', noticeKey: 'spend-control-notice' },
      context: {},
      raisedBy: 'daemon:spend-control',
      signature: 'spend-control-notice',
    })

    await m.dismissNoticeItem(id, 'spend-control-notice', 'first-dismisser')
    // Second call: row is already resolved; notice_dismissals is upserted.
    await expect(
      m.dismissNoticeItem(id, 'spend-control-notice', 'second-dismisser'),
    ).resolves.not.toThrow()

    // The record survives; the by field reflects the latest dismisser.
    const records = await m.listDismissedNotices()
    const record = records.find((r) => r.noticeKey === 'spend-control-notice')
    expect(record).toBeDefined()
    expect(record?.dismissedBy).toBe('second-dismisser')
  })

  it('condition and decision rows are unaffected by the notice infrastructure', async () => {
    const m = await loadModule(repo)

    // Raise a decision kind — should raise and be visible as normal.
    const decisionId = await m.raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: 'A proposal to review',
      body: 'Review the proposal.',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'proposal-1',
    })

    const visible = await m.listVisibleActionQueueItems()
    expect(visible.some((item) => item.id === decisionId)).toBe(true)

    // No dismissals written for non-notice kinds.
    const records = await m.listDismissedNotices()
    expect(records).toHaveLength(0)
  })
})
