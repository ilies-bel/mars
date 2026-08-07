import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  OriginsResponse,
  ProgressProposalNode,
  ProgressTask,
  Task,
  TraceEvent,
} from '@/shared/schemas'
import type { RunTimeline, RunTimelineEntry, RunTimelineStep, StepSpan } from './TaskDetailDrawer'
import {
  TaskDetailDrawer,
  TaskDetailBody,
  applyNavigate,
  crumbLabel,
} from './TaskDetailDrawer'

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Wraps a JSX element in a fresh QueryClientProvider before static rendering.
 * TaskDetailDrawer uses useQuery internally (so SSE invalidations update the
 * drawer in place); every drawer render therefore needs a QueryClient in context.
 */
const renderDrawer = (element: ReactElement): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{element}</QueryClientProvider>,
  )
}

const task = (
  overrides: Partial<ProgressTask> & { id: string; cluster: ProgressTask['cluster'] },
): ProgressTask => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'queued',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  recoverySpawnedCount: 0,
  blockerTaskId: null,
  blockedBy: overrides.blockedBy ?? [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: overrides.cluster,
  parentProposalId: overrides.parentProposalId ?? null,
  ...overrides,
})

const proposal = (id: string, title = `Goal ${id}`): ProgressProposalNode => ({
  id,
  title,
  source: 'human',
  status: 'prd-ready',
})

// ── Identity tests (pre-existing) ─────────────────────────────────────────────

/**
 * The TaskDetailDrawer is the single detail surface for task nodes on the
 * Progress tab.  Both the DAG (TopologyView) and the column view (BoardView /
 * TaskCard) navigate to `#/task/<id>`, and App.tsx mounts exactly one
 * TaskDetailDrawer in response.  These tests verify that the component has a
 * consistent, identifiable structure — "same drawer" criterion.
 */
describe('TaskDetailDrawer – identity (same surface from both views)', () => {
  it('renders a dialog with the task-detail-drawer testid', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-drawer"')
    expect(html).toContain('role="dialog"')
  })

  it('displays the task id in the drawer heading', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('mars-abc123')
  })

  it('exposes a close control via data-testid', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-close"')
  })

  it('renders the same drawer structure regardless of which task id is passed', () => {
    const html1 = renderDrawer(
      <TaskDetailDrawer taskId="task-from-dag" onClose={() => {}} />,
    )
    const html2 = renderDrawer(
      <TaskDetailDrawer taskId="task-from-board" onClose={() => {}} />,
    )
    // Both render the same structural shell (dialog role, same testids).
    expect(html1).toContain('role="dialog"')
    expect(html2).toContain('role="dialog"')
    expect(html1).toContain('data-testid="task-detail-drawer"')
    expect(html2).toContain('data-testid="task-detail-drawer"')
    expect(html1).toContain('data-testid="task-detail-close"')
    expect(html2).toContain('data-testid="task-detail-close"')
  })
})

// ── Subgraph: isolated task ───────────────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (isolated task)', () => {
  it('renders the subgraph section and the focused task node when the task has no neighbours', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="task-solo"
        onClose={() => {}}
        tasks={[task({ id: 'task-solo', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-testid="task-detail-subgraph"')
    expect(html).toContain('data-node-id="task-solo"')
  })

  it('renders exactly one node when the task has no blockers, dependents, or proposal', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="task-solo"
        onClose={() => {}}
        tasks={[task({ id: 'task-solo', cluster: 'In progress' })]}
        proposals={[]}
      />,
    )
    const nodeCount = (html.match(/data-node-id=/g) ?? []).length
    expect(nodeCount).toBe(1)
  })

  it('does not render the subgraph section when tasks prop is not provided', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="task-solo" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="task-detail-subgraph"')
  })
})

// ── Subgraph: upstream blocker chain ─────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (upstream blockers)', () => {
  it('includes a direct upstream blocker in the subgraph', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'blocker', cluster: 'In progress' }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['blocker'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-node-id="blocker"')
    expect(html).toContain('data-node-id="focus"')
  })

  it('includes the full upstream chain back to the root', () => {
    // root → mid → focus
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'root', cluster: 'Queued' }),
          task({ id: 'mid', cluster: 'In progress', blockedBy: ['root'] }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['mid'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-node-id="root"')
    expect(html).toContain('data-node-id="mid"')
    expect(html).toContain('data-node-id="focus"')
  })

  it('renders a blocker edge between the upstream blocker and the focused task', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'blocker', cluster: 'In progress' }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['blocker'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-edge-kind="blocker"')
  })

  it('excludes tasks unrelated to the focused task', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'focus', cluster: 'Queued' }),
          task({ id: 'unrelated', cluster: 'In progress' }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).not.toContain('data-node-id="unrelated"')
  })
})

// ── Subgraph: one-hop downstream dependents ───────────────────────────────────

describe('TaskDetailDrawer – subgraph (downstream dependents)', () => {
  it('includes the immediate (one-hop) downstream dependent', () => {
    // focus → child → grandchild; only child should appear
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'focus', cluster: 'In progress' }),
          task({ id: 'child', cluster: 'Blocked', blockedBy: ['focus'] }),
          task({ id: 'grandchild', cluster: 'Queued', blockedBy: ['child'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-node-id="child"')
    expect(html).not.toContain('data-node-id="grandchild"')
  })
})

// ── Subgraph: originating proposal ───────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (originating proposal)', () => {
  it('includes the originating proposal node when one exists', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[task({ id: 'focus', cluster: 'Queued', parentProposalId: 'prop-1' })]}
        proposals={[proposal('prop-1', 'Ship the feature')]}
      />,
    )
    expect(html).toContain('data-node-id="prop-1"')
    expect(html).toContain('data-node-kind="proposal"')
  })

  it('renders a provenance edge from the proposal to the focused task', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[task({ id: 'focus', cluster: 'Queued', parentProposalId: 'prop-1' })]}
        proposals={[proposal('prop-1')]}
      />,
    )
    expect(html).toContain('data-edge-kind="provenance"')
  })

  it('does not include other tasks sliced from the same proposal', () => {
    // prop-1 also sliced "sibling"; the drawer should not pull sibling in
    // via the proposal — it is not upstream, downstream, or provenance of focus.
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'focus', cluster: 'Queued', parentProposalId: 'prop-1' }),
          task({ id: 'sibling', cluster: 'Queued', parentProposalId: 'prop-1' }),
        ]}
        proposals={[proposal('prop-1')]}
      />,
    )
    expect(html).not.toContain('data-node-id="sibling"')
  })
})

// ── A11y: scrim + focusable drawer ───────────────────────────────────────────

/**
 * These tests verify the static HTML structure that enables the keyboard /
 * pointer a11y behaviours (Escape-to-close, outside-click dismiss, focus trap,
 * focus restoration).  The interactive side of those behaviours (actual key
 * events and focus movement) requires a live DOM and is covered by the Manual
 * verification steps in the task spec.
 */
describe('TaskDetailDrawer – a11y overlay and focusability', () => {
  it('renders a scrim overlay element alongside the drawer panel', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-overlay"')
  })

  it('scrim is aria-hidden so it does not pollute the screen reader tree', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('aria-hidden="true"')
  })

  it('scrim uses z-40 (lower than the drawer z-50) so the drawer stays on top', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('z-40')
    expect(html).toContain('z-50')
  })

  it('drawer panel has tabindex="-1" so it can receive programmatic focus on open', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('tabindex="-1"')
  })
})

// ── Drawer entrance animation ────────────────────────────────────────────────

/**
 * These tests verify the static HTML structure that enables the CSS entrance
 * and exit animations.  The actual motion (transform/opacity transitions) is a
 * browser concern and is not exercised in unit tests; these tests confirm that
 * the CSS anchor classes and data attributes are present in the rendered markup.
 */
describe('TaskDetailDrawer – entrance / exit animation structure', () => {
  it('aside panel carries the drawer-panel CSS class (entrance animation anchor)', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('drawer-panel')
  })

  it('scrim carries the drawer-scrim CSS class (scrim fade anchor)', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('drawer-scrim')
  })

  it('data-closing is absent on initial render — exit animation not yet active', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-closing="true"')
  })
})

// ── Responsive shell: full-bleed sheet < xl, right drawer ≥ xl ────────────────

/**
 * The shell is responsive at the Tailwind `xl` breakpoint (1280px): below xl it
 * is a full-bleed sheet (covers the viewport, no scrim), at xl it is the
 * original right-side drawer with the dimming scrim behind it. The suite runs
 * under renderToStaticMarkup (no real viewport), so these assertions check the
 * className strings rather than computed layout.
 */
