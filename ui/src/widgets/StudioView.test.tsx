/**
 * StudioView tests.
 *
 * Strategy (mirrors ArcTree.test.tsx):
 *  - The pure model helpers (`buildStudioRuns`, `liveElapsedLabel`,
 *    `stepPromptKey`) are tested directly — no DOM needed.
 *  - The `StudioView` component is exercised via renderToStaticMarkup for
 *    structure assertions. Panels use native <details> so their content is
 *    always present in the static markup; the `stepPrompts`/`nowMs` seams
 *    control prompt content and the live-elapsed clock without effects.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { RunTimeline, RunTimelineStep } from '@/widgets/TaskDetailDrawer'
import type { StepPrompt } from '@/entities/studio/types'
import { buildStudioRuns, liveElapsedLabel, stepPromptKey, StudioView } from './StudioView'

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

const step = (overrides: Partial<RunTimelineStep> & { stepName: string }): RunTimelineStep => ({
  phase: null,
  workerName: null,
  status: 'completed',
  startedAt: '2025-01-01T10:00:00.000Z',
  endedAt: '2025-01-01T10:00:00.564Z',
  durationMs: 564,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  claudeSessionId: null,
  failureReason: null,
  resultJson: null,
  ...overrides,
})

const timeline = (steps: RunTimelineStep[], runId = 'wf-1'): RunTimeline => ({
  taskId: 'task-1',
  runs:
    steps.length === 0
      ? []
      : [
          {
            runId,
            startedAt: steps[0].startedAt,
            endedAt: steps.every((s) => s.status !== 'running')
              ? (steps.at(-1)?.endedAt ?? null)
              : null,
            steps,
          },
        ],
})

// ---------------------------------------------------------------------------
// buildStudioRuns — pure model
// ---------------------------------------------------------------------------

describe('buildStudioRuns', () => {
  it('returns one model per run with StepCardEntry bodies in step order', () => {
    const t = timeline([
      step({ stepName: 'setup-worktree', phase: 'setup' }),
      step({
        stepName: 'run-claude-code',
        phase: 'code',
        workerName: 'Coder',
        startedAt: '2025-01-01T10:00:01.000Z',
        endedAt: '2025-01-01T10:00:13.300Z',
        durationMs: 12300,
      }),
    ])

    const runs = buildStudioRuns(t)

    expect(runs.length).toBe(1)
    expect(runs[0].runId).toBe('wf-1')
    expect(runs[0].entries.map((e) => e.stepName)).toEqual([
      'setup-worktree',
      'run-claude-code',
    ])
    // The entries carry the drawer's unified outcome/status field.
    expect(runs[0].entries[1].outcome).toBe('completed')
    expect(runs[0].entries[1].workerName).toBe('Coder')
    expect(runs[0].entries[1].durationMs).toBe(12300)
  })

  it('returns an empty list for a timeline with no runs', () => {
    expect(buildStudioRuns({ taskId: 't', runs: [] })).toEqual([])
  })

  it('preserves multiple runs in chronological order', () => {
    const t: RunTimeline = {
      taskId: 'task-1',
      runs: [
        { runId: 'wf-1', startedAt: '2025-01-01T10:00:00.000Z', endedAt: '2025-01-01T10:01:00.000Z', steps: [step({ stepName: 'setup-worktree' })] },
        { runId: 'wf-2', startedAt: '2025-01-01T11:00:00.000Z', endedAt: null, steps: [step({ stepName: 'setup-worktree', status: 'running', endedAt: null, durationMs: null })] },
      ],
    }
    expect(buildStudioRuns(t).map((r) => r.runId)).toEqual(['wf-1', 'wf-2'])
  })
})

describe('liveElapsedLabel', () => {
  it('formats the elapsed time between startedAt and now', () => {
    const startedAt = '2025-01-01T10:00:00.000Z'
    expect(liveElapsedLabel(startedAt, Date.parse(startedAt) + 500)).toBe('500ms')
    expect(liveElapsedLabel(startedAt, Date.parse(startedAt) + 12_300)).toBe('12.3s')
  })

  it('clamps negative elapsed to 0 and tolerates bad timestamps', () => {
    const startedAt = '2025-01-01T10:00:00.000Z'
    expect(liveElapsedLabel(startedAt, Date.parse(startedAt) - 1000)).toBe('0ms')
    expect(liveElapsedLabel('not-a-date', 0)).toBe('—')
  })
})

// ---------------------------------------------------------------------------
// StudioView — structure
// ---------------------------------------------------------------------------

describe('StudioView', () => {
  it('renders every step as a node in execution order with connectors between', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({ stepName: 'setup-worktree', phase: 'setup' }),
          step({ stepName: 'run-claude-code', phase: 'code', workerName: 'Coder', startedAt: '2025-01-01T10:00:01.000Z' }),
          step({ stepName: 'verify', phase: 'verify', startedAt: '2025-01-01T10:00:02.000Z' }),
        ])}
      />,
    )

    const nodeCount = (html.match(/data-testid="studio-node"/g) ?? []).length
    const connectorCount = (html.match(/data-testid="studio-connector"/g) ?? []).length
    expect(nodeCount).toBe(3)
    // N nodes → N-1 connectors: the tree ends where execution ended.
    expect(connectorCount).toBe(2)
    // Execution order preserved in the markup.
    expect(html.indexOf('setup-worktree')).toBeLessThan(html.indexOf('run-claude-code'))
    expect(html.indexOf('run-claude-code')).toBeLessThan(html.indexOf('verify'))
  })

  it('shows status, duration, and worker on the node face', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({ stepName: 'run-claude-code', workerName: 'Coder', durationMs: 564 }),
        ])}
      />,
    )

    expect(html).toContain('data-outcome="completed"')
    expect(html).toContain('aria-label="completed"')
    expect(html).toContain('564ms')
    expect(html).toContain('Coder')
  })

  it('shows live elapsed time on a running node (frozen via the nowMs seam)', () => {
    const startedAt = '2025-01-01T10:00:00.000Z'
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({ stepName: 'run-claude-code', workerName: 'Coder', status: 'running', startedAt, endedAt: null, durationMs: null }),
        ])}
        nowMs={Date.parse(startedAt) + 12_300}
      />,
    )

    expect(html).toContain('data-outcome="running"')
    expect(html).toContain('aria-label="running"')
    expect(html).toContain('12.3s')
    expect(html).toContain('in flight')
  })

  it('surfaces failureReason on a failed node face', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({ stepName: 'verify', status: 'failed', failureReason: 'exit-1' }),
        ])}
      />,
    )

    expect(html).toContain('data-outcome="failed"')
    expect(html).toContain('data-testid="studio-node-failure"')
    expect(html).toContain('exit-1')
  })

  it('renders pretty-printed resultJson and token counts in the Output panel', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({
            stepName: 'run-claude-code',
            workerName: 'Coder',
            resultJson: '{"ok":true}',
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
          }),
        ])}
      />,
    )

    expect(html).toContain('data-testid="studio-output-json"')
    expect(html).toContain('&quot;ok&quot;: true')
    expect(html).toContain('in:1000')
    expect(html).toContain('out:500')
    expect(html).toContain('cache:200')
  })

  it('renders the persisted prompt verbatim in the trace panel via the stepPrompts seam', () => {
    const prompt: StepPrompt = {
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
      prompt: 'You are the Coder.\n<files>a.ts</files>',
      source: 'persisted',
    }
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({ stepName: 'run-claude-code', workerName: 'Coder', claudeSessionId: 'sess-12345678' }),
        ])}
        stepPrompts={{ [stepPromptKey('wf-1', 'run-claude-code')]: prompt }}
      />,
    )

    expect(html).toContain('data-testid="studio-prompt-text"')
    expect(html).toContain('You are the Coder.')
    expect(html).toContain('&lt;files&gt;a.ts&lt;/files&gt;')
    expect(html).toContain('>persisted<')
    expect(html).toContain('session:sess-123')
  })

  it('labels a recovered prompt as recovered from transcript', () => {
    const prompt: StepPrompt = {
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
      prompt: 'recovered text',
      source: 'recovered',
    }
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([step({ stepName: 'run-claude-code', workerName: 'Coder' })])}
        stepPrompts={{ [stepPromptKey('wf-1', 'run-claude-code')]: prompt }}
      />,
    )

    expect(html).toContain('recovered from transcript')
  })

  it('renders an explicit empty message when no prompt is recoverable', () => {
    const prompt: StepPrompt = {
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
      prompt: null,
      source: null,
    }
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([step({ stepName: 'run-claude-code', workerName: 'Coder' })])}
        stepPrompts={{ [stepPromptKey('wf-1', 'run-claude-code')]: prompt }}
      />,
    )

    expect(html).toContain('data-testid="studio-prompt-empty"')
    expect(html).toContain('No prompt recorded for this step')
  })

  it('renders a non-worker message instead of a prompt for non-LLM steps', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([step({ stepName: 'setup-worktree' })])}
      />,
    )

    expect(html).toContain('Non-worker step')
  })

  it('renders an explicit empty state naming the task when no runs exist', () => {
    const html = render(
      <StudioView taskId="task-empty" timeline={{ taskId: 'task-empty', runs: [] }} />,
    )

    expect(html).toContain('data-testid="studio-empty"')
    expect(html).toContain('task-empty')
    expect(html).toContain('No step spans recorded')
    // Never a node or a spinner pretending to load.
    expect(html).not.toContain('data-testid="studio-node"')
  })

  it('renders each run as its own section when a task has multiple runs', () => {
    const t: RunTimeline = {
      taskId: 'task-1',
      runs: [
        { runId: 'wf-1', startedAt: '2025-01-01T10:00:00.000Z', endedAt: '2025-01-01T10:01:00.000Z', steps: [step({ stepName: 'setup-worktree' })] },
        { runId: 'wf-2', startedAt: '2025-01-01T11:00:00.000Z', endedAt: null, steps: [step({ stepName: 'setup-worktree', status: 'running', endedAt: null, durationMs: null })] },
      ],
    }
    const html = render(<StudioView taskId="task-1" timeline={t} />)

    const runCount = (html.match(/data-testid="studio-run"/g) ?? []).length
    expect(runCount).toBe(2)
    expect(html).toContain('Run 1 of 2')
    expect(html).toContain('Run 2 of 2')
    expect(html.indexOf('wf-1')).toBeLessThan(html.indexOf('wf-2'))
  })

  it('links a primitive-backed node phase chip to the primitive facet drawer', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([
          step({ stepName: 'run-claude-code', phase: 'code', workerName: 'Coder' }),
          step({ stepName: 'verify', phase: 'verify', startedAt: '2025-01-01T10:00:01.000Z' }),
          step({ stepName: 'behaviour-verify', phase: 'verify', workerName: 'BehaviourVerifier', startedAt: '2025-01-01T10:00:02.000Z' }),
        ])}
      />,
    )

    expect(html).toContain('data-testid="studio-node-primitive-link"')
    expect(html).toContain('href="#/primitive/runAgent"')
    expect(html).toContain('href="#/primitive/verify"')
    // The shared 'verify' phase splits on the behaviour-verify step name.
    expect(html).toContain('href="#/primitive/behaviourVerify"')
  })

  it('keeps a plain phase chip when the phase maps to no primitive', () => {
    const html = render(
      <StudioView
        taskId="task-1"
        timeline={timeline([step({ stepName: 'custom-step', phase: 'exotic' })])}
      />,
    )

    expect(html).toContain('exotic')
    expect(html).not.toContain('data-testid="studio-node-primitive-link"')
  })
})
