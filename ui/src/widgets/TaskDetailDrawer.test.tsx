import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskDetailDrawer } from './TaskDetailDrawer'

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
