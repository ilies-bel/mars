/**
 * Shared "todo feed" module — single source of truth for the bucketing and
 * grouping rules used by:
 *
 *   - the web UI's Todo page (`ui/src/pages/TodoPage.tsx`)
 *   - the web UI server's `/api/todo` handler (`ui/server/index.ts`)
 *   - the CLI's live Todo TUI (`mars actionQueue watch`, see
 *     `orchestrator/src/cli/action-queue-watch.tsx`)
 *
 * The feed is a flat list of `TodoItem`s — currently a discriminated union
 * of two kinds, drafts (proposals waiting to be shaped) and stale worktrees
 * (operational alerts). Items are placed into one of four time buckets
 * relative to "now": Today / Yesterday / This Week / Older.
 *
 * Pure helpers only — no I/O, no DB access. Surface-level data fetching
 * stays in each consumer (the web server already owns it; the TUI calls
 * the same HTTP endpoint). A future task can lift the fetch path into
 * here too once the orchestrator package has a clean state-db handle.
 *
 * TODO(todo-feed): re-export these types from `ui/src/shared/schemas.ts`
 * so the web UI imports from the shared module instead of duplicating
 * the schema definitions.
 */

export type BucketKey = 'today' | 'yesterday' | 'this_week' | 'older'

export const BUCKET_ORDER: ReadonlyArray<BucketKey> = [
  'today',
  'yesterday',
  'this_week',
  'older',
]

export const BUCKET_LABEL: Readonly<Record<BucketKey, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  older: 'Older',
}

/**
 * Minimal shape the bucketing helpers need from a draft. The full
 * `DraftFeature` from `ui/src/shared/schemas.ts` is a superset; the helpers
 * here intentionally accept only the fields they consume so the module
 * has no dependency on the web UI's zod schemas.
 */
export interface DraftLike {
  id: string
  goal: string
  source: string
  acceptanceCount: number
  /** epoch milliseconds */
  updatedAt: number
}

/**
 * Minimal shape for a stale-worktree alert.
 */
export interface StaleLike {
  taskId: string
  status: string
  ageHours: number
  /** ISO timestamp string */
  updatedAt: string
  prompt: string
}

export type TodoItem =
  | { kind: 'draft'; draft: DraftLike }
  | { kind: 'stale'; worktree: StaleLike }

/**
 * Stable key for React/Ink list rendering. Combines kind + identifying id
 * so a draft and a stale worktree that happen to share an id never collide.
 */
export const itemKey = (item: TodoItem): string => {
  if (item.kind === 'draft') return `draft:${item.draft.id}`
  return `stale:${item.worktree.taskId}`
}

/**
 * Returns the timestamp (epoch ms) used to place this item into a bucket.
 * Drafts carry an explicit `updatedAt` (already ms). Stale worktrees only
 * carry an ISO `updatedAt`; we parse it. If the ISO is unparseable we fall
 * back to `now - ageHours` so the row still lands in a sensible bucket.
 */
export const itemTimestamp = (item: TodoItem, now: number): number => {
  if (item.kind === 'draft') return item.draft.updatedAt
  const parsed = Date.parse(item.worktree.updatedAt)
  if (Number.isFinite(parsed)) return parsed
  return now - item.worktree.ageHours * 3_600_000
}

const MS_PER_HOUR = 3_600_000

/**
 * Place a timestamp into one of the four buckets, relative to `now`.
 *
 * - today:       0–24h ago (or in the future, treated as today)
 * - yesterday:   24–48h ago
 * - this_week:   48h–7 days ago
 * - older:       more than 7 days ago
 *
 * Boundaries are exclusive on the upper end: 24h ago exactly belongs to
 * yesterday, 7 days exactly belongs to older. This matches the web UI's
 * historical rule.
 */
export const bucketFor = (ts: number, now: number): BucketKey => {
  const ageHours = (now - ts) / MS_PER_HOUR
  if (ageHours < 24) return 'today'
  if (ageHours < 48) return 'yesterday'
  if (ageHours < 24 * 7) return 'this_week'
  return 'older'
}

/**
 * Group items into the four buckets in canonical order. Empty buckets are
 * omitted from the returned array so the caller can render headers without
 * extra filtering.
 *
 * Items inside a bucket are sorted newest-first (by `itemTimestamp`).
 */
export const groupTodoIntoBuckets = (
  items: ReadonlyArray<TodoItem>,
  now: number,
): Array<{ key: BucketKey; label: string; items: TodoItem[] }> => {
  const grouped = new Map<BucketKey, TodoItem[]>()
  for (const item of items) {
    const ts = itemTimestamp(item, now)
    const key = bucketFor(ts, now)
    const bucket = grouped.get(key)
    if (bucket) {
      bucket.push(item)
    } else {
      grouped.set(key, [item])
    }
  }

  const out: Array<{ key: BucketKey; label: string; items: TodoItem[] }> = []
  for (const key of BUCKET_ORDER) {
    const bucket = grouped.get(key)
    if (!bucket || bucket.length === 0) continue
    bucket.sort((a, b) => itemTimestamp(b, now) - itemTimestamp(a, now))
    out.push({ key, label: BUCKET_LABEL[key], items: bucket })
  }
  return out
}

/**
 * Build the combined feed (drafts + stale worktrees) from the wire-format
 * payload returned by the web UI's `/api/todo` endpoint.
 *
 * The wire shape is `{ drafts: DraftLike[]; staleWorktrees: StaleLike[] }`,
 * which is the same JSON the React Todo page consumes today. Keeping a
 * single canonical builder means the TUI and the React page can never
 * disagree about the merge order.
 */
export const buildTodoFeed = (input: {
  drafts: ReadonlyArray<DraftLike>
  staleWorktrees: ReadonlyArray<StaleLike>
}): TodoItem[] => {
  const items: TodoItem[] = []
  for (const w of input.staleWorktrees) {
    items.push({ kind: 'stale', worktree: w })
  }
  for (const d of input.drafts) {
    items.push({ kind: 'draft', draft: d })
  }
  return items
}