describe('TaskDetailDrawer – responsive shell (sheet < xl, drawer ≥ xl)', () => {
  // Pull the class attribute off a single element by testid from the markup.
  const classOf = (html: string, testid: string): string => {
    const re = new RegExp(`data-testid="${testid}"[^>]*?\\sclass="([^"]*)"`)
    const m = html.match(re)
    return m?.[1] ?? ''
  }

  it('panel is full-bleed below xl and a right drawer at xl', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    const cls = classOf(html, 'task-detail-drawer')
    // Full-bleed sheet defaults.
    expect(cls).toContain('inset-0')
    expect(cls).toContain('w-full')
    // xl: right-side drawer overrides.
    expect(cls).toContain('xl:right-0')
    expect(cls).toContain('xl:left-auto')
    expect(cls).toContain('xl:w-[min(560px,100vw)]')
    expect(cls).toContain('xl:border-l')
  })

  it('scrim is hidden below xl and shown at xl', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    const cls = classOf(html, 'task-detail-overlay')
    expect(cls).toContain('hidden')
    expect(cls).toContain('xl:block')
  })
})

// ── Subgraph: context chips — light-surface layout ────────────────────────────

/**
 * The context section renders flex-wrap chips instead of an absolute-positioned
 * SVG canvas so labels never overlap and the chips look native on the drawer's
 * light card background.
 *
 * Each chip is an <a> element with light-surface Tailwind classes
 * (bg-secondary, border-border, text-foreground) and a small colored status dot
 * (backgroundColor = var(--color-dag-*-fill)) for cluster identity.
 */
describe('TaskDetailDrawer – subgraph (light-surface flex chips)', () => {
  it('renders context chips with bg-secondary class for light surface', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('bg-secondary')
  })

  it('renders context chips with border-border class for light surface', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('border-border')
  })

  it('renders context chips with text-foreground class for light surface', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('text-foreground')
  })

  it('does not render an SVG element in the context section (replaced by flex chips)', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    // The context section must NOT contain an SVG; chips are HTML elements.
    const sectionMatch = html.match(
      /data-testid="task-detail-subgraph"[\s\S]*?<\/section>/,
    )
    expect(sectionMatch?.[0] ?? '').not.toContain('<svg')
  })

  it('each chip appears exactly once — no overlapping duplicate nodes', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'blocker', cluster: 'In progress' }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['blocker'] }),
        ]}
        proposals={[]}
      />,
    )
    const blockerCount = (html.match(/data-node-id="blocker"/g) ?? []).length
    const focusCount = (html.match(/data-node-id="focus"/g) ?? []).length
    expect(blockerCount).toBe(1)
    expect(focusCount).toBe(1)
  })

  it('each chip with a proposal + task has exactly one node each (two chips total)', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]}
        proposals={[proposal('p1', 'Show Release Notes')]}
      />,
    )
    const p1Count = (html.match(/data-node-id="p1"/g) ?? []).length
    const t1Count = (html.match(/data-node-id="t1"/g) ?? []).length
    expect(p1Count).toBe(1)
    expect(t1Count).toBe(1)
  })
})

// ── Subgraph: cluster status dot (dag fill color) ─────────────────────────────

/**
 * Each chip carries a small colored dot whose background-color is the dag
 * cluster fill token — this preserves visual cluster identity without painting
 * the whole chip with the dark-canvas palette.
 */
describe('TaskDetailDrawer – subgraph (cluster status dot uses dag fill color)', () => {
  it('status dot for a Queued task uses the Queued fill token', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-queued-fill)')
  })

  it('status dot for a Failed task uses the Failed fill token', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-failed-fill)')
  })

  it('status dot for a Blocked task uses the Blocked fill token', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Blocked', status: 'blocked' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-blocked-fill)')
  })

  it('status dot for an In progress task uses the In progress fill token', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'In progress', status: 'running' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-in-progress-fill)')
  })

  it('status dot for a proposal node uses the proposal fill token', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).toContain('var(--color-dag-proposal-fill)')
  })

  it('attaches data-cluster to task chip elements for cluster identification', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-cluster="Failed"')
  })
})

// ── Subgraph: node click affordance (drill-in) ────────────────────────────────

/**
 * Each subgraph node must be wrapped in an SVG <a> element so clicking (or
 * pressing Enter) invokes navigate() and updates the breadcrumb trail — the
 * same drill-in mechanic the OriginTree rows use.  The <a> also provides
 * native keyboard focus without custom key handlers (matching TopologyView).
 */
describe('TaskDetailDrawer – subgraph node click affordance', () => {
  it('task subgraph nodes are wrapped in anchor links for click/keyboard drill-in', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'blocker', cluster: 'Queued' }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['blocker'] }),
        ]}
        proposals={[]}
      />,
    )
    // Both nodes are reachable via their anchor href.
    expect(html).toContain('href="#/task/focus"')
    expect(html).toContain('href="#/task/blocker"')
  })

  it('proposal nodes in the subgraph also carry a click affordance', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]}
        proposals={[proposal('p1')]}
      />,
    )
    // The proposal node must also be clickable (navigate() handles proposal ids).
    expect(html).toContain('href="#/task/p1"')
  })

  it('subgraph anchor nodes carry cursor-pointer styling (same as TopologyView)', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('cursor:pointer')
  })

  it('data-node-id attribute is still present on the inner <g> after adding the anchor wrapper', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    // Existing structural test must still pass after wrapping in <a>.
    expect(html).toContain('data-node-id="t1"')
  })
})

// ── Detail body: tiered metadata + spec + origin mount ────────────────────────

/**
 * The `ready` body is split into the pure `TaskDetailBody` so it renders
 * synchronously here — the drawer's own fetch effect never fires under
 * `renderToStaticMarkup` (no DOM env). The body mounts `OriginTree`, which
 * calls `useQuery`, so each render is wrapped in a `QueryClientProvider` with
 * the origins response pre-seeded (the TodoPageDetail convention).
 */

const fullTask = (overrides: Partial<Task> & { id: string }): Task => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'queued',
  plan: overrides.plan ?? null,
  branch: overrides.branch ?? null,
  worktreePath: overrides.worktreePath ?? null,
  error: overrides.error ?? null,
  failureSignature: overrides.failureSignature ?? null,
  dropReason: overrides.dropReason ?? null,
  recoverySpawnedCount: overrides.recoverySpawnedCount ?? 0,
  blockerTaskId: overrides.blockerTaskId ?? null,
  blockedBy: overrides.blockedBy ?? [],
  parentProposalId: overrides.parentProposalId ?? null,
  spec: overrides.spec ?? null,
  createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
  updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
  ...overrides,
})

const SINGLE_NODE_ORIGINS = (taskId: string): OriginsResponse => ({
  node: { id: taskId, kind: 'task', title: 'lone task', status: 'queued', children: [] },
})

const renderBody = (
  t: Task,
  origins?: OriginsResponse,
  currentStep?: { stepName: string; startedAt: string } | null,
): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  // null is the projectId slot — defaults to null outside FocusedProjectProvider
  qc.setQueryData(['origins', null, t.id], origins ?? SINGLE_NODE_ORIGINS(t.id))
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TaskDetailBody task={t} currentStep={currentStep} />
    </QueryClientProvider>,
  )
}

describe('TaskDetailBody – failed task with error', () => {
  const failed = fullTask({
    id: 'task-fail',
    status: 'failed',
    prompt: 'A long multi-line prompt that must surface in its own block.\nSecond line.',
    error: 'boom: something exploded\n  at frobnicate()',
    failureSignature: 'daemon-killed',
    spec: {
      files: ['src/a.ts', 'src/b.ts'],
      readFirst: ['docs/x.md'],
      prescriptiveAction: 'Refactor the frobnicator',
      verifyCmd: 'bun test src',
      doneCriteria: ['tests pass', 'lint clean'],
      mergeMode: 'auto',
    },
  })

  it('keeps the task-detail-status testid showing the status string', () => {
    const html = renderBody(failed)
    expect(html).toContain('data-testid="task-detail-status"')
    expect(html).toContain('failed')
  })

  it('renders the failure banner with the error text and failure signature', () => {
    const html = renderBody(failed)
    expect(html).toContain('data-testid="task-detail-error"')
    expect(html).toContain('boom: something exploded')
    expect(html).toContain('at frobnicate()')
    expect(html).toContain('daemon-killed')
  })

  it('does NOT render the spec builder breakdown — spec section is removed', () => {
    // Plan/spec builder breakdown is removed; spec data no longer surfaces as a
    // dedicated section in the task detail body.
    const html = renderBody(failed)
    expect(html).not.toContain('data-testid="task-detail-spec"')
  })

  it('mounts the origin tree and the meta + diagnostics sections', () => {
    const html = renderBody(failed)
    // OriginTree single-node empty-state still renders its Origins header.
    expect(html).toContain('Origins')
    expect(html).toContain('data-testid="task-detail-meta"')
    expect(html).toContain('data-testid="task-detail-diagnostics"')
  })

  it('shows the full prompt block when the prompt is multi-line', () => {
    const html = renderBody(failed)
    expect(html).toContain('must surface in its own block')
    expect(html).toContain('Second line.')
  })
})

