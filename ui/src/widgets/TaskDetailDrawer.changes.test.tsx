/**
 * Tests for the Changes section inside TaskDetailBody.
 *
 * Uses renderToStaticMarkup (SSR) so the ChangesSection receives
 * `changesData` directly (injected prop) — no fetch, no query, no DOM.
 *
 * Covers:
 *   - Summary line: file count, +A -D, commit count
 *   - File list: status pill and path per file
 *   - Expandable hunks: rendered in a monospace block (checked via data-testid)
 *   - Branch-gone: distinct message from an empty diff; sha offered when known
 *   - Empty diff: "This task changed no files." (only when diff is genuinely empty)
 *   - changesData=null suppresses the Changes section entirely
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '@/shared/schemas'
import type { TaskChangesResponse } from '@/shared/schemas'
import { TaskDetailBody } from './TaskDetailDrawer'

// ── Helpers ───────────────────────────────────────────────────────────────────

const renderBody = (element: ReactElement): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{element}</QueryClientProvider>,
  )
}

/** Minimal Task fixture — only the fields TaskDetailBody actually reads. */
const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-test-123',
  prompt: 'Implement the changes feature',
  status: 'done',
  plan: null,
  branch: 'task/task-test-123',
  worktreePath: null,
  error: null,
  dropReason: null,
  recoverySpawnedCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T01:00:00Z',
  ...overrides,
})

const CHANGES_WITH_FILES: TaskChangesResponse = {
  base: 'abc1234',
  head: 'def5678',
  landedSha: '000aaaa',
  files: [
    { path: 'src/foo.ts', status: 'M', additions: 5, deletions: 2 },
    { path: 'src/bar.ts', status: 'A', additions: 10, deletions: 0 },
  ],
  patch: [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index aaa..bbb 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,5 @@',
    ' keep',
    '+added1',
    '+added2',
    ' keep2',
    ' keep3',
    'diff --git a/src/bar.ts b/src/bar.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/bar.ts',
    '@@ -0,0 +1,2 @@',
    '+line1',
    '+line2',
  ].join('\n'),
  truncated: false,
  commits: [
    { sha: 'abc1234abc1234abc1234', subject: 'feat: add bar', authoredAt: '2024-01-01T00:00:00Z' },
    { sha: 'def5678def5678def5678', subject: 'chore: modify foo', authoredAt: '2024-01-01T01:00:00Z' },
  ],
}

const BRANCH_GONE: TaskChangesResponse = {
  reason: 'branch-gone',
  base: null,
  head: null,
  landedSha: null,
  files: [],
  patch: '',
  truncated: false,
  commits: [],
}

const BRANCH_GONE_WITH_SHA: TaskChangesResponse = {
  reason: 'branch-gone',
  base: null,
  head: null,
  landedSha: 'abc1234def567890abc1234def567890abc12345',
  files: [],
  patch: '',
  truncated: false,
  commits: [],
}

