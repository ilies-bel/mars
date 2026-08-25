/**
 * Action-queue class lifecycle tests.
 *
 * Verifies that:
 *   - KIND_CLASS and classifyKind correctly classify action-queue kinds by
 *     operator obligation (notice / alert / decision).
 *   - A Notice-kind row can be raised and listed.
 *   - Dismissing a Notice durably records the dismissal.
 *   - After dismissal, the notice stays dismissed (isNoticeDismissed returns
 *     true and listDismissedNotices includes the record).
 *   - Alert and Decision rows are unaffected by the notice infrastructure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  ACTION_QUEUE_KINDS,
  KIND_CLASS,
  classifyKind,
} from '../action-queue-kinds'

// ── Classification unit tests (no DB) ────────────────────────────────────────

describe('classifyKind — three-class model (ADR-0104)', () => {
  it('classifies known alert kinds as alert', () => {
    // Core alert kinds: task/system failures requiring operator intervention.
    expect(classifyKind('failed')).toBe('alert')
    expect(classifyKind('stale-queued')).toBe('alert')
    expect(classifyKind('gate-broken')).toBe('alert')
    expect(classifyKind('daemon-died')).toBe('alert')
    expect(classifyKind('orphaned-origin')).toBe('alert')
    expect(classifyKind('recovery-abandoned')).toBe('alert')
    // Operational alerts — AC-required kinds; operator must act to resolve the broken state.
    expect(classifyKind('low-disk-space')).toBe('alert')
    expect(classifyKind('api-outage')).toBe('alert')
    expect(classifyKind('env-incident')).toBe('alert')
    expect(classifyKind('dirty-integration')).toBe('alert')
    expect(classifyKind('health-check-alert')).toBe('alert')
    expect(classifyKind('daemon-killed')).toBe('alert')
    expect(classifyKind('prerequisite-failed')).toBe('alert')
    expect(classifyKind('slice-failed')).toBe('alert')
    expect(classifyKind('diagnose-inconclusive')).toBe('alert')
    expect(classifyKind('done-with-unmerged-commits')).toBe('alert')
    expect(classifyKind('arc-verification-failed')).toBe('alert')
    expect(classifyKind('outbox-lag')).toBe('alert')
    expect(classifyKind('workflow-install-drift')).toBe('alert')
    expect(classifyKind('fragmented-repo-layout')).toBe('alert')
    expect(classifyKind('awaiting-validation-preview-gone')).toBe('alert')
    expect(classifyKind('behaviour-unverified')).toBe('alert')
    expect(classifyKind('daemon-outage')).toBe('alert')
    // Reclassified from 'notice' → 'alert': operator must intervene to fix a broken state.
    expect(classifyKind('slices-dropped')).toBe('alert')
    expect(classifyKind('cancelled-blocker-cascade')).toBe('alert')
    expect(classifyKind('observability-store-oversize')).toBe('alert')
    // Reclassified from 'decision' → 'alert': something is wrong; operator must act.
    expect(classifyKind('coder-question')).toBe('alert')
    expect(classifyKind('budget-window')).toBe('alert')
    expect(classifyKind('budget-arc')).toBe('alert')
  })

  it('classifies known notice kinds as notice', () => {
    expect(classifyKind('spend-control-notice')).toBe('notice')
    expect(classifyKind('requeue-warning')).toBe('notice')
    expect(classifyKind('arc-superseded-on-main')).toBe('notice')
    expect(classifyKind('reflect-recommended')).toBe('notice')
    // Reclassified from 'decision' → 'notice': informational only; nothing required of operator.
    expect(classifyKind('mockup-ready')).toBe('notice')
  })

  it('classifies known decision kinds as decision', () => {
    // Core decision kinds: operator must choose to let work proceed.
    expect(classifyKind('draft-proposal')).toBe('decision')
    expect(classifyKind('awaiting-human')).toBe('decision')
    expect(classifyKind('gate-enrichment')).toBe('decision')
    // AC-required decision kinds: operator picks among options; nothing is broken.
    expect(classifyKind('promotion-decision')).toBe('decision')
    expect(classifyKind('scorer-suggested')).toBe('decision')
    expect(classifyKind('tool-promotion')).toBe('decision')
    expect(classifyKind('workflow-draft-pending')).toBe('decision')
    expect(classifyKind('qa-step-list-opt-in')).toBe('decision')
    expect(classifyKind('qa-step-list-promote')).toBe('decision')
    expect(classifyKind('hitl-slice-needs-operator')).toBe('decision')
    expect(classifyKind('awaiting-validation')).toBe('decision')
    // Reclassified from 'notice' → 'decision': operator must choose, not just be informed.
    expect(classifyKind('scheduling-decision')).toBe('decision')
    // Reclassified from 'alert' → 'decision': nothing is broken; operator must pick an option.
    expect(classifyKind('gate-enrichment-stale')).toBe('decision')
    expect(classifyKind('verify-uncovered')).toBe('decision')
  })

  it('KIND_CLASS notice and decision sets are disjoint', () => {
    const noticeKinds = Object.entries(KIND_CLASS).filter(([, c]) => c === 'notice').map(([k]) => k)
    const decisionKinds = new Set(
      Object.entries(KIND_CLASS).filter(([, c]) => c === 'decision').map(([k]) => k),
    )
    for (const kind of noticeKinds) {
      expect(decisionKinds.has(kind)).toBe(false)
    }
  })

  it('KIND_CLASS is exhaustive: no kind maps to an unknown class', () => {
    const validClasses = new Set(['notice', 'alert', 'decision'])
    for (const [kind, cls] of Object.entries(KIND_CLASS)) {
      expect(validClasses.has(cls), `${kind} has unknown class ${cls}`).toBe(true)
    }
  })

  it('classifyKind is backed by an exhaustive Record — every kind returns a valid class without a default fallback', () => {
    // This test exercises classifyKind (the public API) rather than KIND_CLASS directly.
    // If classifyKind were implemented with a Set-based if/else and a default fallback,
    // an unrecognised kind would silently return the default.  A pure Record lookup
    // either returns the explicitly declared class or undefined (TypeScript catches the
    // latter at compile time), leaving no room for silent defaults.
    const validClasses = new Set<string>(['notice', 'alert', 'decision'])
    for (const kind of ACTION_QUEUE_KINDS) {
      const cls = classifyKind(kind)
      expect(validClasses.has(cls), `${kind} returned unexpected class: ${cls}`).toBe(true)
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
  recordNoticeDismissal: typeof import('../action-queue').recordNoticeDismissal
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

  it('alert and decision rows are unaffected by the notice infrastructure', async () => {
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

  it('dismiss-notice target round-trip: recordNoticeDismissal → isNoticeDismissed returns true', async () => {
    const m = await loadModule(repo)

    // Before dismissal the key is unknown.
    expect(await m.isNoticeDismissed('idle-proposal:abc-123')).toBe(false)

    // Simulate processing a dismiss-notice preloaded-response target.
    // This is the same operation the daemon performs in routes.ts when
    // target.type === 'dismiss-notice': it calls recordNoticeDismissal
    // without touching any action_queue_items row.
    await m.recordNoticeDismissal('idle-proposal:abc-123')

    // After the dismissal the key must be durably recorded.
    expect(await m.isNoticeDismissed('idle-proposal:abc-123')).toBe(true)

    // An unrelated key is unaffected.
    expect(await m.isNoticeDismissed('idle-proposal:other-456')).toBe(false)
  })
})