describe('TaskDetailBody – blocked task', () => {
  it('renders the blocked banner noting the blocker count', () => {
    const html = renderBody(
      fullTask({ id: 'task-blocked', status: 'blocked', blockedBy: ['task-up'] }),
    )
    expect(html).toContain('data-testid="task-detail-error"')
    expect(html).toContain('Blocked')
    expect(html).toContain('Waiting on 1 blocker')
  })
})

describe('TaskDetailBody – minimal task omits empty sections', () => {
  // A short, single-line prompt with no error/spec/plan/blockers.
  const minimal = fullTask({ id: 'task-min', prompt: 'tiny', status: 'queued' })

  it('does not render the failure banner when there is no error/failure/block', () => {
    const html = renderBody(minimal)
    expect(html).not.toContain('data-testid="task-detail-error"')
  })

  it('does not render the step section when currentStep is not provided', () => {
    const html = renderBody(minimal)
    expect(html).not.toContain('data-testid="task-detail-current-step"')
  })

  it('does not render a redundant Prompt block when the prompt fits the header', () => {
    const html = renderBody(minimal)
    expect(html).not.toContain('>Prompt<')
  })

  it('still renders the always-present meta grid', () => {
    const html = renderBody(minimal)
    expect(html).toContain('data-testid="task-detail-meta"')
  })
})

// ── Long-prompt collapse ───────────────────────────────────────────────────────

// ── Workflow step indicator ────────────────────────────────────────────────────

/**
 * The `currentStep` prop drives a compact one-line "Step" section showing
 * the workflow step name and how long since the step started.  When `currentStep`
 * is absent or null no section is rendered (the Plan/Spec breakdown that
 * previously occupied this area has been removed entirely).
 */
describe('TaskDetailBody – workflow step indicator', () => {
  const running = fullTask({ id: 'task-run', status: 'running' })

  it('renders the step section with the step name when currentStep is provided', () => {
    const html = renderBody(running, undefined, {
      stepName: 'code',
      startedAt: '2026-01-01T10:00:00Z',
    })
    expect(html).toContain('data-testid="task-detail-current-step"')
    expect(html).toContain('code')
  })

  it('renders each of the four standard step names correctly', () => {
    for (const stepName of ['setup', 'code', 'verify', 'merge'] as const) {
      const html = renderBody(running, undefined, {
        stepName,
        startedAt: '2026-01-01T10:00:00Z',
      })
      expect(html).toContain(stepName)
    }
  })

  it('omits the step section when currentStep is null', () => {
    const html = renderBody(running, undefined, null)
    expect(html).not.toContain('data-testid="task-detail-current-step"')
  })

  it('omits the step section when currentStep is not passed at all', () => {
    const html = renderBody(running)
    expect(html).not.toContain('data-testid="task-detail-current-step"')
  })

  it('does NOT render Plan or Spec builder sections regardless of task data', () => {
    // Plan/Spec builder breakdown is fully removed; neither the Plan header
    // nor the task-detail-spec testid should appear even when the task carries
    // both plan and spec data.
    const t = fullTask({
      id: 'task-with-plan-spec',
      status: 'queued',
      plan: { functional: 'fn plan', technical: 'tech plan' },
      spec: {
        files: ['src/x.ts'],
        readFirst: [],
        prescriptiveAction: null,
        verifyCmd: null,
        doneCriteria: [],
        mergeMode: 'auto',
      },
    })
    const html = renderBody(t)
    expect(html).not.toContain('>Plan<')
    expect(html).not.toContain('data-testid="task-detail-spec"')
  })
})

// ── Long-prompt collapse ───────────────────────────────────────────────────────

/**
 * Prompts longer than 20 lines are collapsed behind a <details> disclosure
 * with a summary reading "Prompt · N lines".  Short prompts (≤ 20 lines)
 * render inline as before — no <details> wrapper.
 *
 * The full prompt text is always present in the static HTML; the collapse
 * is purely interactive (the browser hides it until the user opens the
 * <details> element).
 */
describe('TaskDetailBody – long prompt collapse', () => {
  // 21-line prompt — one line over the threshold.
  const LONG_PROMPT = Array.from({ length: 21 }, (_, i) => `Line ${i + 1}`).join('\n')
  // 20-line prompt — exactly at (but not over) the threshold.
  const BOUNDARY_PROMPT = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n')

  it('collapses a prompt with more than 20 lines behind a <details> element', () => {
    const t = fullTask({ id: 'task-long', prompt: LONG_PROMPT })
    const html = renderBody(t)
    expect(html).toContain('<details')
  })

  it('summary reads "Prompt · N lines" for a long prompt', () => {
    const t = fullTask({ id: 'task-long', prompt: LONG_PROMPT })
    const html = renderBody(t)
    expect(html).toContain('Prompt · 21 lines')
  })

  it('full prompt text is still present in the HTML (collapse is interactive-only)', () => {
    const t = fullTask({ id: 'task-long', prompt: LONG_PROMPT })
    const html = renderBody(t)
    expect(html).toContain('Line 21')
  })

  it('a prompt with exactly 20 lines does not collapse (no "Prompt · N lines" summary)', () => {
    const t = fullTask({ id: 'task-boundary', status: 'queued', prompt: BOUNDARY_PROMPT })
    const html = renderBody(t)
    // The collapse summary must NOT appear — 20 lines is at (not over) the threshold.
    expect(html).not.toContain('Prompt ·')
  })

  it('a prompt at the boundary (20 lines) renders with the standard Prompt label', () => {
    const t = fullTask({ id: 'task-boundary', status: 'queued', prompt: BOUNDARY_PROMPT })
    const html = renderBody(t)
    expect(html).toContain('>Prompt<')
  })
})

// ── Drill-in: pure trail helpers ──────────────────────────────────────────────

/**
 * The trail-mutation logic is extracted as the pure `applyNavigate` helper so
 * its truncate-or-push semantics can be exercised without a renderer. Clicking
 * a node already in the trail walks back up (truncate); clicking a fresh node
 * drills in (push). The last element is always the now-current task.
 */
describe('applyNavigate – truncate-or-push trail semantics', () => {
  it('pushes an id that is not yet in the trail (drill-in)', () => {
    expect(applyNavigate(['a'], 'b')).toEqual(['a', 'b'])
    expect(applyNavigate(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })

  it('truncates to an id already in the trail (crumb / ancestor click)', () => {
    expect(applyNavigate(['a', 'b', 'c'], 'b')).toEqual(['a', 'b'])
    expect(applyNavigate(['a', 'b', 'c'], 'a')).toEqual(['a'])
  })

  it('re-clicking the current (last) id is a no-op-shaped truncation to itself', () => {
    expect(applyNavigate(['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input trail', () => {
    const input = ['a', 'b', 'c']
    applyNavigate(input, 'b')
    applyNavigate(input, 'd')
    expect(input).toEqual(['a', 'b', 'c'])
  })
})

describe('crumbLabel – compact id form', () => {
  it('strips a leading mars- prefix', () => {
    expect(crumbLabel('mars-12939470')).toBe('12939470')
  })

  it('falls back to the last 8 chars for long non-prefixed ids', () => {
    expect(crumbLabel('abcdefghijklmnop')).toBe('ijklmnop')
  })

  it('returns short ids unchanged', () => {
    expect(crumbLabel('t-b34')).toBe('t-b34')
  })
})

// ── Drill-in: breadcrumb rendering ────────────────────────────────────────────

/**
 * The breadcrumb lives in drawer state (the trail). A fresh single-task open
 * has a one-element trail and renders no breadcrumb; a multi-hop trail (seeded
 * here via the test-only `initialTrail` prop) renders one crumb per id with a
 * `▸` separator, earlier crumbs as buttons and the last as the styled current.
 */
describe('TaskDetailDrawer – drill-in breadcrumb', () => {
  it('renders NO breadcrumb for a freshly-opened single task (trail length 1)', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="task-detail-breadcrumb"')
  })

  it('renders NO breadcrumb when initialTrail is a single element', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="solo"
        onClose={() => {}}
        initialTrail={['solo']}
      />,
    )
    expect(html).not.toContain('data-testid="task-detail-breadcrumb"')
  })

  it('renders the breadcrumb container with one crumb per trail id', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="c"
        onClose={() => {}}
        initialTrail={['a', 'b', 'c']}
      />,
    )
    expect(html).toContain('data-testid="task-detail-breadcrumb"')
    expect((html.match(/data-crumb-id=/g) ?? []).length).toBe(3)
    expect(html).toContain('data-crumb-id="a"')
    expect(html).toContain('data-crumb-id="b"')
    expect(html).toContain('data-crumb-id="c"')
  })

  it('separates crumbs with the ▸ glyph', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="c"
        onClose={() => {}}
        initialTrail={['a', 'b', 'c']}
      />,
    )
    // Two separators for a three-crumb trail.
    expect((html.match(/▸/g) ?? []).length).toBe(2)
  })

  it('renders earlier crumbs as buttons and the current crumb as non-button', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="c"
        onClose={() => {}}
        initialTrail={['a', 'b', 'c']}
      />,
    )
    // Earlier crumbs are <button data-crumb-id=...>.
    expect(html).toMatch(/<button[^>]*data-crumb-id="a"/)
    expect(html).toMatch(/<button[^>]*data-crumb-id="b"/)
    // The current crumb is a <span>, not a button.
    expect(html).not.toMatch(/<button[^>]*data-crumb-id="c"/)
    expect(html).toMatch(/<span[^>]*data-crumb-id="c"[^>]*class="[^"]*font-medium/)
  })

  it('shows the current (last) trail id in the header, not the original prop', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="c"
        onClose={() => {}}
        initialTrail={['a', 'b', 'c']}
      />,
    )
    expect(html).toContain('Task c')
  })
})

