/**
 * Behaviour tests for ReflectionsPage (#/reflections).
 *
 * The page must:
 *   - render the reflection list on cold load (no click or SSE event required)
 *   - show run-state banner with autoRunReflect / autoEnqueue status
 *   - show an empty state when there are no reports
 *   - show a loading skeleton while data is in flight
 *   - show a fallback when the list fetch errors
 *   - switch to the detail view when the hash is #/reflections/<originId>
 *   - render dissonant calls ordered by severity (high before low)
 *   - handle non-complete reports (report body is null) without crashing
 *   - link filed proposals to the proposal overlay
 *   - path parity: every /api/deep-reflections[*] path the page calls must be
 *     registered in ui/server/index.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReflectionsPage, ReflectionDetailView, LeverChangeCard, LeverGapCard } from './ReflectionsPage'
import type { LeverApplyState, LeverData } from './ReflectionsPage'
import type { DeepReflectionsListResponse, DeepReflectionDetail } from '@/shared/api'
import { formatAbsoluteDateTime } from '@/shared/time'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any import of the mocked modules.
// ---------------------------------------------------------------------------

vi.mock('@/shared/useHashRoute', () => ({
  useHashRoute: vi.fn(() => '#/reflections'),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: vi.fn(() => ({
    focusedProjectId: null,
    projects: [],
    projectsSettled: true,
    projectsError: null,
    setFocusedProjectId: () => {},
  })),
}))

// Mock useQuery from react-query to control data without a real QueryClient.
// useQuery is an external system boundary — mocking it here is appropriate.
vi.mock('@tanstack/react-query', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: vi.fn() }
})

import { useQuery } from '@tanstack/react-query'
import { useHashRoute } from '@/shared/useHashRoute'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeListResponse = (overrides: Partial<DeepReflectionsListResponse> = {}): DeepReflectionsListResponse => ({
  reports: [
    {
      originId: 'abc123',
      recordedAt: '2026-01-15T10:00:00Z',
      status: 'complete',
      totalToolCalls: 42,
      dissonantCallCount: 2,
      verifyMismatchCount: 1,
      thrashingPatternCount: 0,
      verdictResult: { saved: 1, absorbed: 0, dropped: 0 },
    },
    {
      originId: 'def456',
      recordedAt: '2026-01-10T08:00:00Z',
      status: 'complete',
      totalToolCalls: 17,
      dissonantCallCount: 0,
      verifyMismatchCount: 0,
      thrashingPatternCount: 1,
      verdictResult: { saved: 0, absorbed: 1, dropped: 0 },
    },
  ],
  totalDiscovered: 2,
  unreadableCount: 0,
  autoRunReflect: 'on',
  autoEnqueue: true,
  lastReflectedAt: '2026-01-15T10:00:00Z',
  ...overrides,
})

const makeDetailResponse = (overrides: Partial<DeepReflectionDetail> = {}): DeepReflectionDetail => ({
  originId: 'abc123',
  recordedAt: '2026-01-15T10:00:00Z',
  status: 'complete',
  totalToolCalls: 42,
  dissonantCallCount: 2,
  verifyMismatchCount: 1,
  thrashingPatternCount: 0,
  verdictResult: { saved: 1, absorbed: 0, dropped: 0 },
  sourceTaskId: 'task-789',
  autoRunReflect: 'on',
  autoEnqueue: true,
  report: {
    summary: 'The agent made overly optimistic assumptions about file presence.',
    rootCause: 'File existence checks were skipped before Read calls.',
    toolCallStats: {
      total: 42,
      byName: { Read: 20, Bash: 15, Edit: 7 },
    },
    dissonantCalls: [
      {
        taskId: 'task-789',
        eventIndex: 5,
        tool: 'Read',
        statedIntent: 'Read the config file to understand current settings.',
        actualOutcome: 'File not found — the read silently returned empty.',
        severity: 'high',
        evidence: 'Event 5: Read /config/missing.json → null',
      },
      {
        taskId: 'task-789',
        eventIndex: 12,
        tool: 'Bash',
        statedIntent: 'Run tests to confirm fix is green.',
        actualOutcome: 'Test output was cut off — pass/fail unknown.',
        severity: 'low',
        evidence: 'Event 12: Bash output truncated at 4096 bytes',
      },
      {
        taskId: 'task-789',
        eventIndex: 9,
        tool: 'Edit',
        statedIntent: 'Apply a targeted patch to correct the import.',
        actualOutcome: 'Edit was broader than stated, touching unrelated imports.',
        severity: 'medium',
        evidence: 'Event 9: Edit modified 3 extra lines',
      },
    ],
    verifyMismatch: null,
    verifyMismatches: [
      {
        taskId: 'task-789',
        claimed: 'All tests pass',
        actual: 'Test suite reported 1 failure',
        severity: 'high',
      },
    ],
    thrashingPatterns: [],
    suggestions: [
      {
        title: 'Add existence check before Read',
        prompt: 'Check file existence before calling Read.',
        rationale: 'Prevents silent null reads.',
        verdict: 'save',
        targetId: 'proposal-aaa',
        outcome: null,
      },
    ],
  },
  ...overrides,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal return shape that satisfies the UseQueryResult slots the page uses. */
