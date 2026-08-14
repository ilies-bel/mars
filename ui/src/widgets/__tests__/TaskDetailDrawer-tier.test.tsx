/**
 * Tests for the tier + model rendering added in Phase 4B slice 4.
 *
 * StepCard renders a `data-testid="step-tier-model"` span beside the
 * workerName label when a StepSpan carries non-null declaredTier or
 * resolvedModel. These tests assert the happy path (both fields present)
 * and the no-op path (both fields null → span absent).
 */

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TaskDetailDrawer } from '../TaskDetailDrawer'
import type { StepSpan } from '../TaskDetailDrawer'

// ── Module stubs ──────────────────────────────────────────────────────────────

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: () => ({ focusedProjectId: 'proj-test' }),
  useFocusedProjectId: () => 'proj-test',
}))

// OriginTree and StewardLedgerPanel each call useQuery internally; stub them
// so the test does not need matching API contexts.
vi.mock('../OriginTree', () => ({
  OriginTree: () => null,
}))

vi.mock('../StewardLedgerPanel', () => ({
  StewardLedgerPanel: () => null,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const renderWithQuery = (ui: React.ReactElement): string => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  )
}

const baseSpan = (overrides: Partial<StepSpan> = {}): StepSpan => ({
  stepName: 'code',
  phase: 'code',
  workflowInstanceId: 'wf-tier-test',
  workerName: 'Coder',
  outcome: 'completed',
  startedAt: '2024-01-01T00:00:00.000Z',
  endedAt: '2024-01-01T00:01:00.000Z',
  durationMs: 60000,
  taskId: 'task-tier-test',
  originId: 'task-tier-test',
  ...overrides,
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskDetailDrawer — tier/model rendering in step row', () => {
  it('renders tier and model beside workerName when both are present', () => {
    const spans: StepSpan[] = [
      baseSpan({ declaredTier: 'fast', resolvedModel: 'gpt-5.6-luna' }),
    ]

    const html = renderWithQuery(
      <TaskDetailDrawer
        taskId="task-tier-test"
        onClose={() => {}}
        stepSpans={spans}
        proposals={[]}
        // Use loading so the task detail body (which needs a Task object) is
        // not rendered; the step card list still renders from the stepSpans prop.
        initialState={{ kind: 'loading' }}
      />,
    )

    expect(html).toContain('fast (gpt-5.6-luna)')
    expect(html).toContain('data-testid="step-tier-model"')
  })

  it('renders balanced and resolvedModel correctly', () => {
    const spans: StepSpan[] = [
      baseSpan({ declaredTier: 'balanced', resolvedModel: 'gpt-5.6-terra' }),
    ]

    const html = renderWithQuery(
      <TaskDetailDrawer
        taskId="task-tier-test"
        onClose={() => {}}
        stepSpans={spans}
        proposals={[]}
        initialState={{ kind: 'loading' }}
      />,
    )

    expect(html).toContain('balanced (gpt-5.6-terra)')
  })

  it('omits the tier-model span when both declaredTier and resolvedModel are null', () => {
    const spans: StepSpan[] = [
      baseSpan({ declaredTier: null, resolvedModel: null }),
    ]

    const html = renderWithQuery(
      <TaskDetailDrawer
        taskId="task-tier-test"
        onClose={() => {}}
        stepSpans={spans}
        proposals={[]}
        initialState={{ kind: 'loading' }}
      />,
    )

    expect(html).not.toContain('data-testid="step-tier-model"')
  })

  it('omits the tier-model span when the fields are absent from the span', () => {
    // Spans without the new fields (legacy shape from older daemon versions)
    // must not render the tier-model chip.
    const spans: StepSpan[] = [baseSpan()]

    const html = renderWithQuery(
      <TaskDetailDrawer
        taskId="task-tier-test"
        onClose={() => {}}
        stepSpans={spans}
        proposals={[]}
        initialState={{ kind: 'loading' }}
      />,
    )

    expect(html).not.toContain('data-testid="step-tier-model"')
  })
})