// ── Drill-in: OriginTree wiring ───────────────────────────────────────────────

/**
 * `TaskDetailBody` threads its `onNavigate`/`currentId` into the `OriginTree`.
 * With a multi-node origins tree, `onNavigate` turns each node row into a
 * `<button>` (the OriginTree contract), so we can assert the wiring
 * structurally without a live DOM. `currentId` selects which row is bolded.
 */
describe('TaskDetailBody – OriginTree drill-in wiring', () => {
  const TREE_ORIGINS = (focusId: string): OriginsResponse => ({
    node: {
      id: 'prop-x',
      kind: 'proposal',
      title: 'parent proposal',
      status: 'prd-ready',
      children: [
        { id: focusId, kind: 'task', title: 'the task', status: 'running', children: [] },
      ],
    },
  })

  it('passes onNavigate so origin rows render as buttons', () => {
    const t = fullTask({ id: 'focus' })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    // null is the projectId slot — defaults to null outside FocusedProjectProvider
    qc.setQueryData(['origins', null, 'focus'], TREE_ORIGINS('focus'))
    const html = renderDrawer(
      <QueryClientProvider client={qc}>
        <TaskDetailBody task={t} onNavigate={() => {}} currentId="focus" />
      </QueryClientProvider>,
    )
    expect(html).toContain('data-origin-node-id="prop-x"')
    // The origin-row <li> for prop-x must have a <button> as its immediate child
    // (the full row is clickable when onNavigate is wired up).
    expect(html).toMatch(/data-origin-node-id="prop-x"[^>]*><button/)
  })

  it('renders origin rows as plain cells (no buttons) when onNavigate is omitted', () => {
    const t = fullTask({ id: 'focus' })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    // null is the projectId slot — defaults to null outside FocusedProjectProvider
    qc.setQueryData(['origins', null, 'focus'], TREE_ORIGINS('focus'))
    const html = renderDrawer(
      <QueryClientProvider client={qc}>
        <TaskDetailBody task={t} />
      </QueryClientProvider>,
    )
    expect(html).toContain('data-origin-node-id="prop-x"')
    // No origin-row button is the immediate child of the <li> when display-only.
    // (The precise pattern avoids false positives from other buttons in the drawer.)
    expect(html).not.toMatch(/data-origin-node-id="prop-x"[^>]*><button/)
  })
})

// ── Step timeline ─────────────────────────────────────────────────────────────

/**
 * The step timeline renders inside TaskDetailDrawer when `stepSpans` is passed
 * as a prop. Each span row shows the step name, outcome, and timing. Running
 * steps are highlighted with a distinct 'currently executing' indicator.
 *
 * In production the drawer fetches spans from /api/step-spans; the prop path
 * exists so tests can verify rendering without a live server.
 */

const span = (overrides: Partial<StepSpan> & { stepName: string }): StepSpan => ({
  stepName: overrides.stepName,
  phase: overrides.phase ?? null,
  workflowInstanceId: overrides.workflowInstanceId ?? 'wf-test',
  workerName: overrides.workerName ?? null,
  outcome: overrides.outcome ?? 'completed',
  startedAt: overrides.startedAt ?? '2026-01-01T10:00:00.000Z',
  endedAt: overrides.endedAt ?? '2026-01-01T10:00:01.000Z',
  durationMs: overrides.durationMs ?? 1000,
  taskId: overrides.taskId ?? 'task-t1',
  originId: overrides.originId ?? 'task-t1',
  evalResults: overrides.evalResults,
})

describe('TaskDetailDrawer – step timeline (via stepSpans prop)', () => {
  it('renders a step card list section when stepSpans prop is provided', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[]} />,
    )
    expect(html).toContain('data-testid="step-card-list"')
  })

  it('does not render the step card list section when stepSpans prop is omitted', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="step-card-list"')
  })

  it('renders one card per step span', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1', workerName: 'Coder' }),
      span({ stepName: 'verify', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'merge', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(4)
  })

  it('shows setup, code, verify, merge step names in the rendered rows', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1', workerName: 'Coder' }),
      span({ stepName: 'verify', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'merge', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('setup')
    expect(html).toContain('code')
    expect(html).toContain('verify')
    expect(html).toContain('merge')
  })

  it('marks a running step with data-outcome="running" for distinct highlighting', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'running', endedAt: null, durationMs: null }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-outcome="running"')
  })

  it('marks a completed step with data-outcome="completed"', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1', outcome: 'completed' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-outcome="completed"')
  })

  it('marks a failed step with data-outcome="failed"', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'failed' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-outcome="failed"')
  })

  it('renders each recover step as its own distinct card (not collapsed with code)', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'failed', workerName: 'Coder' }),
      span({ stepName: 'recover', workflowInstanceId: 'wf-2', outcome: 'completed', workerName: 'Fixer' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(2)
    // Both step names appear in the output
    expect(html).toContain('code')
    expect(html).toContain('recover')
  })

  it('shows an empty-state message when stepSpans is an empty array', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[]} />,
    )
    // Empty state is present and no cards are rendered
    expect(html).toContain('data-testid="step-card-list"')
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(0)
  })

  it('sets data-active=true on the row whose stepName matches activeStepName', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'verify', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        activeStepName="code"
      />,
    )
    // The 'code' row is highlighted; others are not.
    expect(html).toContain('data-active="true"')
    // Verify the highlight ring uses the accessible warn token (not raw amber).
    expect(html).toContain('ring-warn')
    // The other rows must not be highlighted.
    const activeMatches = (html.match(/data-active="true"/g) ?? []).length
    expect(activeMatches).toBe(1)
  })

  it('sets data-active=false on all rows when activeStepName does not match any span', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        activeStepName="merge"
      />,
    )
    expect(html).not.toContain('data-active="true"')
    expect(html).not.toContain('ring-warn')
  })

  it('does not add data-active=true when activeStepName is omitted', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    // No highlight when no active step is provided
    expect(html).not.toContain('data-active="true"')
  })

  // ── Accessibility / color-token tests ────────────────────────────────────────

  it('a failed step row uses the accessible error token (text-error), not raw red/amber scale classes', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'failed' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).not.toContain('text-red-400')
    expect(html).not.toMatch(/text-(?:amber)-\d+/)
    expect(html).toContain('text-error')
  })

  it('a warn-state EvalChip renders with text-warn, not a raw amber scale class', () => {
    const spans = [
      span({
        stepName: 'code',
        workflowInstanceId: 'wf-1',
        outcome: 'completed',
        evalResults: [{ label: 'ctx%', value: '95%', warn: true }],
      }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).not.toMatch(/text-(?:amber)-\d+/)
    expect(html).toContain('text-warn')
  })

  it('renders a status icon (data-testid="step-status-icon") for every step card', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1', workerName: 'Coder' }),
      span({ stepName: 'merge', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    const iconCount = (html.match(/data-testid="step-status-icon"/g) ?? []).length
    expect(iconCount).toBe(3)
  })

  it('a running step gets a warn-colored status icon', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'running', endedAt: null, durationMs: null }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-testid="step-status-icon"')
    // The icon element for a running step uses the warn color tokens.
    expect(html).toContain('border-warn')
    expect(html).toContain('bg-warn')
  })
})

// ── Tool invocations in step cards ───────────────────────────────────────────