const mockQueryResult = (overrides: {
  data?: unknown
  isLoading?: boolean
  error?: Error | null
}) => ({
  data: overrides.data,
  isLoading: overrides.isLoading ?? false,
  isFetching: false,
  isError: overrides.error != null,
  error: overrides.error ?? null,
  status: (overrides.isLoading ? 'pending' : overrides.error ? 'error' : 'success') as 'pending' | 'error' | 'success',
  isSuccess: !overrides.isLoading && overrides.error == null && overrides.data !== undefined,
  isPending: overrides.isLoading ?? false,
  isRefetching: false,
  refetch: () => Promise.resolve({ data: undefined }),
  dataUpdatedAt: 0,
  errorUpdatedAt: 0,
  failureCount: 0,
  failureReason: null,
  fetchStatus: 'idle' as const,
  isLoadingError: false,
  isPaused: false,
  isPlaceholderData: false,
  isRefetchError: false,
  isStale: false,
  isInitialLoading: false,
  errorUpdateCount: 0,
  promise: Promise.resolve(undefined),
})

describe('ReflectionsPage', () => {
  beforeEach(() => {
    // Default: hash is list view, list data present, no detail
    vi.mocked(useHashRoute).mockReturnValue('#/reflections')
    vi.mocked(useQuery)
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))  // list query
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))           // detail query (not active)
  })

  // -------------------------------------------------------------------------
  // Cold-load list view
  // -------------------------------------------------------------------------

  it('renders the reflection list on cold load without requiring user interaction', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    // Header and count
    expect(html).toContain('Reflections')
    expect(html).toContain('2 reports')
    // Both rows present
    expect(html).toContain('abc123')
    expect(html).toContain('def456')
  })

  it('shows "N of M reports" when totalDiscovered exceeds the returned page', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ totalDiscovered: 74 }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('2 of 74 reports')
    expect(html).not.toContain('2 reports')
  })

  it('shows unreadable count warning when unreadableCount is non-zero', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ unreadableCount: 3 }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('3 unreadable')
  })

  it('shows dissonant call and verify mismatch counts in list rows', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('2 dissonant')
    expect(html).toContain('1 verify mismatch')
  })

  it('shows 1 thrashing pattern count in list row when present', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)
    expect(html).toContain('1 thrashing')
  })

  it('links each row to the reflection detail hash (compound originId + recordedAt)', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    // Route includes both originId and recordedAt so each report has a unique URL.
    expect(html).toContain('href="#/reflections/abc123/2026-01-15T10%3A00%3A00Z"')
    expect(html).toContain('href="#/reflections/def456/2026-01-10T08%3A00%3A00Z"')
  })

  it('uses a compound key (originId + recordedAt) for list rows so duplicate-originId reports render without duplicate-key errors', () => {
    // Two reports that share the same originId but have different recordedAt timestamps.
    const listWithDupes = makeListResponse({
      reports: [
        {
          originId: 'shared-origin',
          recordedAt: '2026-01-15T10:00:00Z',
          status: 'complete',
          totalToolCalls: 10,
          dissonantCallCount: 0,
          verifyMismatchCount: 0,
          thrashingPatternCount: 0,
          verdictResult: { saved: 0, absorbed: 0, dropped: 0 },
        },
        {
          originId: 'shared-origin',
          recordedAt: '2026-01-10T08:00:00Z',
          status: 'complete',
          totalToolCalls: 5,
          dissonantCallCount: 0,
          verifyMismatchCount: 0,
          thrashingPatternCount: 0,
          verdictResult: { saved: 0, absorbed: 0, dropped: 0 },
        },
      ],
    })
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: listWithDupes }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    // Both rows are present — neither is dropped.
    expect(html).toContain('href="#/reflections/shared-origin/2026-01-15T10%3A00%3A00Z"')
    expect(html).toContain('href="#/reflections/shared-origin/2026-01-10T08%3A00%3A00Z"')
    // Two distinct hrefs confirm two distinct rows were rendered.
    expect(
      (html.match(/href="#\/reflections\/shared-origin\//g) ?? []).length
    ).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Run-state banner
  // -------------------------------------------------------------------------

  it('shows the run-state banner with last-reflected time and autoRunReflect ON state', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="run-state-banner"')
    expect(html).toContain('auto-reflect is ON and auto-trigger is ON')
  })

  it('renders the last-reflected timestamp through the shared unambiguous formatter', () => {
    // lastReflectedAt is '2026-01-15T10:00:00Z' — must render via formatAbsoluteDateTime,
    // never as an ambiguous numeric date like 01/15/2026 or 15/01/2026.
    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain(formatAbsoluteDateTime('2026-01-15T10:00:00Z'))
  })

  it('shows autoRunReflect OFF state when the lever is off', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ autoRunReflect: 'off', autoEnqueue: false }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('auto-reflect is OFF')
    expect(html).not.toContain('auto-reflect is ON')
  })

  it('shows autoRunReflect ON but auto-trigger OFF when autoEnqueue is false', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ autoRunReflect: 'on', autoEnqueue: false }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('auto-reflect is ON but auto-trigger is OFF')
  })

  // The detail view knows exactly which arc it is showing, so the manual
  // trigger it prompts for should be a real, copyable command rather than
  // prose with a `<originId>` placeholder the operator has to hand-fill.
  it('detail view offers a copyable mars arc reflect <originId> command instead of a placeholder', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(
        mockQueryResult({
          data: makeDetailResponse({ autoRunReflect: 'off', autoEnqueue: false, originId: 'abc123' }),
        }),
      )

    const html = renderToStaticMarkup(<ReflectionsPage />)

    // The real command, fully spelled out — not the `<originId>` placeholder.
    expect(html).toContain('mars arc reflect abc123')
    expect(html).not.toContain('&lt;originId&gt;')
    // A copy affordance exposes the exact same command, so it can be pasted
    // into a terminal verbatim rather than retyped.
    expect(html).toContain('aria-label="Copy mars arc reflect abc123"')
  })

  it('shows "No reflection has run yet" when lastReflectedAt is null', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ lastReflectedAt: null }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('No reflection has run yet')
  })

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it('shows an empty state when there are no reports', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ reports: [] }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="empty-state"')
    expect(html).toContain('No reflection reports yet')
    // Empty state must not contain the un-fillable <originId> placeholder
    expect(html).not.toContain('&lt;originId&gt;')
  })

  it('empty state does not concatenate sentences — no period immediately followed by a capital', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ reports: [], autoRunReflect: 'off', autoEnqueue: false }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    // Strip everything from the empty-state div and verify no period is
    // immediately adjacent to a capital letter (the original defect pattern).
    const emptyStateMatch = html.match(/data-testid="empty-state"[^>]*>([\s\S]*?)<\/div>/)
    expect(emptyStateMatch).not.toBeNull()
    const textContent = emptyStateMatch![1].replace(/<[^>]+>/g, '')
    expect(textContent).not.toMatch(/\.[A-Z]/)
  })

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  it('shows a loading indicator while data is in flight', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ isLoading: true }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="list-loading"')
  })

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  it('renders a fallback panel when the list fetch errors', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ error: new Error('daemon unreachable') }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('role="alert"')
  })

  // -------------------------------------------------------------------------
  // Detail view
  // -------------------------------------------------------------------------

  it('renders the detail view with summary and root cause when hash is #/reflections/<originId>', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('The agent made overly optimistic assumptions')
    expect(html).toContain('File existence checks were skipped')
  })

  it('renders dissonant calls ordered high → medium → low by severity', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    const highIdx = html.indexOf('data-testid="dissonant-call-0"')
    const midIdx = html.indexOf('data-testid="dissonant-call-1"')
    const lowIdx = html.indexOf('data-testid="dissonant-call-2"')

    // The order in the HTML must match high → medium → low
    expect(highIdx).toBeGreaterThan(-1)
    expect(midIdx).toBeGreaterThan(-1)
    expect(lowIdx).toBeGreaterThan(-1)
    expect(highIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(lowIdx)

    // High-severity call content appears first
    const highCard = html.slice(highIdx, midIdx)
    expect(highCard).toContain('Read')           // the high-severity tool
    expect(highCard).toContain('Stated intent')
    expect(highCard).toContain('Actual outcome')
  })

  it('renders stated intent and actual outcome side-by-side in each dissonant call card', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('Stated intent')
    expect(html).toContain('Actual outcome')
    expect(html).toContain('Read the config file to understand current settings')
    expect(html).toContain('File not found')
  })

  it('renders verify mismatches with claimed vs actual side-by-side', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="verify-mismatch-0"')
    expect(html).toContain('All tests pass')
    expect(html).toContain('Test suite reported 1 failure')
  })

  it('renders tool call stats as a compact breakdown', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    // Total count in heading
    expect(html).toContain('42')
    // Individual tool counts
    expect(html).toContain('Read')
    expect(html).toContain('Bash')
    expect(html).toContain('Edit')
  })

  it('links filed proposals to the proposal overlay', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="filed-proposal-0"')
    expect(html).toContain('Add existence check before Read')
    // Link points to the proposal overlay with from=reflections
    expect(html).toContain('href="#/proposal/proposal-aaa?from=reflections"')
  })

  it('includes a back link to the list from the detail view', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('href="#/reflections"')
    expect(html).toContain('← Reflections')
  })

  // -------------------------------------------------------------------------
  // Non-complete report handling
  // -------------------------------------------------------------------------

  it('does not crash when report body is null (pending/non-complete status)', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    const pendingDetail = makeDetailResponse({ status: 'pending', report: null })
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: pendingDetail }))

    expect(() => renderToStaticMarkup(<ReflectionsPage />)).not.toThrow()
  })

  it('shows non-complete notice when report body is null', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    const pendingDetail = makeDetailResponse({ status: 'pending', report: null })
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: pendingDetail }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="non-complete-notice"')
    expect(html).toContain('pending')
    // Report sections must NOT appear
    expect(html).not.toContain('Dissonant Calls')
    expect(html).not.toContain('Verify Mismatches')
  })

  // -------------------------------------------------------------------------
  // Detail loading / error state
  // -------------------------------------------------------------------------

  it('shows a detail loading indicator while the detail fetch is in flight', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123/2026-01-15T10:00:00Z')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ isLoading: true }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="detail-loading"')
  })

  // -------------------------------------------------------------------------
  // Path parity: API paths the page calls must be registered in ui/server/index.ts
  // -------------------------------------------------------------------------

  it('has /api/deep-reflections list and detail paths registered in ui/server/index.ts', () => {
    const serverPath = resolve(__dirname, '../../server/index.ts')
    const serverSource = readFileSync(serverPath, 'utf8')

    // List route
    expect(serverSource).toContain('/api/deep-reflections')
    // Detail route (longer path, must also be handled)
    expect(serverSource).toContain('/api/deep-reflections/')
  })
})

