/**
 * PrimitiveDetailDrawer tests.
 *
 * Strategy (mirrors StudioView.test.tsx):
 *  - The pure helpers (`primitiveRunToCard`, `windowSuccessRate`,
 *    `executorLabel`, and the entity's `primitiveForStep`) are tested
 *    directly — no DOM needed.
 *  - The drawer component is exercised via renderToStaticMarkup with the
 *    pre-loaded `detail` seam, so the fetch never fires and each executor
 *    branch (agent / shell / human) renders synchronously.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { PrimitiveDetail, PrimitiveRun } from '@/entities/primitive/types'
import { primitiveForStep } from '@/entities/primitive/types'
import {
  executorLabel,
  primitiveRunToCard,
  PrimitiveDetailDrawer,
  windowSuccessRate,
} from './PrimitiveDetailDrawer'

const render = (element: ReactElement): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{element}</QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const run = (overrides: Partial<PrimitiveRun> = {}): PrimitiveRun => ({
  stepName: 'verify',
  workflowInstanceId: 'wf-1',
  outcome: 'completed',
  startedAt: '2025-01-01T10:00:00.000Z',
  endedAt: '2025-01-01T10:00:01.500Z',
  durationMs: 1500,
  taskId: 'mars-task-1',
  originId: null,
  workerName: null,
  claudeSessionId: null,
  ...overrides,
})

const detail = (overrides: Partial<PrimitiveDetail> = {}): PrimitiveDetail => ({
  primitive: {
    name: 'verify',
    description: 'Scope-aware static gate over the committed changes.',
    phase: 'verify',
    executor: 'shell',
  },
  workers: [],
  observedTools: [],
  caveats: [],
  runs: [],
  parks: [],
  window: 50,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('primitiveForStep', () => {
  it('maps phases to primitives, splitting verify on the behaviour-verify step name', () => {
    expect(primitiveForStep('setup', 'setup-worktree')).toBe('setupWorktree')
    expect(primitiveForStep('code', 'run-claude-code')).toBe('runAgent')
    expect(primitiveForStep('verify', 'verify')).toBe('verify')
    expect(primitiveForStep('verify', 'behaviour-verify')).toBe('behaviourVerify')
    expect(primitiveForStep('merge', 'merge')).toBe('merge')
    expect(primitiveForStep(null, 'anything')).toBeNull()
    expect(primitiveForStep('unknown', 'anything')).toBeNull()
  })
})

describe('primitiveRunToCard', () => {
  it('normalises a run into the drawer StepCardEntry shape', () => {
    const card = primitiveRunToCard(
      run({ outcome: 'failed', workerName: 'Coder', claudeSessionId: 'sess-1' }),
      0,
    )
    expect(card.stepName).toBe('verify')
    expect(card.outcome).toBe('failed')
    expect(card.workerName).toBe('Coder')
    expect(card.claudeSessionId).toBe('sess-1')
    expect(card.durationMs).toBe(1500)
  })

  it('coerces non-terminal wire outcomes to running', () => {
    expect(primitiveRunToCard(run({ outcome: 'running' }), 0).outcome).toBe('running')
    expect(primitiveRunToCard(run({ outcome: 'weird-future-outcome' }), 0).outcome).toBe(
      'running',
    )
  })
})

describe('windowSuccessRate', () => {
  it('returns null when nothing finished (no fake 0%/100%)', () => {
    expect(windowSuccessRate([])).toBeNull()
    expect(windowSuccessRate([run({ outcome: 'running' })])).toBeNull()
  })

  it('computes the rate over finished runs only', () => {
    const runs = [
      run({ outcome: 'completed' }),
      run({ outcome: 'failed' }),
      run({ outcome: 'running' }),
      run({ outcome: 'completed' }),
    ]
    // 2 of 3 finished runs completed.
    expect(windowSuccessRate(runs)).toBe(67)
  })
})

describe('executorLabel', () => {
  it('names each executor honestly', () => {
    expect(executorLabel('agent')).toBe('agent step')
    expect(executorLabel('shell')).toBe('deterministic shell step')
    expect(executorLabel('human')).toBe('human step')
  })
})

// ---------------------------------------------------------------------------
// Drawer rendering — agent surface
// ---------------------------------------------------------------------------

describe('PrimitiveDetailDrawer — agent primitive (runAgent)', () => {
  const agentDetail = detail({
    primitive: {
      name: 'runAgent',
      description: 'Run the coder inside the worktree.',
      phase: 'code',
      executor: 'agent',
    },
    workers: [
      {
        workerName: 'Coder',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        permissionMode: 'bypassPermissions',
        forfeitedTools: [],
        source: 'built-in',
      },
      {
        workerName: 'Fixer',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        permissionMode: 'bypassPermissions',
        forfeitedTools: ['Bash(mars task add*)', 'Bash(mars proposal*)'],
        source: 'built-in',
      },
      {
        workerName: 'DocsWriter',
        model: 'claude-haiku-4-5-20251001',
        effort: 'low',
        permissionMode: 'default',
        forfeitedTools: ['Edit'],
        source: 'registry',
      },
    ],
    caveats: ["mode:'manual' spawns no agent."],
    runs: [
      run({
        stepName: 'run-claude-code',
        outcome: 'completed',
        workerName: 'Coder',
        claudeSessionId: 'session-abc-123',
        taskId: 'mars-t1',
      }),
    ],
  })

  const html = render(
    <PrimitiveDetailDrawer name="runAgent" onClose={() => {}} detail={agentDetail} />,
  )

  it('shows identity: name, description, executor and phase chips', () => {
    expect(html).toContain('runAgent')
    expect(html).toContain('Run the coder inside the worktree.')
    expect(html).toContain('agent step')
    expect(html).toContain('phase:code')
  })

  it('renders one Authorization profile per candidate Worker', () => {
    expect(html).toContain('data-worker-name="Coder"')
    expect(html).toContain('data-worker-name="Fixer"')
    expect(html).toContain('data-worker-name="DocsWriter"')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('bypassPermissions')
  })

  it('shows forfeited tools when present and the full-surface note when empty', () => {
    expect(html).toContain('Bash(mars task add*)')
    expect(html).toContain('Full tool surface — no forfeited tools.')
  })

  it('marks operator-declared Workers with the registry badge', () => {
    expect(html).toContain('registry')
  })

  it('renders run rows with Worker, session id, and task + Studio links', () => {
    expect(html).toContain('data-testid="primitive-run-row"')
    expect(html).toContain('session:session-')
    expect(html).toContain('href="#/task/mars-t1"')
    expect(html).toContain('href="#/studio/mars-t1"')
  })

  it('labels the history window explicitly (last N, not all-time)', () => {
    expect(html).toContain('last 50 runs only, not all-time')
  })
})

// ---------------------------------------------------------------------------
// Drawer rendering — shell surface
// ---------------------------------------------------------------------------

describe('PrimitiveDetailDrawer — shell primitive (merge)', () => {
  const mergeDetail = detail({
    primitive: {
      name: 'merge',
      description: 'Fast-forward into the integration branch.',
      phase: 'merge',
      executor: 'shell',
    },
    observedTools: [
      { tool: 'git', count: 12, lastInvokedAt: '2025-01-01T10:00:00.000Z' },
      { tool: 'gh', count: 1, lastInvokedAt: '2025-01-01T09:00:00.000Z' },
    ],
    caveats: [
      'The conflict path escalates to Vega (the vcs-supervisor agent).',
      'Preview-gated tasks start a dev server.',
    ],
    runs: [run({ stepName: 'merge', outcome: 'failed', taskId: 'mars-t9' })],
  })

  const html = render(
    <PrimitiveDetailDrawer name="merge" onClose={() => {}} detail={mergeDetail} />,
  )

  it('lists observed shell tools with counts', () => {
    expect(html).toContain('git ×12')
    expect(html).toContain('gh ×1')
  })

  it('never renders an agent Worker section for a shell primitive', () => {
    expect(html).not.toContain('data-testid="primitive-worker-profile"')
  })

  it('states the Vega and dev-server caveats verbatim', () => {
    expect(html).toContain('Vega')
    expect(html).toContain('dev server')
  })

  it('shows the explicit empty state when no tools were observed', () => {
    const emptyHtml = render(
      <PrimitiveDetailDrawer
        name="verify"
        onClose={() => {}}
        detail={detail({ observedTools: [] })}
      />,
    )
    expect(emptyHtml).toContain('No shell tools observed in the trace window yet.')
  })

  it('shows the explicit empty state when no runs exist', () => {
    const emptyHtml = render(
      <PrimitiveDetailDrawer name="verify" onClose={() => {}} detail={detail()} />,
    )
    expect(emptyHtml).toContain('No Step spans recorded in the trace window yet.')
  })
})

// ---------------------------------------------------------------------------
// Drawer rendering — human framing
// ---------------------------------------------------------------------------

describe('PrimitiveDetailDrawer — human primitive (awaitHuman)', () => {
  const humanDetail = detail({
    primitive: {
      name: 'awaitHuman',
      description: 'Park the task awaiting-human.',
      phase: null,
      executor: 'human',
    },
    caveats: ["Deprecated as an authoring surface — prefer mode:'manual'."],
    parks: [
      {
        taskId: 'mars-parked-1',
        stepName: 'design-review',
        parkedAt: '2025-01-01T09:00:00.000Z',
        leaseOwner: 'operator:tty1',
      },
    ],
  })

  const html = render(
    <PrimitiveDetailDrawer name="awaitHuman" onClose={() => {}} detail={humanDetail} />,
  )

  it('states "human step — no tool surface" instead of a fake empty list', () => {
    expect(html).toContain('Human step — no tool surface.')
    expect(html).not.toContain('data-testid="primitive-worker-profile"')
    expect(html).not.toContain('data-testid="primitive-observed-tool"')
  })

  it('renders parks (task, step, lease owner) — never fabricated spans', () => {
    expect(html).toContain('data-testid="primitive-park-row"')
    expect(html).toContain('mars-parked-1')
    expect(html).toContain('step:design-review')
    expect(html).toContain('lease:operator:tty1')
    expect(html).not.toContain('data-testid="primitive-run-row"')
  })

  it('shows the explicit empty state when no parks exist', () => {
    const emptyHtml = render(
      <PrimitiveDetailDrawer
        name="awaitHuman"
        onClose={() => {}}
        detail={{ ...humanDetail, parks: [] }}
      />,
    )
    expect(emptyHtml).toContain('No parks recorded.')
  })
})

// ---------------------------------------------------------------------------
// Drawer chrome
// ---------------------------------------------------------------------------

describe('PrimitiveDetailDrawer — chrome and navigation', () => {
  const html = render(
    <PrimitiveDetailDrawer name="verify" onClose={() => {}} detail={detail()} />,
  )

  it('renders as a modal dialog with scrim and close button', () => {
    expect(html).toContain('data-testid="primitive-detail-overlay"')
    expect(html).toContain('data-testid="primitive-detail-drawer"')
    expect(html).toContain('data-testid="primitive-detail-close"')
    expect(html).toContain('role="dialog"')
  })

  it('links to the five sibling primitives and marks the current one', () => {
    expect(html).toContain('href="#/primitive/setupWorktree"')
    expect(html).toContain('href="#/primitive/runAgent"')
    expect(html).toContain('href="#/primitive/behaviourVerify"')
    expect(html).toContain('href="#/primitive/merge"')
    expect(html).toContain('href="#/primitive/awaitHuman"')
    // The current primitive is a non-link marker, not an anchor.
    expect(html).not.toContain('href="#/primitive/verify"')
    expect(html).toContain('aria-current="page"')
  })

  it('renders the loading state before any detail arrives', () => {
    const loadingHtml = render(<PrimitiveDetailDrawer name="verify" onClose={() => {}} />)
    expect(loadingHtml).toContain('Loading primitive…')
  })
})