/**
 * When toolInvocations prop is provided, each step card's expanded section
 * groups the matching tool events and renders the full humanized command line
 * (basename + argv). The expanded content is always in the static HTML because
 * the card uses a <details> element — keyboard-accessible and always parseable
 * by renderToStaticMarkup.
 */
describe('TaskDetailDrawer – tool invocations in step cards', () => {
  const makeToolEvent = (overrides: Partial<TraceEvent> & { id: string }): TraceEvent => ({
    id: overrides.id,
    timestamp: overrides.timestamp ?? 1_767_261_600_500,
    kind: 'tool_invoked',
    severity: 'info',
    taskId: overrides.taskId ?? 'task-t1',
    originId: overrides.originId ?? 'task-t1',
    phase: overrides.phase ?? null,
    payload: overrides.payload ?? {
      tool: 'git',
      argv: [],
      exitCode: 0,
      durationMs: 10,
      stdout: '',
      stderr: '',
      expectsFailure: false,
    },
  })

  it('tool invocations with full argv appear inside step card expanded content', () => {
    const spans = [
      span({
        stepName: 'code',
        workflowInstanceId: 'wf-1',
        outcome: 'completed',
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: '2026-01-01T10:00:01.000Z',
      }),
    ]
    const toolInvocations: TraceEvent[] = [
      makeToolEvent({
        id: 'ev-1',
        timestamp: 1_767_261_600_500,
        payload: {
          tool: '/usr/local/bin/git',
          argv: ['commit', '-m', 'add feature'],
          exitCode: 0,
          durationMs: 123,
          stdout: '',
          stderr: '',
          expectsFailure: false,
        },
      }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        toolInvocations={toolInvocations}
      />,
    )
    // tool-cmd is inside step-card-expanded which is always in static DOM
    expect(html).toContain('data-testid="tool-cmd"')
    // Humanized command: basename of path + argv joined
    expect(html).toContain('git commit -m add feature')
  })

  it('spans render as cards with status icon (not flat rows)', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1', outcome: 'completed' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'running', endedAt: null, durationMs: null }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    // Cards rendered, not flat rows
    const cardCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(cardCount).toBe(2)
    // Each card has a status icon
    const iconCount = (html.match(/data-testid="step-status-icon"/g) ?? []).length
    expect(iconCount).toBe(2)
    // Expanded content always in DOM
    expect(html).toContain('data-testid="step-card-expanded"')
  })

  it('exit-code badge shows ✓ for exit code 0', () => {
    const spans = [
      span({
        stepName: 'verify',
        workflowInstanceId: 'wf-1',
        outcome: 'completed',
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: '2026-01-01T10:00:01.000Z',
      }),
    ]
    const toolInvocations: TraceEvent[] = [
      makeToolEvent({
        id: 'ev-2',
        timestamp: 1_767_261_600_500,
        payload: {
          tool: 'npm',
          argv: ['test'],
          exitCode: 0,
          durationMs: 500,
          stdout: '',
          stderr: '',
          expectsFailure: false,
        },
      }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        toolInvocations={toolInvocations}
      />,
    )
    expect(html).toContain('data-testid="exit-code-badge"')
    expect(html).toContain('✓')
  })
})

// ── Failure banner humanization ───────────────────────────────────────────────

/**
 * The failure banner must lead with the humanized cause phrase produced by
 * humanizeFailureCode (the same helper the Action Queue uses), not raw machine
 * signatures.  The raw signature is still present but demoted so Action Queue
 * and drawer can never drift.
 */
describe('TaskDetailBody – failure banner humanization', () => {
  const failedWithSig = fullTask({
    id: 'task-sig',
    status: 'failed',
    failureSignature: 'verify:has-diff',
    error: 'worktree /tmp/mars-abc no longer exists',
  })

  it('banner leads with the humanized cause, not the raw signature', () => {
    const html = renderBody(failedWithSig)
    // Humanized form must be present
    expect(html).toContain('has-diff (verify step)')
    // Raw uppercase badge must NOT be the headline (it's demoted inside <details>)
    // We confirm the testid for the humanized cause exists
    expect(html).toContain('data-testid="task-detail-failure-cause"')
  })

  it('raw signature still appears in the technical-details section', () => {
    const html = renderBody(failedWithSig)
    // The machine signature should still be in the DOM (demoted)
    expect(html).toContain('verify:has-diff')
    // The raw error should still be accessible inside <details>
    expect(html).toContain('worktree /tmp/mars-abc no longer exists')
  })

  it('humanizes daemon-killed to a readable phrase', () => {
    const t = fullTask({ id: 'task-dk', status: 'failed', failureSignature: 'daemon-killed' })
    const html = renderBody(t)
    expect(html).toContain('daemon killed')
  })

  it('humanizes code:over-budget to a readable phrase', () => {
    const t = fullTask({ id: 'task-ob', status: 'failed', failureSignature: 'code:over-budget' })
    const html = renderBody(t)
    expect(html).toContain('over-budget (code step)')
  })

  it('shows no humanized-cause line when failureSignature is null', () => {
    const t = fullTask({ id: 'task-noSig', status: 'failed', error: 'raw error only' })
    const html = renderBody(t)
    expect(html).not.toContain('data-testid="task-detail-failure-cause"')
    // Raw error still surfaces in the technical-details section
    expect(html).toContain('raw error only')
  })
})

// ── EvalChip accessibility ────────────────────────────────────────────────────

/**
 * EvalChip metrics that explain WHY a run failed should carry accessible
 * title/aria-label attributes so screen-reader users and hovering operators
 * can understand what each metric measures — especially ctx%, which directly
 * indicates a context-budget overrun when its value exceeds 100%.
 */
describe('TaskDetailDrawer – EvalChip accessibility', () => {
  const spanWithCtx = span({
    stepName: 'run-claude-code',
    workflowInstanceId: 'wf-1',
    outcome: 'failed',
    evalResults: [
      { label: 'ctx%', value: '206.4%', warn: true },
      { label: 'out/in', value: '30.37', warn: false },
      { label: 'msgs', value: 27, warn: false },
    ],
  })

  it('ctx% chip carries a title explaining the context-window metric', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[spanWithCtx]} />,
    )
    expect(html).toContain('Context window used')
    expect(html).toContain('above 100% means the run overran')
  })

  it('ctx% chip carries an aria-label including its value and description', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[spanWithCtx]} />,
    )
    expect(html).toContain('aria-label="ctx% 206.4%:')
  })

  it('out/in chip carries a title explaining the token-ratio metric', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[spanWithCtx]} />,
    )
    expect(html).toContain('Output-to-input token ratio')
  })

  it('msgs chip carries a title explaining the message-count metric', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[spanWithCtx]} />,
    )
    expect(html).toContain('Number of messages in the conversation')
  })

  it('an unknown metric label does not crash and renders without aria-label', () => {
    const s = span({
      stepName: 'code',
      workflowInstanceId: 'wf-1',
      evalResults: [{ label: 'unknown-metric', value: '42', warn: false }],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[s]} />,
    )
    expect(html).toContain('unknown-metric')
    // No aria-label injected for unlisted metrics
    expect(html).not.toContain('aria-label="unknown-metric')
  })
})

// ── Run timeline ──────────────────────────────────────────────────────────────

/**
 * The run timeline renders inside TaskDetailDrawer when `runTimeline` is passed
 * as a prop. Shows all workflow runs for the task with per-step status,
 * durations, token counts, and failure reasons.
 *
 * In production the drawer fetches from /api/runs/:taskId; the prop path
 * exists so tests can verify rendering without a live server.
 */

const makeRTStep = (
  overrides: Partial<RunTimelineStep> & { stepName: string },
): RunTimelineStep => ({
  stepName: overrides.stepName,
  phase: null,
  workerName: null,
  status: 'completed',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: '2026-01-01T10:00:01.000Z',
  durationMs: 1000,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  claudeSessionId: null,
  failureReason: null,
  resultJson: null,
  ...overrides,
})

const makeRTRun = (overrides?: Partial<RunTimelineEntry>): RunTimelineEntry => ({
  runId: 'wf-run-001',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: '2026-01-01T10:00:30.000Z',
  steps: [],
  ...overrides,
})

const makeRunTimeline = (overrides?: Partial<RunTimeline>): RunTimeline => ({
  taskId: 'task-t1',
  runs: [],
  ...overrides,
})

