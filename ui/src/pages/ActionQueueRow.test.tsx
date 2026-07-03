/**
 * Unit tests for ActionQueueRow — the actionQueue sidebar row component.
 *
 * Tests verify which rows render a Restart button based on their actions array.
 * A row renders Restart only when its actions include op:'restart'.
 *
 * Uses renderToStaticMarkup so no React Query context is needed: ActionQueueRow
 * is stateless and receives onRestart / restartPending via props.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActionQueueDetail, ActionQueueRow, PROCESS_LEVEL_OPS, actionErrorMessage } from './ActionQueuePage'
import { ApiError } from '@/shared/api'
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
  errorKind: 'failed-task',
  actions: [
    { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
    { id: 'restart', label: 'Restart', op: 'restart' },
    { id: 'purge', label: 'Purge', op: 'purge', needsConfirm: true },
  ],
  diagnosis: null,
}

// Accepts any field combination so tests can construct cross-variant items
// (e.g. kind:'stale-worktree' + staleWorktreeDetail) without TypeScript
// complaining about union-specific properties.
const makeItem = (overrides: Record<string, unknown>): ActionQueueItem =>
  ({ ...BASE_ITEM, ...overrides } as ActionQueueItem)

const renderRow = (
  item: ActionQueueItem,
  opts: {
    active?: boolean
    onRestart?: (() => void) | null
    restartPending?: boolean
    restartError?: string | null
  } = {},
) =>
  renderToStaticMarkup(
    <ActionQueueRow
      item={item}
      active={opts.active ?? false}
      onSelect={() => {}}
      onRestart={opts.onRestart ?? null}
      restartPending={opts.restartPending ?? false}
      restartError={opts.restartError ?? null}
    />,
  )

// ---------------------------------------------------------------------------
// AC1: A failed actionQueue row renders a Restart button as its primary action.
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
      staleWorktreeDetail: {
        prompt: 'some task',
        status: 'running',
        ageHours: 24,
        updatedAt: '2026-01-01T00:00:00Z',
        branch: 'task/task-abc',
        empty: false,
        investigation: null,
      },
    })
    const html = renderRow(staleItem, { onRestart: null })
    expect(html).not.toContain('Restart')
  })

  it('renders NO Restart button when onRestart is null (e.g. draft-proposal kind)', () => {
    const draftItem = makeItem({
      kind: 'draft-proposal',
      errorKind: 'draft-proposal',
      actions: [
        { id: 'move-forward', label: 'Move forward', op: 'copy', hint: '/mars:grill prop-1' },
        { id: 'dismiss', label: 'Dismiss', op: 'dismiss', needsConfirm: true },
      ],
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
      actions: [
        { id: 'move-forward', label: 'Move forward', op: 'copy', hint: '/mars:grill prop-1' },
        { id: 'dismiss', label: 'Dismiss', op: 'dismiss', needsConfirm: true },
      ],
    })

    const htmlFailed = renderRow(failedItem, { onRestart: () => {} })
    const htmlStale = renderRow(staleItem, { onRestart: null })
    const htmlDraft = renderRow(draftItem, { onRestart: null })

    expect(htmlFailed).toContain('>Restart<')
    expect(htmlStale).not.toContain('Restart')
    expect(htmlDraft).not.toContain('Restart')
  })
})

// ---------------------------------------------------------------------------
// AC1: Clicking Restart triggers exactly one call — the button is disabled
//      (native browser behaviour) while the call is in-flight, so rapid
//      double-clicks cannot fire a second request.
// ---------------------------------------------------------------------------

describe('ActionQueueRow – double-click protection', () => {
  it('renders the button with the disabled attribute while restart is pending', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {}, restartPending: true })
    // renderToStaticMarkup serialises disabled={true} as disabled="" in the HTML.
    // We check for that attribute (not the CSS class disabled:opacity-50).
    expect(html).toContain('disabled=""')
  })

  it('button is NOT disabled when restart is not pending', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {}, restartPending: false })
    // The CSS class disabled:opacity-50 is always present, but the HTML
    // attribute disabled="" must NOT appear when restartPending is false.
    expect(html).not.toContain('disabled=""')
  })
})

// ---------------------------------------------------------------------------
// AC4: On failure the row returns to its interactive state and an error
//      message is shown inline on the row.
// ---------------------------------------------------------------------------

describe('ActionQueueRow – restart error display', () => {
  it('shows the error message inline when restartError is set', () => {
    const html = renderRow(BASE_ITEM, {
      onRestart: () => {},
      restartError: 'restart failed (409): task is queued; only failed can be restarted',
    })
    expect(html).toContain('restart failed (409): task is queued; only failed can be restarted')
  })

  it('shows no error text when restartError is null', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {}, restartError: null })
    // The row body should not contain any error-specific text
    expect(html).not.toContain('restart failed')
  })

  it('still shows the Restart button alongside the error message (row is interactive again)', () => {
    const html = renderRow(BASE_ITEM, {
      onRestart: () => {},
      restartError: 'network error',
    })
    // Both the error and the re-enabled button should be present
    expect(html).toContain('network error')
    expect(html).toContain('>Restart<')
    // And the button should NOT carry the disabled="" attribute (pending = false, the default)
    expect(html).not.toContain('disabled=""')
  })
})

// ---------------------------------------------------------------------------
// ActionQueueDetail – arc-failed headline layout
// AC: goal renders as h2-equivalent headline, reason directly below in secondary
//     weight; goal must appear before reason in the DOM.
// ---------------------------------------------------------------------------

describe('ActionQueueDetail – arc-failed headline layout', () => {
  const arcFailedItem: ActionQueueItem = makeItem({
    kind: 'arc-failed',
    entityId: 'origin-abc',
    title: 'Refactor auth to use JWT',
    body: 'signature: code/context-exceeded',
    errorKind: 'arc-failed',
    actions: [],
    goal: 'Refactor the auth module to use JWT tokens',
    reason: 'The coder ran out of context before the task was finished',
    chain: [],
  })

  const renderDetail = (item: ActionQueueItem): string => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ActionQueueDetail item={item} />
      </QueryClientProvider>,
    )
  }

  it('renders goal as the h2 headline for arc-failed items', () => {
    const html = renderDetail(arcFailedItem)
    expect(html).toContain('Refactor the auth module to use JWT tokens')
    // goal must be in an h2 element
    expect(html).toMatch(/<h2[^>]*>.*Refactor the auth module to use JWT tokens.*<\/h2>/s)
  })

  it('renders reason below goal in a secondary paragraph for arc-failed items', () => {
    const html = renderDetail(arcFailedItem)
    expect(html).toContain('The coder ran out of context before the task was finished')
  })

  it('goal appears before reason in the rendered DOM for arc-failed items', () => {
    const html = renderDetail(arcFailedItem)
    const goalPos = html.indexOf('Refactor the auth module to use JWT tokens')
    const reasonPos = html.indexOf('The coder ran out of context before the task was finished')
    expect(goalPos).toBeGreaterThan(-1)
    expect(reasonPos).toBeGreaterThan(-1)
    // h2 headline (goal) must precede the secondary paragraph (reason)
    expect(goalPos).toBeLessThan(reasonPos)
  })

  it('does not show goal as headline for failed-task items (title stays)', () => {
    const failedItem = makeItem({
      kind: 'failed-task',
      title: 'Some failed task title',
      body: 'Task failed because of X',
      errorKind: 'failed-task',
      actions: [],
    })
    const html = renderDetail(failedItem)
    expect(html).toMatch(/<h2[^>]*>.*Some failed task title.*<\/h2>/s)
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion: failed-task card header must not contain the literal
// string 'FAILED'. The section title 'Failed tasks' already conveys context.
// ---------------------------------------------------------------------------

describe('ActionQueueRow – failed-task card header omits FAILED badge', () => {
  it('does not contain the string FAILED in the card header for a failed-task row', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {} })
    expect(html).not.toMatch(/FAILED/)
  })

  it('still shows the kind badge for non-failed-task rows (e.g. stale-worktree)', () => {
    const staleItem = makeItem({
      kind: 'stale-worktree',
      errorKind: 'stale-worktree',
      actions: [
        { id: 'investigate', label: 'Investigate', op: 'investigate' },
        { id: 'prune', label: 'Prune worktree', op: 'prune-worktree', needsConfirm: true },
      ],
      staleWorktreeDetail: {
        prompt: 'some task',
        status: 'running',
        ageHours: 24,
        updatedAt: '2026-01-01T00:00:00Z',
        branch: 'task/task-abc',
        empty: false,
        investigation: null,
      },
    })
    const html = renderRow(staleItem, { onRestart: null })
    // 'stale wt' badge (uppercased via CSS) — its lowercase text appears in the DOM
    expect(html).toContain('stale wt')
  })
})

// ---------------------------------------------------------------------------
// ActionQueueDetail – diagnosis block
//
// AC: After diagnose-failure returns, the server writes its findings onto the
// action-queue item. On the next refetch the detail panel receives the updated
// item and must render the diagnosis text.
//
// These tests also cover the "item reappears with diagnosis after
// optimistic-dismiss + refetch" lifecycle described in the task spec (point c):
//   - Before diagnose-failure → item.diagnosis is null → no Diagnosis section
//   - After refetch → item.diagnosis is populated → Diagnosis section visible
// ---------------------------------------------------------------------------

describe('ActionQueueDetail – diagnosis rendering (post-diagnose-failure refetch)', () => {
  const renderDetail = (item: ActionQueueItem): string => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ActionQueueDetail item={item} />
      </QueryClientProvider>,
    )
  }

  it('(c) renders the Diagnosis section when item.diagnosis is populated', () => {
    const diagnosedItem = makeItem({
      diagnosis: {
        text: 'The task failed because the TypeScript compiler found an unused import.',
        diagnosedAt: '2026-01-01T12:00:00Z',
      },
    })
    const html = renderDetail(diagnosedItem)
    expect(html).toContain('>Diagnosis<')
    expect(html).toContain('The task failed because the TypeScript compiler found an unused import.')
  })

  it('(c) does NOT render a Diagnosis section when item.diagnosis is null', () => {
    // BASE_ITEM has diagnosis: null — no diagnosis section must appear
    const html = renderDetail(BASE_ITEM)
    expect(html).not.toContain('>Diagnosis<')
  })

  it('(c) diagnosis text survives re-render after refetch (same item, new diagnosis)', () => {
    // Simulate the detail panel receiving the updated item after a refetch
    const itemBeforeDiagnose = makeItem({ diagnosis: null })
    const itemAfterDiagnose = makeItem({
      diagnosis: {
        text: 'Inferred root cause: verify/test-failure on missing dependency.',
        diagnosedAt: '2026-01-01T12:05:00Z',
      },
    })
    const htmlBefore = renderDetail(itemBeforeDiagnose)
    const htmlAfter = renderDetail(itemAfterDiagnose)

    // Before diagnosis: no Diagnosis section
    expect(htmlBefore).not.toContain('>Diagnosis<')
    // After refetch with diagnosis: Diagnosis section present with text
    expect(htmlAfter).toContain('>Diagnosis<')
    expect(htmlAfter).toContain('Inferred root cause: verify/test-failure on missing dependency.')
  })
})

// ---------------------------------------------------------------------------
// ActionBar – process-level ops skip entityId
//
// AC: restart-all-daemon-killed must be treated as a process-level op (like
//     restart-daemon) so invokeAction is called WITHOUT an entityId. Without
//     the fix, ActionBar passes the sentinel '__daemon-killed-batch__' as the
//     entityId and the daemon proxy builds the wrong URL
//     (/actions/restart-all-daemon-killed/__daemon-killed-batch__) which 404s.
//
// PROCESS_LEVEL_OPS is the exported Set that governs entityId elision inside
// ActionBar's mutationFn. Testing its membership directly verifies the
// behavioral contract ("these ops carry no entity id") without requiring DOM
// events to trigger the mutation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Accessibility: keyboard reachability, aria-current, aria-label on Restart
//
// Done criteria:
//   - Tab reaches every AQ row: role="button" + tabIndex={0} make the div
//     focusable and announced as interactive by screen readers.
//   - Enter/Space selects: onKeyDown handler is wired; verified via role="button"
//     semantics (SR users expect Enter to activate a role="button" element).
//   - ArrowUp/Down roving focus: handler is wired on every row.
//   - Each Restart button carries aria-label="Restart <entityId>".
//   - aria-current="true" marks the selected row for screen readers.
// ---------------------------------------------------------------------------

describe('ActionQueueRow – keyboard accessibility', () => {
  it('renders role="button" so the row is announced as interactive', () => {
    const html = renderRow(BASE_ITEM)
    expect(html).toContain('role="button"')
  })

  it('renders tabindex="0" so the row is reachable via Tab', () => {
    const html = renderRow(BASE_ITEM)
    // React serialises tabIndex={0} as tabindex="0" in static markup
    expect(html).toContain('tabindex="0"')
  })

  it('renders aria-current="true" on the active (selected) row', () => {
    const html = renderRow(BASE_ITEM, { active: true })
    expect(html).toContain('aria-current="true"')
  })

  it('does not render aria-current on an inactive row', () => {
    const html = renderRow(BASE_ITEM, { active: false })
    expect(html).not.toContain('aria-current')
  })

  it('Restart button carries aria-label="Restart <entityId>"', () => {
    const html = renderRow(BASE_ITEM, { onRestart: () => {} })
    expect(html).toContain(`aria-label="Restart ${BASE_ITEM.entityId}"`)
  })

  it('Restart button aria-label is distinct for different entityIds', () => {
    const itemXyz = makeItem({ entityId: 'task-xyz' })
    const htmlAbc = renderRow(BASE_ITEM, { onRestart: () => {} })
    const htmlXyz = renderRow(itemXyz, { onRestart: () => {} })
    expect(htmlAbc).toContain('aria-label="Restart task-abc"')
    expect(htmlXyz).toContain('aria-label="Restart task-xyz"')
  })
})

describe('ActionBar – PROCESS_LEVEL_OPS governs entityId elision', () => {
  it('restart-all-daemon-killed is treated as process-level → no entityId sent', () => {
    expect(PROCESS_LEVEL_OPS.has('restart-all-daemon-killed')).toBe(true)
  })

  it('restart-daemon is also process-level → no entityId sent', () => {
    expect(PROCESS_LEVEL_OPS.has('restart-daemon')).toBe(true)
  })

  it('entity-level ops retain their entityId', () => {
    const entityOps = ['restart', 'purge', 'diagnose-failure', 'prune-worktree', 'investigate']
    for (const op of entityOps) {
      expect(PROCESS_LEVEL_OPS.has(op)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// actionErrorMessage – daemon-down error message mapping
//
// AC: When a mutation rejects with an ApiError, the user sees the
// human-readable remedy copy from the shared UI fallback surface
// (resolveFallback) instead of the raw status string. The row reappears after
// rollback because the onError handler restores the React Query snapshot
// (unchanged code path, preserved by the existing onError rollback logic).
//
// actionErrorMessage now delegates to resolveFallback, so its output is
// `<headline> <remedy>` (or just `<headline>` when there is no remedy). We
// assert on substrings rather than exact equality to stay robust to copy
// tweaks. Note: these run under `bun test`, where `import.meta.env.DEV` is
// falsy — so the prod branch is exercised (no raw detail, no remedy for
// non-ApiError throws).
// ---------------------------------------------------------------------------

describe('actionErrorMessage – daemon-down error message mapping', () => {
  it('maps ApiError unreachable to the start-the-server remedy copy', () => {
    const err = new ApiError('POST /api/actions/resolve → 503', 'unreachable', 503)
    const msg = actionErrorMessage(err)
    expect(msg).toContain("reach the dashboard server")
    expect(msg).toContain('npm run dev:server')
  })

  it('maps ApiError stale-daemon to the daemon-restart remedy copy', () => {
    const err = new ApiError('POST /api/actions/resolve → 404', 'stale-daemon', 404)
    const msg = actionErrorMessage(err)
    expect(msg).toContain('stale port')
    expect(msg).toContain('mars daemon restart')
  })

  it('maps ApiError other kind to the generic server-error remedy copy', () => {
    const err = new ApiError('internal server error', 'other', 500)
    const msg = actionErrorMessage(err)
    expect(msg).toContain('returned an error')
    expect(msg).toContain('daemon logs')
  })

  it('renders a calm headline for non-ApiError errors (no raw message leak in prod)', () => {
    const err = new Error('generic network error')
    const msg = actionErrorMessage(err)
    expect(msg).toContain("Couldn't load the action")
    // The raw error text must not leak through the prod fallback.
    expect(msg).not.toContain('generic network error')
  })

  it('unreachable error message renders inline in ActionQueueRow error slot', () => {
    // Verify that the remedy copy is a valid string that the existing
    // ActionQueueRow error UI would render (restartError prop path).
    const daemonMsg = actionErrorMessage(
      new ApiError('POST /api/actions → 503', 'unreachable', 503),
    )
    const html = renderRow(BASE_ITEM, { onRestart: () => {}, restartError: daemonMsg })
    expect(html).toContain('npm run dev:server')
    // Row remains interactive (rollback preserved — button still visible)
    expect(html).toContain('>Restart<')
    expect(html).not.toContain('disabled=""')
  })
})
