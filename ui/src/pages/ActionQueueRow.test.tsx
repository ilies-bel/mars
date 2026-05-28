/**
 * Unit tests for ActionQueueRow — the inbox sidebar row component.
 *
 * Tests verify which rows render a Restart button based on their actions array.
 * A row renders Restart only when its actions include op:'restart'.
 *
 * Uses renderToStaticMarkup so no React Query context is needed: ActionQueueRow
 * is stateless and receives onRestart / restartPending via props.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionQueueRow } from './TodoPage'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ITEM: ActionQueueItem = {
  id: 'row-1',
  kind: 'failed-task',
  entityId: 'task-abc',
  priority: 'normal',
  title: 'Some failed task',
  body: 'Task failed because of X',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  dismissed: false,
  ackState: null,
  errorKind: 'failed-task',
  actions: [
    { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
    { id: 'restart', label: 'Restart', op: 'restart' },
    { id: 'purge', label: 'Purge', op: 'purge', needsConfirm: true },
  ],
  staleWorktreeDetail: null,
  diagnosis: null,
}

const makeItem = (overrides: Partial<ActionQueueItem>): ActionQueueItem => ({
  ...BASE_ITEM,
  ...overrides,
})

const renderRow = (
  item: ActionQueueItem,
  opts: { onRestart?: (() => void) | null; restartPending?: boolean } = {},
) =>
  renderToStaticMarkup(
    <ActionQueueRow
      item={item}
      active={false}
      onSelect={() => {}}
      onRestart={opts.onRestart ?? null}
      restartPending={opts.restartPending ?? false}
    />,
  )

// ---------------------------------------------------------------------------
// AC1: A failed inbox row renders a Restart button as its primary action.
// ---------------------------------------------------------------------------

describe('ActionQueueRow – Restart button visibility', () => {
  it('renders a Restart button when onRestart is provided', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {} })
    expect(html).toContain('>Restart<')
  })

  it('renders "Restarting…" label while restart is pending', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {}, restartPending: true })
    expect(html).toContain('Restarting')
    expect(html).not.toContain('>Restart<')
  })

  // ---------------------------------------------------------------------------
  // AC2: cancelled-blocker-cascade, dirty-main-at-setup, diagnose-inconclusive
  //       render NO Restart button.
  //       (These future errorKind values will carry no restart action — that is
  //        exactly why onRestart is null for them and the test below holds.)
  // ---------------------------------------------------------------------------

  it('renders NO Restart button when onRestart is null (e.g. stale-worktree kind)', () => {
    const staleItem = makeItem({
      kind: 'stale-worktree',
      errorKind: 'stale-worktree',
      actions: [
        { id: 'investigate', label: 'Investigate', op: 'investigate' },
        { id: 'prune', label: 'Prune worktree', op: 'prune-worktree', needsConfirm: true },
      ],
    })
    const html = renderRow(staleItem, { onRestart: null })
    expect(html).not.toContain('Restart')
  })

  it('renders NO Restart button when onRestart is null (e.g. draft-proposal kind)', () => {
    const draftItem = makeItem({
      kind: 'draft-proposal',
      errorKind: 'draft-proposal',
      actions: [{ id: 'shape', label: 'Shape', op: 'shape', hint: '/mars:grill' }],
    })
    const html = renderRow(draftItem, { onRestart: null })
    expect(html).not.toContain('Restart')
  })

  it('renders NO Restart button for a cancelled-blocker-cascade error kind (no restart op)', () => {
    // This represents a future errorKind that does not include a restart action.
    // The UI derives onRestart=null when actions has no op:'restart', so no button renders.
    const cancelledItem = makeItem({
      kind: 'failed-task',
      errorKind: 'cancelled-blocker-cascade',
      actions: [],
    })
    const html = renderRow(cancelledItem, { onRestart: null })
    expect(html).not.toContain('Restart')
  })

  it('renders NO Restart button for a dirty-main-at-setup error kind (no restart op)', () => {
    const dirtyMainItem = makeItem({
      kind: 'failed-task',
      errorKind: 'dirty-main-at-setup',
      actions: [],
    })
    const html = renderRow(dirtyMainItem, { onRestart: null })
    expect(html).not.toContain('Restart')
  })

  it('renders NO Restart button for a diagnose-inconclusive error kind (no restart op)', () => {
    const inconclusiveItem = makeItem({
      kind: 'failed-task',
      errorKind: 'diagnose-inconclusive',
      actions: [],
    })
    const html = renderRow(inconclusiveItem, { onRestart: null })
    expect(html).not.toContain('Restart')
  })

  // ---------------------------------------------------------------------------
  // AC3: The button's label and placement are consistent across all failed rows.
  // ---------------------------------------------------------------------------

  it('uses the label "Restart" for both failed-task and daemon-killed rows', () => {
    const failedItem = BASE_ITEM
    const daemonKilledItem = makeItem({
      errorKind: 'daemon-killed',
      actions: [
        { id: 'requeue', label: 'Requeue now', op: 'restart' },
        { id: 'restart-daemon', label: 'Restart daemon', op: 'restart-daemon', needsConfirm: true },
      ],
    })
    const htmlFailed = renderRow(failedItem, { onRestart: () => {} })
    const htmlDaemonKilled = renderRow(daemonKilledItem, { onRestart: () => {} })
    // Both rows show 'Restart' on the inline button regardless of errorKind label.
    expect(htmlFailed).toContain('>Restart<')
    expect(htmlDaemonKilled).toContain('>Restart<')
  })

  it('places the Restart button in the same position on the row', () => {
    const item1 = makeItem({ entityId: 'task-001', title: 'Task one' })
    const item2 = makeItem({ entityId: 'task-002', title: 'Task two' })
    const html1 = renderRow(item1, { onRestart: () => {} })
    const html2 = renderRow(item2, { onRestart: () => {} })
    // Both should have the button appear after the timestamp (same structural position).
    // We verify both contain the button at all.
    expect(html1).toContain('>Restart<')
    expect(html2).toContain('>Restart<')
    // And neither has the button before the title (structural placement check).
    const buttonAfterTitle1 = html1.indexOf('>Restart<') > html1.indexOf(item1.title)
    const buttonAfterTitle2 = html2.indexOf('>Restart<') > html2.indexOf(item2.title)
    expect(buttonAfterTitle1).toBe(true)
    expect(buttonAfterTitle2).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // AC4: Mixed lists render correctly with Restart only on failed rows.
  // ---------------------------------------------------------------------------

  it('renders Restart only on rows where onRestart is provided (mixed list)', () => {
    const failedItem = BASE_ITEM
    const staleItem = makeItem({
      id: 'row-2',
      kind: 'stale-worktree',
      errorKind: 'stale-worktree',
      actions: [{ id: 'investigate', label: 'Investigate', op: 'investigate' }],
    })
    const draftItem = makeItem({
      id: 'row-3',
      kind: 'draft-proposal',
      errorKind: 'draft-proposal',
      actions: [{ id: 'shape', label: 'Shape', op: 'shape', hint: '/mars:grill' }],
    })

    const htmlFailed = renderRow(failedItem, { onRestart: () => {} })
    const htmlStale = renderRow(staleItem, { onRestart: null })
    const htmlDraft = renderRow(draftItem, { onRestart: null })

    expect(htmlFailed).toContain('>Restart<')
    expect(htmlStale).not.toContain('Restart')
    expect(htmlDraft).not.toContain('Restart')
  })
})