describe('TaskDetailDrawer – run timeline (via runTimeline prop)', () => {
  it('renders the step-card-list section when runTimeline has at least one run', () => {
    const timeline = makeRunTimeline({
      runs: [makeRTRun({ steps: [makeRTStep({ stepName: 'setup' })] })],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-testid="step-card-list"')
  })

  it('does not render the step-card-list section when runTimeline prop is omitted', () => {
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="step-card-list"')
  })

  it('quiet empty state: renders nothing when runs array is empty', () => {
    const timeline = makeRunTimeline({ runs: [] })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).not.toContain('data-testid="step-card-list"')
  })

  it('renders all steps from all runs as cards (flat list, no run grouping)', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({ runId: 'wf-1', steps: [makeRTStep({ stepName: 'setup' })] }),
        makeRTRun({ runId: 'wf-2', steps: [makeRTStep({ stepName: 'code' })] }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // Both steps appear as cards; no run-entry grouping
    const cardCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(cardCount).toBe(2)
    expect(html).not.toContain('data-testid="run-entry"')
  })

  it('renders one step card per step', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'setup' }),
            makeRTStep({ stepName: 'run-claude-code' }),
            makeRTStep({ stepName: 'verify' }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(3)
  })

  it('shows step names in the rendered rows', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'setup' }),
            makeRTStep({ stepName: 'run-claude-code' }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('setup')
    expect(html).toContain('run-claude-code')
  })

  it('shows per-step token counts when present', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'run-claude-code',
              inputTokens: 1234,
              outputTokens: 567,
              cacheReadTokens: 890,
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('in:1234')
    expect(html).toContain('out:567')
    expect(html).toContain('cache:890')
  })

  it('does not show token span when both inputTokens and outputTokens are null', () => {
    const timeline = makeRunTimeline({
      runs: [makeRTRun({ steps: [makeRTStep({ stepName: 'setup' })] })],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).not.toContain('in:')
    expect(html).not.toContain('out:')
  })

  it('shows failure reason inline for a failed step', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'run-claude-code',
              status: 'failed',
              failureReason: 'context window exceeded',
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('context window exceeded')
    expect(html).toContain('data-outcome="failed"')
  })

  it('marks a running step with data-outcome="running"', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          endedAt: null,
          steps: [
            makeRTStep({
              stepName: 'run-claude-code',
              status: 'running',
              endedAt: null,
              durationMs: null,
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-outcome="running"')
  })

  it('uses semantic color tokens, not raw palette colors', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'a', status: 'failed' }),
            makeRTStep({ stepName: 'b', status: 'running', endedAt: null, durationMs: null }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).not.toContain('text-red-400')
    expect(html).not.toMatch(/text-(?:amber)-\d+/)
    expect(html).toContain('text-error') // failed step status icon uses text-error
    expect(html).toContain('border-warn') // running step card/icon uses border-warn
  })

  it('each step card is a <details> element for keyboard-accessible expand/collapse', () => {
    const steps = Array.from({ length: 3 }, (_, i) =>
      makeRTStep({ stepName: `step-${i}` }),
    )
    const timeline = makeRunTimeline({ runs: [makeRTRun({ steps })] })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // Each step card is a <details> element.
    const cardCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(cardCount).toBe(3)
    // Expanded content (step-card-expanded) is always in DOM for static tests.
    const expandedCount = (html.match(/data-testid="step-card-expanded"/g) ?? []).length
    expect(expandedCount).toBe(3)
  })

  it('expanded card content is always in DOM (accessible before interaction)', () => {
    const timeline = makeRunTimeline({
      runs: [makeRTRun({ steps: [makeRTStep({ stepName: 'setup' })] })],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // step-card-expanded is always present even when the card starts collapsed
    expect(html).toContain('data-testid="step-card-expanded"')
  })
})

// ── Merged timeline: no duplicate step lists ──────────────────────────────────

/**
 * When run data is available (the overwhelming case for completed tasks), the
 * drawer must render ONLY the run timeline — not both the step timeline and the
 * run timeline — to avoid showing the same step list twice in the same viewport.
 *
 * Eval chips (from StepSpan.evalResults) must be preserved by folding them into
 * the run step rows that share the same workflowInstanceId / stepName.
 */
describe('TaskDetailDrawer – merged timeline (no duplicate step lists)', () => {
  it('renders only one step-card-list when run data is available (no duplicate step list)', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-run-001' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-run-001', workerName: 'Coder' }),
    ]
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          runId: 'wf-run-001',
          steps: [
            makeRTStep({ stepName: 'setup' }),
            makeRTStep({ stepName: 'code' }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        runTimeline={timeline}
      />,
    )
    // Exactly one step-card-list — run data wins, no duplicated span list
    expect(html).toContain('data-testid="step-card-list"')
    const listCount = (html.match(/data-testid="step-card-list"/g) ?? []).length
    expect(listCount).toBe(1)
  })

  it('still renders step-card-list when no run data is available (spans fallback)', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
      />,
    )
    // No run data → span-based step cards are the fallback
    expect(html).toContain('data-testid="step-card-list"')
  })

  it('folds eval chips from spans into step cards when spans carry evalResults', () => {
    const spans = [
      span({
        stepName: 'code',
        workflowInstanceId: 'wf-run-001',
        evalResults: [{ label: 'ctx%', value: '95%', warn: true }],
      }),
    ]
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          runId: 'wf-run-001',
          steps: [makeRTStep({ stepName: 'code' })],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        runTimeline={timeline}
      />,
    )
    // Eval chip must appear in the single step-card-list
    expect(html).toContain('ctx% 95%')
    expect(html).toContain('data-testid="step-card-list"')
  })
})

// ── Step card Input/Output panels (result_json) ────────────────────────────────

/**
 * The expanded card shows an "Output" section when the step's result_json is
 * present. The content is always in the static DOM (collapsed by default via
 * <details>/<summary>) so renderToStaticMarkup can assert on it without
 * needing a live DOM.
 *
 * The `resultJson` field is passed through the RunTimeline → StepCardEntry
 * normalisation chain and rendered as pretty-printed JSON.
 */
describe('TaskDetailDrawer – step card Output panel (result_json)', () => {
  it('shows the Output section when a run step has resultJson', () => {
    const resultData = { outcome: 'completed', exitCode: 0 }
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'code',
              resultJson: JSON.stringify(resultData),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-testid="step-result-output"')
  })

  it('pretty-prints the resultJson so keys are visible', () => {
    const resultData = { outcome: 'completed', exitCode: 0 }
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'code',
              resultJson: JSON.stringify(resultData),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // Pretty-printed JSON — in renderToStaticMarkup, double-quotes in text
    // content are HTML-encoded as &quot; (React's static renderer escapes them).
    expect(html).toContain('&quot;outcome&quot;')
    expect(html).toContain('&quot;completed&quot;')
    expect(html).toContain('&quot;exitCode&quot;')
  })

  it('Output section is always in the DOM (collapsed <details> — accessible before interaction)', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'verify',
              resultJson: JSON.stringify({ pass: true }),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // step-result-output is always present in static HTML — the browser hides
    // it until the operator opens the <details> element.
    expect(html).toContain('data-testid="step-result-output"')
    // The parent <details> is collapsed by default (no `open` attribute).
    expect(html).not.toContain('open=""')
  })

  it('does not render the Output section when resultJson is null', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [makeRTStep({ stepName: 'setup' })],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).not.toContain('data-testid="step-result-output"')
  })

  it('Output section is keyboard-accessible via <details>/<summary>', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'merge',
              resultJson: JSON.stringify({ merged: true }),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // The summary element is present and the output block is its sibling
    expect(html).toContain('>Output<')
    expect(html).toContain('data-testid="step-result-output"')
  })

  it('falls back to showing resultJson as-is when it is not valid JSON', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'setup',
              resultJson: 'not-valid-json',
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-testid="step-result-output"')
    expect(html).toContain('not-valid-json')
  })
})

// ── Step card Input panel (input_json) ────────────────────────────────────────

/**
 * The expanded card shows an "Input" section when the step's inputJson is
 * present. Mirrors the Output panel — collapsed by default, always in static
 * DOM, scrollable on large payloads.
 */
describe('TaskDetailDrawer – step card Input panel (input_json)', () => {
  it('shows the Input section when a run step has inputJson', () => {
    const inputData = { prompt: 'do the thing', taskId: 'mars-abc' }
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'code',
              inputJson: JSON.stringify(inputData),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-testid="step-result-input"')
  })

  it('pretty-prints the inputJson so keys are visible', () => {
    const inputData = { prompt: 'do the thing', taskId: 'mars-abc' }
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'code',
              inputJson: JSON.stringify(inputData),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('&quot;prompt&quot;')
    expect(html).toContain('&quot;do the thing&quot;')
    expect(html).toContain('&quot;taskId&quot;')
  })

  it('Input section is always in the DOM (collapsed <details> — accessible before interaction)', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'verify',
              inputJson: JSON.stringify({ check: true }),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-testid="step-result-input"')
    expect(html).not.toContain('open=""')
  })

  it('does not render the Input section when inputJson is null', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [makeRTStep({ stepName: 'setup' })],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).not.toContain('data-testid="step-result-input"')
  })

  it('Input section is keyboard-accessible via <details>/<summary>', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'merge',
              inputJson: JSON.stringify({ merged: true }),
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('>Input<')
    expect(html).toContain('data-testid="step-result-input"')
  })

  it('falls back to showing inputJson as-is when it is not valid JSON', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({
              stepName: 'setup',
              inputJson: 'not-valid-json',
            }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).toContain('data-testid="step-result-input"')
    expect(html).toContain('not-valid-json')
  })
})

