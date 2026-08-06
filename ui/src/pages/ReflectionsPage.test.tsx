/**
 * Behaviour tests for ReflectionsPage (#/reflections).
 *
 * The page must:
 *   - render the reflection list on cold load (no click or SSE event required)
 *   - show run-state banner with autoReflect / autoTrigger status
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
import { ReflectionsPage } from './ReflectionsPage'
import type { DeepReflectionsListResponse, DeepReflectionDetail } from '@/shared/api'
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
  autoReflect: 'on',
  autoTrigger: true,
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
  autoReflect: 'on',
  autoTrigger: true,
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

  it('shows dissonant call and verify mismatch counts in list rows', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('2 dissonant')
    expect(html).toContain('1 verify mismatch')
  })

  it('shows 1 thrashing pattern count in list row when present', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)
    expect(html).toContain('1 thrashing')
  })

  it('links each row to the reflection detail hash', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('href="#/reflections/abc123"')
    expect(html).toContain('href="#/reflections/def456"')
  })

  // -------------------------------------------------------------------------
  // Run-state banner
  // -------------------------------------------------------------------------

  it('shows the run-state banner with last-reflected time and autoReflect ON state', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('data-testid="run-state-banner"')
    expect(html).toContain('auto-reflect is ON and auto-trigger is ON')
  })

  it('shows autoReflect OFF state when the lever is off', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ autoReflect: 'off', autoTrigger: false }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('auto-reflect is OFF')
    expect(html).not.toContain('auto-reflect is ON')
  })

  it('shows autoReflect ON but auto-trigger OFF when autoTrigger is false', () => {
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse({ autoReflect: 'on', autoTrigger: false }) }))
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('auto-reflect is ON but auto-trigger is OFF')
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
    expect(html).toContain('mars arc reflect')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: makeDetailResponse() }))

    const html = renderToStaticMarkup(<ReflectionsPage />)

    expect(html).toContain('The agent made overly optimistic assumptions')
    expect(html).toContain('File existence checks were skipped')
  })

  it('renders dissonant calls ordered high → medium → low by severity', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
    const pendingDetail = makeDetailResponse({ status: 'pending', report: null })
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(mockQueryResult({ data: makeListResponse() }))
      .mockReturnValueOnce(mockQueryResult({ data: pendingDetail }))

    expect(() => renderToStaticMarkup(<ReflectionsPage />)).not.toThrow()
  })

  it('shows non-complete notice when report body is null', () => {
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
    vi.mocked(useHashRoute).mockReturnValue('#/reflections/abc123')
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