// ---------------------------------------------------------------------------
// Lever binding section — direct ReflectionDetailView tests
//
// These test the new "LEVER CHANGES — WHAT YOU CAN TUNE NOW" section added to
// fix mars-46fb20fd. ReflectionDetailView is rendered directly so the tests do
// not need useQuery/useHashRoute mocking.
// ---------------------------------------------------------------------------

describe('ReflectionDetailView — lever bindings (mars-46fb20fd)', () => {
  const baseDetail = (
    suggestions: NonNullable<DeepReflectionDetail['report']>['suggestions'],
    extraOverrides: Partial<DeepReflectionDetail> = {},
  ): DeepReflectionDetail => ({
    originId: 'test-origin',
    recordedAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    totalToolCalls: 0,
    dissonantCallCount: 0,
    verifyMismatchCount: 0,
    thrashingPatternCount: 0,
    verdictResult: { saved: 1, absorbed: 0, dropped: 0 },
    sourceTaskId: null,
    autoRunReflect: 'on',
    autoEnqueue: false,
    report: {
      summary: 'Test summary',
      rootCause: 'Test root cause',
      toolCallStats: { total: 0, byName: {} },
      dissonantCalls: [],
      verifyMismatch: null,
      verifyMismatches: [],
      thrashingPatterns: [],
      suggestions,
    },
    ...extraOverrides,
  })

  const leverSuggestion = (targetId: string | null = null, overrides: Partial<LeverData> = {}) => ({
    title: 'Tune workflow.steps verify commands',
    prompt: 'Run exact acceptance commands. Save your work.',
    rationale: 'Verify output was absent on several tasks',
    verdict: 'save',
    targetId,
    outcome: {
      type: 'lever' as const,
      lever: {
        id: 'workflow.steps',
        family: 'workflow',
        scope: 'per-workflow',
        currentValue: 'Code sessions may use filtered local checks.',
        proposedValue: 'Run exact acceptance commands with preserved exit codes.',
        gesture: 'mars workflow author <name>',
        appliesWithoutRestart: true,
        history: [],
        ...overrides,
      },
    },
  })

  it('renders the lever-changes section when a lever suggestion is present', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView detail={baseDetail([leverSuggestion()])} />,
    )
    expect(html).toContain('data-testid="lever-changes-section"')
  })

  it('shows the lever id even when targetId is null', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView detail={baseDetail([leverSuggestion(null)])} />,
    )
    expect(html).toContain('data-testid="lever-change-id-0"')
    expect(html).toContain('workflow.steps')
  })

  it('shows the proposed value even when targetId is null', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView detail={baseDetail([leverSuggestion(null)])} />,
    )
    expect(html).toContain('Run exact acceptance commands with preserved exit codes.')
  })

  it('shows the gesture as copyable text even when targetId is null', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView detail={baseDetail([leverSuggestion(null)])} />,
    )
    expect(html).toContain('data-testid="lever-change-gesture-0"')
    // < and > are HTML-escaped in renderToStaticMarkup
    expect(html).toContain('mars workflow author')
  })

  it('shows a proposal link when targetId is non-null', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView detail={baseDetail([leverSuggestion('abc-tune-workflow-steps')])} />,
    )
    expect(html).toContain('abc-tune-workflow-steps')
    expect(html).toContain('data-testid="lever-change-id-0"')
  })

  it('does not show a proposal link when targetId is null', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView detail={baseDetail([leverSuggestion(null)])} />,
    )
    // No "→ proposal" link text in the lever change card
    expect(html).not.toContain('→ proposal')
  })

  it('does not show lever-changes section when there are no lever suggestions', () => {
    const html = renderToStaticMarkup(
      <ReflectionDetailView
        detail={baseDetail([
          {
            title: 'Add a new knob',
            prompt: 'Build the new lever. Save your work.',
            rationale: 'No lever exists for this control',
            verdict: 'save',
            targetId: null,
            outcome: {
              type: 'leverGap' as const,
              leverGap: {
                proposedLeverId: 'cache.warmup-policy',
                family: 'workflow',
                whatItWouldControl: 'cache warm-up strategy on the code step',
              },
            },
          },
        ])}
      />
    )
    expect(html).not.toContain('data-testid="lever-changes-section"')
    expect(html).toContain('data-testid="lever-gaps-section"')
  })
})