// ── Negative durationMs (killed steps) ───────────────────────────────────────

/**
 * A step that is killed mid-run can carry a negative durationMs (e.g. -1).
 * formatDuration must treat any negative value as "unknown duration" and render
 * an em-dash placeholder "—" rather than the raw negative number "-1ms".
 */
describe('TaskDetailDrawer – negative durationMs renders em-dash, not negative duration', () => {
  it('renders "—" for a killed run step with durationMs of -1', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', durationMs: -1 }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    // Negative duration is unknown — render an em-dash placeholder.
    expect(html).toContain('—')
    expect(html).not.toContain('-1ms')
  })

  it('does not render a negative duration for any negative durationMs value', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', durationMs: -999 }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} runTimeline={timeline} />,
    )
    expect(html).not.toContain('-999ms')
    expect(html).toContain('—')
  })
})

// ── LoadState: loading and error branches ─────────────────────────────────────

describe('TaskDetailDrawer – load state branches', () => {
  it('renders skeleton rows while loading (initial state)', () => {
    // With no task data seeded in the cache the useQuery stays pending under
    // static rendering, so the drawer shows its loading skeleton. renderDrawer
    // supplies the QueryClientProvider the drawer's useQuery now requires.
    const html = renderDrawer(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-loading"')
    // The body and error panels must be absent in loading state.
    expect(html).not.toContain('data-testid="task-detail-body"')
    expect(html).not.toContain('data-testid="task-detail-error"')
  })

  it('renders a FallbackSurface error panel on fetch error', () => {
    // Uses the test-only initialState seam to exercise the error branch
    // synchronously (renderToStaticMarkup does not run effects, so the query
    // never resolves to an error on its own).
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="mars-abc123"
        onClose={() => {}}
        initialState={{ kind: 'error', message: 'HTTP 503' }}
      />,
    )
    expect(html).toContain('data-testid="task-detail-error"')
    // FallbackSurface pane variant renders with data-testid="api-error-panel"
    expect(html).toContain('data-testid="api-error-panel"')
    // Error body and skeleton must be absent.
    expect(html).not.toContain('data-testid="task-detail-body"')
    expect(html).not.toContain('data-testid="task-detail-loading"')
  })

  it('error panel carries a role=alert for screen readers', () => {
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="mars-abc123"
        onClose={() => {}}
        initialState={{ kind: 'error', message: 'request failed' }}
      />,
    )
    expect(html).toContain('role="alert"')
  })
})

// ── SSE live-update integration ───────────────────────────────────────────────

/**
 * SseInvalidator calls `qc.invalidateQueries({ queryKey: ['task', openId] })`.
 * For that to reach the drawer the drawer must fetch via React Query with the
 * same key.  These tests verify the contract: pre-seeding the cache with
 * `['task', id]` makes the ready body visible without any fetch, which means
 * any subsequent invalidation of that same key triggers a refetch and updates
 * the UI in place.
 */
describe('TaskDetailDrawer – SSE live-update via React Query', () => {
  it('resolves task data from the React Query cache keyed [task, id] so SSE invalidations update the drawer', () => {
    const taskData = fullTask({ id: 'sse-task', status: 'running' })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    // Pre-seed the ['task', id] query as if a prior fetch already ran.
    qc.setQueryData(['task', 'sse-task'], { kind: 'found', task: taskData })
    // OriginTree inside TaskDetailBody also needs its query seeded.
    qc.setQueryData(['origins', null, 'sse-task'], SINGLE_NODE_ORIGINS('sse-task'))
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <TaskDetailDrawer taskId="sse-task" onClose={() => {}} />
      </QueryClientProvider>,
    )
    // The ready body is visible: the drawer read the task from the shared cache
    // rather than showing the loading skeleton.  An SSE event that calls
    // qc.invalidateQueries({ queryKey: ['task', 'sse-task'] }) will cause the
    // same useQuery to refetch, updating status/sections in place.
    expect(html).toContain('data-testid="task-detail-body"')
    expect(html).not.toContain('data-state="loading"')
  })

  it('shows the not-found panel when the cache contains a not-found result', () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    qc.setQueryData(['task', 'gone-task'], { kind: 'not-found' })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <TaskDetailDrawer
          taskId="gone-task"
          onClose={() => {}}
          tasks={[task({ id: 'gone-task', cluster: 'Failed' })]}
          proposals={[]}
        />
      </QueryClientProvider>,
    )
    expect(html).toContain('data-testid="task-detail-not-found"')
    expect(html).not.toContain('data-testid="task-detail-subgraph"')
    expect(html).not.toContain('data-testid="step-card-list"')
  })
})

// ── Agent tool calls in step cards ──────────────────────────────────────────

/**
 * Agent (Claude Code) tool calls are surfaced inside the step card of the
 * LLM-backed run step that has the matching claudeSessionId.
 *
 * When `agentToolCallsBySession` is provided (keyed by claudeSessionId), the
 * matching step card renders one AgentToolCallRow per call instead of showing
 * nothing. When the session has no calls the existing silent empty state is
 * preserved — no "No tool invocations recorded" message.
 *
 * The `agentToolCallsBySession` prop skips the live fetch so tests run
 * synchronously under renderToStaticMarkup.
 */
describe('TaskDetailDrawer – agent tool calls in step cards', () => {
  const SESSION_ID = 'session-abc12345'

  const makeAgentCall = (
    overrides: Partial<import('@/shared/schemas').AgentToolCall> & { toolUseId: string },
  ): import('@/shared/schemas').AgentToolCall => ({
    toolUseId: overrides.toolUseId,
    toolName: overrides.toolName ?? 'Read',
    input: overrides.input ?? { file_path: '/src/foo.ts' },
    resultContent: overrides.resultContent ?? 'file contents',
    isError: overrides.isError ?? false,
  })

  it('renders agent tool rows when the step has a claudeSessionId and agent tool calls are provided', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', claudeSessionId: SESSION_ID }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        runTimeline={timeline}
        agentToolCallsBySession={{
          [SESSION_ID]: [makeAgentCall({ toolUseId: 'tu-1', toolName: 'Read' })],
        }}
      />,
    )
    expect(html).toContain('data-testid="agent-tool-row"')
    expect(html).toContain('data-testid="agent-tool-name"')
    expect(html).toContain('Read')
  })

  it('renders multiple agent tool rows when the session has multiple calls', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', claudeSessionId: SESSION_ID }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        runTimeline={timeline}
        agentToolCallsBySession={{
          [SESSION_ID]: [
            makeAgentCall({ toolUseId: 'tu-1', toolName: 'Read' }),
            makeAgentCall({ toolUseId: 'tu-2', toolName: 'Edit' }),
            makeAgentCall({ toolUseId: 'tu-3', toolName: 'Bash' }),
          ],
        }}
      />,
    )
    const rowCount = (html.match(/data-testid="agent-tool-row"/g) ?? []).length
    expect(rowCount).toBe(3)
  })

  it('marks an errored agent tool call with isError=true styling (error badge)', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', claudeSessionId: SESSION_ID }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        runTimeline={timeline}
        agentToolCallsBySession={{
          [SESSION_ID]: [
            makeAgentCall({ toolUseId: 'tu-err', toolName: 'Bash', isError: true }),
          ],
        }}
      />,
    )
    // Error badge uses text-error tokens
    expect(html).toContain('text-error')
    expect(html).toContain('✗')
  })

  it('renders no agent tool rows and no "No tool invocations recorded" message when claudeSessionId is present but has zero agent calls', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', claudeSessionId: SESSION_ID }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        runTimeline={timeline}
        agentToolCallsBySession={{ [SESSION_ID]: [] }}
      />,
    )
    // No agent tool rows
    expect(html).not.toContain('data-testid="agent-tool-row"')
    // No false claim that nothing was recorded — the session exists; tools are
    // just not loaded yet (or the session had none). The UI stays silent.
    expect(html).not.toContain('No tool invocations recorded')
  })

  it('still shows "No tool invocations recorded" for a step with no claudeSessionId and no tool events', () => {
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            // No claudeSessionId — this is a non-LLM step (e.g. setup / merge)
            makeRTStep({ stepName: 'setup', claudeSessionId: null }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        runTimeline={timeline}
      />,
    )
    expect(html).toContain('No tool invocations recorded')
  })

  it('scopes agent tool calls to the correct step by claudeSessionId', () => {
    const SESSION_A = 'sess-aaa'
    const SESSION_B = 'sess-bbb'
    const timeline = makeRunTimeline({
      runs: [
        makeRTRun({
          steps: [
            makeRTStep({ stepName: 'run-claude-code', claudeSessionId: SESSION_A }),
            makeRTStep({ stepName: 'recover', claudeSessionId: SESSION_B }),
          ],
        }),
      ],
    })
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        runTimeline={timeline}
        agentToolCallsBySession={{
          [SESSION_A]: [makeAgentCall({ toolUseId: 'tu-a', toolName: 'Read' })],
          [SESSION_B]: [makeAgentCall({ toolUseId: 'tu-b', toolName: 'Edit' })],
        }}
      />,
    )
    // Both tool names appear; each is scoped to its respective step card
    expect(html).toContain('Read')
    expect(html).toContain('Edit')
    const rowCount = (html.match(/data-testid="agent-tool-row"/g) ?? []).length
    expect(rowCount).toBe(2)
  })

  it('viewPrimitives observed-shell-tools list is unchanged: only tool_invoked trace events count', () => {
    // Verify that agent tool call rows (data-testid="agent-tool-row") are NOT
    // the same as orchestrator shell tool rows (data-testid="step-tool-row").
    // The two row types have different testids so they can never be confused.
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
    ]
    const toolInvocations: TraceEvent[] = [
      {
        id: 'ev-shell',
        timestamp: 1_767_261_600_500,
        kind: 'tool_invoked',
        severity: 'info',
        taskId: 'task-t1',
        originId: 'task-t1',
        phase: null,
        payload: {
          tool: 'git',
          argv: ['status'],
          exitCode: 0,
          durationMs: 10,
          stdout: '',
          stderr: '',
          expectsFailure: false,
        },
      },
    ]
    const html = renderDrawer(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        stepSpans={spans}
        toolInvocations={toolInvocations}
      />,
    )
    // Shell tool row rendered with the orchestrator's testid
    expect(html).toContain('data-testid="step-tool-row"')
    // No agent tool row — no agent calls provided
    expect(html).not.toContain('data-testid="agent-tool-row"')
  })
})

