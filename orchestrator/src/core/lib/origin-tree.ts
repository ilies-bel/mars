/**
 * Build an "origin tree" for a given task — the lineage of work the task
 * descends from. Today's data model supports four node kinds:
 *
 *   - `proposal` — a row in `proposals`. Sits at the root when the task
 *     descends from a sliced PRD. Status mirrors `proposals.status` (draft,
 *     sliced, dismissed, …).
 *   - `prd` — synonym for a proposal that has been promoted to PRD (status
 *     `sliced` or later). We expose the same data; the consumer-facing
 *     distinction lives in the status field, not in a separate node kind.
 *     (Reserved for future: ADR-0034 may split this out.)
 *   - `task` — a row in `tasks`. Status mirrors `tasks.status`.
 *   - `fix` — a recovery task (kind=`fix`). Status mirrors `tasks.status`;
 *     surfaced as its own kind so the UI can highlight retries.
 *
 * The tree's root is the deepest ancestor we can resolve:
 *
 *   1. If the task carries `parent_proposal_id`, the root is that proposal,
 *      its children are every task that shares the same proposal as parent
 *      (i.e. the sibling slices), and the current task sits inside that set.
 *   2. Else if the task carries `origin_id !== id`, the root is the origin
 *      task (a synthetic `task` node) and the children are every task with
 *      the same `origin_id` (the siblings + the current task itself).
 *   3. Otherwise the tree is a single node containing just the task.
 *
 * Recovery tasks (`fix_for_task_id IS NOT NULL`) hang off their origin task
 * as children — they share the same `origin_id`, so case 2/1 captures them
 * naturally. The view nests them under their parent task when the parent is
 * in the tree.
 */
import { getClient, initQueue } from '../queue'
import { getProposal } from '../proposals'

export type OriginNodeKind = 'proposal' | 'prd' | 'task' | 'fix'

export interface OriginNode {
  id: string
  kind: OriginNodeKind
  title: string
  status: string
  children: OriginNode[]
}

export interface OriginTree {
  /** The root node — the deepest known ancestor. */
  node: OriginNode
}

interface TaskRow {
  id: string
  prompt: string
  status: string
  kind: string | null
  fix_for_task_id: string | null
  origin_id: string | null
  parent_proposal_id: string | null
  created_at: string
}

const titleFromPrompt = (prompt: string): string => {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 79)}…`
}

const taskNode = (row: TaskRow): OriginNode => ({
  id: row.id,
  kind: row.kind === 'fix' || row.fix_for_task_id !== null ? 'fix' : 'task',
  title: titleFromPrompt(row.prompt),
  status: row.status,
  children: [],
})

const readTaskRows = async (
  predicate: 'origin_id' | 'parent_proposal_id',
  value: string,
): Promise<TaskRow[]> => {
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT id, prompt, status, kind, fix_for_task_id, origin_id,
                 parent_proposal_id, created_at
            FROM tasks
           WHERE ${predicate} = ?
           ORDER BY created_at ASC`,
    args: [value],
  })
  return r.rows.map((row) => row as unknown as TaskRow)
}

/**
 * Read one task row by id without going through the full {@link getTask}
 * marshaller — we only need a handful of columns here and want to keep this
 * helper independent of the rich Task interface.
 */
const readTaskRow = async (id: string): Promise<TaskRow | null> => {
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT id, prompt, status, kind, fix_for_task_id, origin_id,
                 parent_proposal_id, created_at
            FROM tasks
           WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return r.rows[0] as unknown as TaskRow
}

/**
 * Nest recovery (`fix`) rows under their parent inside a flat task list. A
 * `fix` row whose `fix_for_task_id` matches another row in the list becomes a
 * child of that row; orphan fixes (parent not in the list) stay at the top
 * level. Order is preserved.
 */
const nestRecoveriesUnderParents = (rows: TaskRow[]): OriginNode[] => {
  const nodes = new Map<string, OriginNode>()
  for (const row of rows) {
    nodes.set(row.id, taskNode(row))
  }
  const topLevel: OriginNode[] = []
  for (const row of rows) {
    const node = nodes.get(row.id)
    if (!node) continue
    if (row.fix_for_task_id && nodes.has(row.fix_for_task_id)) {
      nodes.get(row.fix_for_task_id)!.children.push(node)
    } else {
      topLevel.push(node)
    }
  }
  return topLevel
}

/**
 * Map a proposal status to the kind label. Proposals in `sliced` or
 * downstream states are surfaced as `prd` for the UI; everything earlier is
 * a `proposal`.
 */
const proposalKindFromStatus = (status: string): OriginNodeKind => {
  if (status === 'sliced' || status === 'done' || status === 'accepted') {
    return 'prd'
  }
  return 'proposal'
}

export const buildOriginTree = async (
  taskId: string,
): Promise<OriginTree> => {
  await initQueue()
  const row = await readTaskRow(taskId)
  if (!row) {
    // Unknown task id — synthesise a degenerate single-node tree so the
    // endpoint always has something deterministic to return.
    return {
      node: {
        id: taskId,
        kind: 'task',
        title: '(unknown task)',
        status: 'unknown',
        children: [],
      },
    }
  }

  // Case 1: descended from a sliced proposal. Root = the proposal.
  if (row.parent_proposal_id) {
    const proposal = await getProposal(row.parent_proposal_id)
    if (proposal) {
      const siblings = await readTaskRows(
        'parent_proposal_id',
        row.parent_proposal_id,
      )
      return {
        node: {
          id: proposal.id,
          kind: proposalKindFromStatus(proposal.status),
          title: proposal.title || '(untitled proposal)',
          status: proposal.status,
          children: nestRecoveriesUnderParents(siblings),
        },
      }
    }
    // Proposal row vanished (rare; cascade-deleted) — fall through to case 2/3.
  }

  // Case 2: shares an origin with siblings (origin_id is set and != id).
  const originId = row.origin_id ?? row.id
  if (originId !== row.id) {
    // The origin may itself be a task row (the originating arc). Pull it
    // first so the root carries its title/status; if it isn't a task row
    // either, fall through to case 3 (single-node tree).
    const originRow = await readTaskRow(originId)
    if (originRow) {
      const siblings = await readTaskRows('origin_id', originId)
      // The origin task itself shares `origin_id === id`, so it's in the
      // siblings list; lift it out and attach the rest as its children.
      const rest = siblings.filter((s) => s.id !== originId)
      return {
        node: {
          ...taskNode(originRow),
          children: nestRecoveriesUnderParents(rest),
        },
      }
    }
  }

  // Case 3: lone task — single-node tree.
  return { node: { ...taskNode(row), children: [] } }
}