const EMPTY_DIFF: TaskChangesResponse = {
  base: 'abc1234',
  head: 'def5678',
  landedSha: null,
  files: [],
  patch: '',
  truncated: false,
  commits: [],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskDetailBody – Changes section', () => {
  it('renders the Changes section with summary line when changesData has files', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={CHANGES_WITH_FILES} />,
    )
    expect(html).toContain('data-testid="changes-section"')
    expect(html).toContain('data-testid="changes-summary"')
    // File count
    expect(html).toContain('2 files')
    // +A stat
    expect(html).toContain('+15')
    // −D stat
    expect(html).toContain('−2')
    // commit count
    expect(html).toContain('2 commits')
    // Landed sha shown (7 chars)
    expect(html).toContain('000aaaa')
  })

  it('renders a file row per changed file with status pill and path', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={CHANGES_WITH_FILES} />,
    )
    expect(html).toContain('data-testid="file-row-src/foo.ts"')
    expect(html).toContain('data-testid="file-row-src/bar.ts"')
    // Status pills
    expect(html).toContain('>M<')
    expect(html).toContain('>A<')
    // Paths
    expect(html).toContain('src/foo.ts')
    expect(html).toContain('src/bar.ts')
  })

  it('does not render expanded hunks by default (SSR renders collapsed state)', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={CHANGES_WITH_FILES} />,
    )
    // Expanded hunk containers are only rendered when isExpanded is true.
    // In SSR, useState initialises to empty Set so nothing is expanded.
    expect(html).not.toContain('data-testid="file-hunks-src/foo.ts"')
  })

  it('renders a distinct branch-gone message (not "changed no files") for the branch-gone shape', () => {
    // Default task status is 'done' — should say "cleaned up after merging".
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={BRANCH_GONE} />,
    )
    expect(html).toContain('data-testid="changes-section"')
    // Must show branch-gone container, not the empty-diff message
    expect(html).toContain('data-testid="changes-branch-gone"')
    expect(html).toContain('cleaned up after merging')
    // Must NOT say "changed no files" — that is reserved for genuinely empty diffs
    expect(html).not.toContain('This task changed no files.')
    // No sha shown when landedSha is null
    expect(html).not.toContain('data-testid="changes-branch-gone-sha"')
    // No file rows
    expect(html).not.toContain('data-testid="file-row-')
  })

  it('shows a "dropped" message for a dropped task with branch-gone shape', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask({ status: 'dropped' })} changesData={BRANCH_GONE} />,
    )
    expect(html).toContain('data-testid="changes-branch-gone"')
    expect(html).toContain('was dropped')
    // Must NOT claim the task was merged
    expect(html).not.toContain('cleaned up after merging')
    expect(html).not.toContain('This task changed no files.')
  })

  it('names the missing branch, without claiming work was lost, for a failed task', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask({ status: 'failed' })} changesData={BRANCH_GONE} />,
    )
    expect(html).toContain('data-testid="changes-branch-gone"')
    expect(html).toContain('No branch on record for this task')
    // Must NOT claim the task was merged
    expect(html).not.toContain('cleaned up after merging')
    expect(html).not.toContain('This task changed no files.')
  })

  it('shows the merge commit sha when branch-gone includes a landedSha', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={BRANCH_GONE_WITH_SHA} />,
    )
    expect(html).toContain('data-testid="changes-branch-gone"')
    expect(html).toContain('data-testid="changes-branch-gone-sha"')
    // Sha is shown abbreviated to 7 chars
    expect(html).toContain('abc1234')
    expect(html).not.toContain('This task changed no files.')
  })

  it('renders "This task changed no files." only for a genuinely empty diff (no branch-gone)', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={EMPTY_DIFF} />,
    )
    expect(html).toContain('data-testid="changes-section"')
    expect(html).toContain('data-testid="changes-empty"')
    expect(html).toContain('This task changed no files.')
    // Must NOT show the branch-gone container
    expect(html).not.toContain('data-testid="changes-branch-gone"')
  })

  it('suppresses the Changes section entirely when changesData is null', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={null} />,
    )
    expect(html).not.toContain('data-testid="changes-section"')
  })

  it('renders the Changes section in live-fetch mode when changesData is undefined', () => {
    // When changesData is undefined the section fetches live data.
    // In SSR, the useQuery is disabled so data===undefined and the skeleton
    // renders (no summary line, no file rows).  The section container is still
    // present so the data-testid is available.
    const html = renderBody(
      <TaskDetailBody task={makeTask()} />,
    )
    // Section should be present (ChangesSection renders even without data).
    expect(html).toContain('data-testid="changes-section"')
    // But no summary line — data hasn't loaded.
    // (The skeleton renders instead, which has no data-testid="changes-summary".)
  })

  it('renders gate checks summary when gateChecks are present', () => {
    const withGateChecks: TaskChangesResponse = {
      ...CHANGES_WITH_FILES,
      gateChecks: [
        { name: 'typecheck', gateId: 'gate-1', passed: true, durationMs: 5000 },
        { name: 'knip', gateId: 'gate-2', passed: true, durationMs: 3200 },
        { name: 'test', gateId: 'gate-3', passed: false, durationMs: 4100 },
      ],
    }
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={withGateChecks} />,
    )
    expect(html).toContain('data-testid="gate-checks-summary"')
    expect(html).toContain('typecheck')
    expect(html).toContain('knip')
    expect(html).toContain('test')
    // Passing gates show ✓, failing show ✗
    expect(html).toContain('✓')
    expect(html).toContain('✗')
    // Total duration shown (5000+3200+4100 = 12300ms = 12.3s)
    expect(html).toContain('12.3s')
  })

  it('does not render gate checks summary when gateChecks is null', () => {
    const withoutGateChecks: TaskChangesResponse = {
      ...CHANGES_WITH_FILES,
      gateChecks: null,
    }
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={withoutGateChecks} />,
    )
    expect(html).not.toContain('data-testid="gate-checks-summary"')
  })

  it('does not render gate checks summary when gateChecks is undefined (absent from response)', () => {
    // When the API response omits gateChecks (older tasks), the section must
    // not appear — undefined is treated the same as null by the ?? null coercion.
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={CHANGES_WITH_FILES} />,
    )
    expect(html).not.toContain('data-testid="gate-checks-summary"')
  })

  it('shows "Checks:" label when gate checks are present', () => {
    const withGateChecks: TaskChangesResponse = {
      ...CHANGES_WITH_FILES,
      gateChecks: [
        { name: 'typecheck', gateId: 'gate-1', passed: true, durationMs: null },
      ],
    }
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={withGateChecks} />,
    )
    expect(html).toContain('Checks:')
  })

  it('does not render gate checks summary for branch-gone shape', () => {
    const html = renderBody(
      <TaskDetailBody task={makeTask()} changesData={BRANCH_GONE} />,
    )
    expect(html).not.toContain('data-testid="gate-checks-summary"')
  })
})