// ---------------------------------------------------------------------------
// LeverChangeCard — direct unit tests for the apply control behaviour.
//
// LeverChangeCard is a pure presentational component that accepts state as
// props, making it testable with renderToStaticMarkup (no DOM / happy-dom).
// ---------------------------------------------------------------------------

describe('LeverChangeCard — apply control', () => {
  const makeLever = (overrides: Partial<LeverData> = {}): LeverData => ({
    id: 'caps.implement',
    family: 'caps',
    scope: 'global',
    currentValue: '3',
    proposedValue: '6',
    gesture: 'mars operator set caps.implement 6',
    appliesWithoutRestart: true,
    history: [],
    ...overrides,
  })

  const noopCallbacks = {
    onApply: () => {},
    onRequestConfirm: () => {},
    onCancelConfirm: () => {},
  }

  it('renders the apply button with a transition label, not a bare "Apply"', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever()}
        applyState={{ status: 'idle' }}
        showConfirm={false}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    // Button must carry the transition label
    expect(html).toContain('caps.implement: 3 → 6')
    // Must NOT be a bare "Apply" without the lever ID
    expect(html).not.toMatch(/>Apply</)
  })

  it('shows apply button directly for per-task lever (no confirmation step)', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever({ scope: 'per-task', appliesWithoutRestart: true })}
        applyState={{ status: 'idle' }}
        showConfirm={false}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-apply-btn-0"')
    // No confirmation block rendered in idle state for per-task lever
    expect(html).not.toContain('data-testid="lever-confirm-0"')
  })

  it('shows confirmation block for global scope lever when showConfirm=true', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever({ scope: 'global', appliesWithoutRestart: true })}
        applyState={{ status: 'idle' }}
        showConfirm={true}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-confirm-0"')
    expect(html).toContain('data-testid="lever-confirm-apply-btn-0"')
    expect(html).toContain('data-testid="lever-confirm-cancel-btn-0"')
    expect(html).toContain('global scope')
  })

  it('includes in-flight task count in confirmation for global lever requiring restart', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever({ scope: 'global', appliesWithoutRestart: false })}
        applyState={{ status: 'idle' }}
        showConfirm={true}
        inFlightCount={7}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-confirm-blast-radius-0"')
    expect(html).toContain('7 in-flight tasks')
    expect(html).toContain('daemon reload')
  })

  it('renders "applying…" feedback while applying', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever()}
        applyState={{ status: 'applying' }}
        showConfirm={false}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-applying-0"')
    expect(html).toContain('Applying')
  })

  it('renders applied confirmation with timestamp after successful apply', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever()}
        applyState={{ status: 'applied', appliedAt: '2026-01-15T10:00:00Z', appliedValue: '6' }}
        showConfirm={false}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-applied-0"')
    expect(html).toContain('Applied')
    // Must NOT show the apply button when already applied
    expect(html).not.toContain('data-testid="lever-apply-btn-0"')
  })

  it('surfaces failed apply error on the control while keeping the finding actionable (retry button present)', () => {
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever()}
        applyState={{ status: 'error', error: 'daemon returned 422: value out of range' }}
        showConfirm={false}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-apply-error-0"')
    expect(html).toContain('daemon returned 422: value out of range')
    // Retry button must be present — finding remains actionable
    expect(html).toContain('data-testid="lever-retry-btn-0"')
    expect(html).toContain('caps.implement: 3 → 6')
  })

  it('shows apply history when present', () => {
    const history = [
      {
        appliedAt: '2026-01-10T08:00:00Z',
        leverId: 'caps.implement',
        fromValue: '2',
        toValue: '3',
        findingId: 'finding-abc',
      },
    ]
    const html = renderToStaticMarkup(
      <LeverChangeCard
        lever={makeLever({ history })}
        applyState={{ status: 'idle' }}
        showConfirm={false}
        inFlightCount={0}
        index={0}
        {...noopCallbacks}
      />,
    )

    expect(html).toContain('data-testid="lever-history-0"')
    expect(html).toContain('Last applied')
  })

  it('does not render "Apply all" or batch-apply controls', () => {
    // Render two lever cards and confirm there's no shared "apply all" control.
    const lever1 = makeLever({ id: 'caps.implement' })
    const lever2 = makeLever({ id: 'caps.refine', proposedValue: '4' })
    const html =
      renderToStaticMarkup(<LeverChangeCard lever={lever1} applyState={{ status: 'idle' }} showConfirm={false} inFlightCount={0} index={0} {...noopCallbacks} />) +
      renderToStaticMarkup(<LeverChangeCard lever={lever2} applyState={{ status: 'idle' }} showConfirm={false} inFlightCount={0} index={1} {...noopCallbacks} />)

    expect(html).not.toContain('Apply all')
    expect(html).not.toContain('apply-all')
  })
})

// ---------------------------------------------------------------------------
// LeverGapCard — must be unmistakably different from LeverChangeCard.
// ---------------------------------------------------------------------------

describe('LeverGapCard — no apply control', () => {
  const gap = {
    proposedLeverId: 'cache.warmup-policy',
    family: 'workflow',
    whatItWouldControl: 'cache warm-up strategy on the code step',
  }

  it('renders the gap without any apply button', () => {
    const html = renderToStaticMarkup(<LeverGapCard gap={gap} index={0} />)

    expect(html).not.toContain('data-testid="lever-apply-btn-0"')
    expect(html).not.toContain('data-testid="lever-confirm-0"')
  })

  it('shows explicit "no parameter controls this" statement', () => {
    const html = renderToStaticMarkup(<LeverGapCard gap={gap} index={0} />)

    expect(html).toContain('data-testid="lever-gap-no-control-0"')
    expect(html).toContain('No parameter controls this yet')
  })

  it('carries the "Lever Gap" label', () => {
    const html = renderToStaticMarkup(<LeverGapCard gap={gap} index={0} />)

    expect(html).toContain('Lever Gap')
    expect(html).toContain('cache.warmup-policy')
  })
})
