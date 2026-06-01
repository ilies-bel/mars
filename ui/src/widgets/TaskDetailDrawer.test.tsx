import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  OriginsResponse,
  ProgressProposalNode,
  ProgressTask,
  Task,
} from '@/shared/schemas'
import type { StepSpan } from './TaskDetailDrawer'
import {
  TaskDetailDrawer,
  TaskDetailBody,
  applyNavigate,
  crumbLabel,
} from './TaskDetailDrawer'

// ── Test helpers ──────────────────────────────────────────────────────────────

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
  retryCount: 0,
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-drawer"')
    expect(html).toContain('role="dialog"')
  })

  it('displays the task id in the drawer heading', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('mars-abc123')
  })

  it('exposes a close control via data-testid', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-close"')
  })

  it('renders the same drawer structure regardless of which task id is passed', () => {
    const html1 = renderToStaticMarkup(
      <TaskDetailDrawer taskId="task-from-dag" onClose={() => {}} />,
    )
    const html2 = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="task-solo" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="task-detail-subgraph"')
  })
})

// ── Subgraph: upstream blocker chain ─────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (upstream blockers)', () => {
  it('includes a direct upstream blocker in the subgraph', () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-overlay"')
  })

  it('scrim is aria-hidden so it does not pollute the screen reader tree', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('aria-hidden="true"')
  })

  it('scrim uses z-40 (lower than the drawer z-50) so the drawer stays on top', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('z-40')
    expect(html).toContain('z-50')
  })

  it('drawer panel has tabindex="-1" so it can receive programmatic focus on open', () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('drawer-panel')
  })

  it('scrim carries the drawer-scrim CSS class (scrim fade anchor)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('drawer-scrim')
  })

  it('data-closing is absent on initial render — exit animation not yet active', () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    const cls = classOf(html, 'task-detail-overlay')
    expect(cls).toContain('hidden')
    expect(cls).toContain('xl:block')
  })
})

// ── Subgraph: cluster colours match main canvas ───────────────────────────────

describe('TaskDetailDrawer – subgraph (cluster colours match main canvas)', () => {
  it('colours a Queued task node with the Queued palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    // Colours are now CSS design-token references so both canvases stay in sync.
    expect(html).toContain('var(--color-dag-queued-fill)')
    expect(html).toContain('var(--color-dag-queued-stroke)')
  })

  it('colours a Failed task node with the Failed palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[]}
      />,
    )
    // Colours are now CSS design-token references so both canvases stay in sync.
    expect(html).toContain('var(--color-dag-failed-fill)')
    expect(html).toContain('var(--color-dag-failed-stroke)')
  })

  it('colours a Blocked task node with the Blocked palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Blocked', status: 'blocked' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-blocked-fill)')
    expect(html).toContain('var(--color-dag-blocked-stroke)')
  })

  it('colours an In progress task node with the In progress palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'In progress', status: 'running' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-in-progress-fill)')
    expect(html).toContain('var(--color-dag-in-progress-stroke)')
  })

  it('colours a proposal node with the purple proposal palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).toContain('var(--color-dag-proposal-fill)')
    expect(html).toContain('var(--color-dag-proposal-stroke)')
  })

  it('attaches data-cluster to task nodes for cluster identification', () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
  retryCount: overrides.retryCount ?? 0,
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

const renderBody = (t: Task, origins?: OriginsResponse): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  // null is the projectId slot — defaults to null outside FocusedProjectProvider
  qc.setQueryData(['origins', null, t.id], origins ?? SINGLE_NODE_ORIGINS(t.id))
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TaskDetailBody task={t} />
    </QueryClientProvider>,
  )
}

describe('TaskDetailBody – failed task with error + spec', () => {
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
      taskType: 'auto',
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

  it('renders the spec section with files, read-first, verify, and done criteria', () => {
    const html = renderBody(failed)
    expect(html).toContain('data-testid="task-detail-spec"')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
    expect(html).toContain('docs/x.md')
    expect(html).toContain('Refactor the frobnicator')
    expect(html).toContain('bun test src')
    expect(html).toContain('tests pass')
    expect(html).toContain('lint clean')
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

  it('does not render the spec section when spec is null', () => {
    const html = renderBody(minimal)
    expect(html).not.toContain('data-testid="task-detail-spec"')
  })

  it('does not render a Plan header when plan is null', () => {
    const html = renderBody(minimal)
    expect(html).not.toContain('>Plan<')
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="task-detail-breadcrumb"')
  })

  it('renders NO breadcrumb when initialTrail is a single element', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="solo"
        onClose={() => {}}
        initialTrail={['solo']}
      />,
    )
    expect(html).not.toContain('data-testid="task-detail-breadcrumb"')
  })

  it('renders the breadcrumb container with one crumb per trail id', () => {
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <TaskDetailBody task={t} onNavigate={() => {}} currentId="focus" />
      </QueryClientProvider>,
    )
    expect(html).toContain('data-origin-node-id="prop-x"')
    expect(html).toMatch(/<button[^>]*>[\s\S]*?prop-x/)
  })

  it('renders origin rows as plain cells (no buttons) when onNavigate is omitted', () => {
    const t = fullTask({ id: 'focus' })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    // null is the projectId slot — defaults to null outside FocusedProjectProvider
    qc.setQueryData(['origins', null, 'focus'], TREE_ORIGINS('focus'))
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <TaskDetailBody task={t} />
      </QueryClientProvider>,
    )
    expect(html).toContain('data-origin-node-id="prop-x"')
    // No origin-row button wraps the node id when display-only.
    expect(html).not.toMatch(/<button[^>]*>[\s\S]*?prop-x/)
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
})

describe('TaskDetailDrawer – step timeline (via stepSpans prop)', () => {
  it('renders a step timeline section when stepSpans prop is provided', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[]} />,
    )
    expect(html).toContain('data-testid="task-step-timeline"')
  })

  it('does not render the step timeline section when stepSpans prop is omitted', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="task-step-timeline"')
  })

  it('renders one row per step span', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1', workerName: 'Coder' }),
      span({ stepName: 'verify', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'merge', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(4)
  })

  it('shows setup, code, verify, merge step names in the rendered rows', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'code', workflowInstanceId: 'wf-1', workerName: 'Coder' }),
      span({ stepName: 'verify', workflowInstanceId: 'wf-1' }),
      span({ stepName: 'merge', workflowInstanceId: 'wf-1' }),
    ]
    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-outcome="running"')
  })

  it('marks a completed step with data-outcome="completed"', () => {
    const spans = [
      span({ stepName: 'setup', workflowInstanceId: 'wf-1', outcome: 'completed' }),
    ]
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-outcome="completed"')
  })

  it('marks a failed step with data-outcome="failed"', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'failed' }),
    ]
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    expect(html).toContain('data-outcome="failed"')
  })

  it('renders each recover step as its own distinct row (not collapsed with code)', () => {
    const spans = [
      span({ stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'failed', workerName: 'Coder' }),
      span({ stepName: 'recover', workflowInstanceId: 'wf-2', outcome: 'completed', workerName: 'Fixer' }),
    ]
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={spans} />,
    )
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(2)
    // Both step names appear in the output
    expect(html).toContain('code')
    expect(html).toContain('recover')
  })

  it('shows an empty-state message when stepSpans is an empty array', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="t1" onClose={() => {}} stepSpans={[]} />,
    )
    // Empty state is present and no rows are rendered
    expect(html).toContain('data-testid="task-step-timeline"')
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(0)
  })
})