// ── Slice-3 regression coverage (moved from components) ─────────────────────

const renderSlice3 = (element: React.ReactElement): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{element}</QueryClientProvider>)
}

const slice3Task = (overrides: Partial<ProgressTask> & { id: string; cluster: ProgressTask['cluster'] }): ProgressTask => ({
  id: overrides.id, prompt: overrides.prompt ?? `Task ${overrides.id}`, status: overrides.status ?? 'queued', plan: null, branch: null, worktreePath: null, error: null, dropReason: null, recoverySpawnedCount: 0, blockerTaskId: null, blockedBy: overrides.blockedBy ?? [], spec: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', cluster: overrides.cluster, parentProposalId: overrides.parentProposalId ?? null, ...overrides,
})
const slice3Proposal = (id: string, title = `Goal ${id}`): ProgressProposalNode => ({ id, title, source: 'human', status: 'prd-ready' })
const slice3Span = (overrides: Partial<StepSpan> & { stepName: string }): StepSpan => ({
  stepName: overrides.stepName, phase: null, workflowInstanceId: overrides.workflowInstanceId ?? 'wf-test', workerName: null, outcome: overrides.outcome ?? 'completed', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:00:01.000Z', durationMs: 1000, taskId: overrides.taskId ?? 'task-a', originId: overrides.originId ?? 'task-a', ...overrides,
})

describe('TaskDetailDrawer – task mode (slice-3 regression)', () => {
  it('renders the dialog shell when showing a plain task with sibling tasks present', () => {
    const tasks = [slice3Task({ id: 'slice-1', cluster: 'In progress' }), slice3Task({ id: 'slice-2', cluster: 'Queued' }), slice3Task({ id: 'slice-3', cluster: 'Queued' })]
    const html = renderSlice3(<TaskDetailDrawer taskId="slice-1" onClose={() => {}} tasks={tasks} proposals={[]} />)
    expect(html).toContain('data-testid="task-detail-drawer"')
    expect(html).toContain('slice-1')
  })
  it('step timeline renders its spans when stepSpans prop is provided (task mode)', () => {
    const spans = [slice3Span({ stepName: 'setup', workflowInstanceId: 'wf-1', taskId: 'slice-1' }), slice3Span({ stepName: 'code', workflowInstanceId: 'wf-1', taskId: 'slice-1' }), slice3Span({ stepName: 'verify', workflowInstanceId: 'wf-1', taskId: 'slice-1' }), slice3Span({ stepName: 'merge', workflowInstanceId: 'wf-1', taskId: 'slice-1' })]
    const html = renderSlice3(<TaskDetailDrawer taskId="slice-1" onClose={() => {}} tasks={[slice3Task({ id: 'slice-1', cluster: 'Done' })]} proposals={[]} stepSpans={spans} />)
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(4)
    expect(html).toContain('setup')
    expect(html).toContain('merge')
  })
  it('activeStepName still highlights the matching step in task mode', () => {
    const spans = [slice3Span({ stepName: 'setup', workflowInstanceId: 'wf-1', taskId: 'slice-1' }), slice3Span({ stepName: 'code', workflowInstanceId: 'wf-1', taskId: 'slice-1', outcome: 'running', endedAt: null, durationMs: null })]
    const html = renderSlice3(<TaskDetailDrawer taskId="slice-1" onClose={() => {}} tasks={[slice3Task({ id: 'slice-1', cluster: 'In progress' })]} proposals={[]} stepSpans={spans} activeStepName="code" />)
    const activeMatches = (html.match(/data-active="true"/g) ?? []).length
    expect(activeMatches).toBe(1)
    expect(html).toContain('ring-warn')
  })
  it('sibling spans are absent when step timeline is scoped to one task via stepSpans', () => {
    const spans = [slice3Span({ stepName: 'setup', workflowInstanceId: 'wf-1', taskId: 'slice-1', originId: 'slice-1' }), slice3Span({ stepName: 'code', workflowInstanceId: 'wf-1', taskId: 'slice-1', originId: 'slice-1' })]
    const html = renderSlice3(<TaskDetailDrawer taskId="slice-1" onClose={() => {}} tasks={[slice3Task({ id: 'slice-1', cluster: 'Done' }), slice3Task({ id: 'slice-2', cluster: 'Queued' }), slice3Task({ id: 'slice-3', cluster: 'Queued' })]} proposals={[]} stepSpans={spans} />)
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(2)
  })
})

describe('TaskDetailDrawer – proposal mode (slice-3 no-regression)', () => {
  it('renders the dialog shell when the taskId is a proposal node id', () => {
    const html = renderSlice3(<TaskDetailDrawer taskId="prop-x" onClose={() => {}} tasks={[slice3Task({ id: 'task-a', cluster: 'Done', parentProposalId: 'prop-x' })]} proposals={[slice3Proposal('prop-x', 'Feature Goal')]} />)
    expect(html).toContain('data-testid="task-detail-drawer"')
    expect(html).toContain('prop-x')
  })
  it('step timeline renders arc spans when proposal-mode stepSpans prop is provided', () => {
    const spans = [slice3Span({ stepName: 'setup', workflowInstanceId: 'wf-1', taskId: 'task-a', originId: 'task-a' }), slice3Span({ stepName: 'code', workflowInstanceId: 'wf-1', taskId: 'task-a', originId: 'task-a' }), slice3Span({ stepName: 'setup', workflowInstanceId: 'wf-2', taskId: 'task-b', originId: 'task-a' }), slice3Span({ stepName: 'code', workflowInstanceId: 'wf-2', taskId: 'task-b', originId: 'task-a' })]
    const html = renderSlice3(<TaskDetailDrawer taskId="prop-x" onClose={() => {}} tasks={[slice3Task({ id: 'task-a', cluster: 'Done', parentProposalId: 'prop-x' }), slice3Task({ id: 'task-b', cluster: 'Done', parentProposalId: 'prop-x' })]} proposals={[slice3Proposal('prop-x')]} stepSpans={spans} />)
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(4)
  })
  it('proposal-mode renders the grouped step-group-proposal section (not the flat task-step-timeline)', () => {
    const html = renderSlice3(<TaskDetailDrawer taskId="prop-x" onClose={() => {}} tasks={[slice3Task({ id: 'task-a', cluster: 'Done', parentProposalId: 'prop-x' })]} proposals={[slice3Proposal('prop-x')]} stepSpans={[]} />)
    expect(html).toContain('data-testid="step-group-proposal"')
    expect(html).not.toContain('data-testid="task-step-timeline"')
  })
})
