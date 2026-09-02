/**
 * Arc-aggregate structural invariant (ADR-0052).
 *
 * Extracted from `core/arc.ts` so the blocker-edge module (`core/arc/blockers.ts`)
 * can run the same post-write assert without importing the `Arc` class — which
 * would create an `arc.ts` ⇄ `arc/blockers.ts` cycle. Both the aggregate and the
 * edge module depend on this leaf module; nothing here depends on either.
 */
// ADR-0101: ArcStorePort (leaf) — same rationale as arc/blockers.ts.
import type { ArcStorePort } from '../store/arc-store-port'

/**
 * Thrown when an Arc-aggregate write would leave (or has left) the task graph
 * in a state that violates one of the two Arc invariants checked by
 * {@link assertArcInvariant} (ADR-0052):
 *
 *  A. every Action's `origin_id` resolves to a real Arc root row;
 *  B. every Arc root is a non-recovery origin Action (`kind` ∈ {'task',
 *     'diagnose', 'structured-write'}, `fix_for_task_id IS NULL`).
 *
 * This is a *construction guard*, not a runtime recovery path: a throw means
 * the aggregate produced a stranded entity, which is a bug in a write method,
 * not an operator-actionable condition.
 */
class ArcInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArcInvariantError'
  }
}

/**
 * Assert the two Arc invariants for the Action `arcId` (ADR-0052). This is a
 * debug-assert seam: it issues two cheap SELECTs against the just-committed
 * state and throws {@link ArcInvariantError} if the aggregate produced a
 * stranded entity.
 *
 * INVARIANT A — *every Action has its own row*. Resolve the row for `arcId`.
 * A missing Action row means the aggregate's write did not persist (or was
 * partially committed) — a stranded Action. This is the strong, always-on half
 * of the invariant: the write method just claimed to create/mutate `arcId`, so
 * its row MUST exist post-commit.
 *
 * INVARIANT B — *a TASK-rooted Arc root is a non-recovery origin Action*. The
 * Arc root is the row whose `id === origin_id`. When the arc is self-rooted
 * (`origin_id === id`) OR `origin_id` resolves to a real `tasks` row, that root
 * MUST have `kind` in `('task', 'diagnose')` AND `fix_for_task_id IS NULL`: a
 * recovery (fix) row can never be an Arc root. The PK on `tasks.id` guarantees
 * uniqueness, so "exactly one origin Action" collapses to existence + kind.
 *
 * `origin_id` is deliberately NOT a foreign key (see queue.ts: "origin_id can
 * hold proposal IDs or other non-task arc identifiers; REFERENCES tasks(id)
 * would reject them"). A proposal-originated task carries `origin_id =
 * <proposalId>` — a row in the `proposals` table, not `tasks` — so an
 * `origin_id` that resolves to NO `tasks` row is a legitimate, documented
 * shape (a proposal-rooted / external-grouping arc), NOT a strand. INVARIANT B
 * therefore fires only when the root is a genuine task row; a non-task origin
 * pointer is a soft grouping key and carries no `kind` to check.
 *
 * `Arc.drop` is EXEMPT (it deletes the row, so post-commit the arcId no longer
 * resolves and INVARIANT A would always throw) — `drop` therefore does NOT call
 * this.
 */
const assertArcInvariant = async (
  arcId: string,
  store: ArcStorePort,
): Promise<void> => {
  // INVARIANT A: the Action's own row exists post-commit.
  const actionRes = await store.query({
    sql: `SELECT id, origin_id, kind FROM tasks WHERE id = ?`,
    args: [arcId],
  })
  if (actionRes.rows.length === 0) {
    throw new ArcInvariantError(`Action ${arcId} has no row`)
  }
  const actionRow = actionRes.rows[0] as unknown as {
    id: string
    origin_id: string | null
    kind: string | null
  }
  const oid = actionRow.origin_id ?? actionRow.id
  // INVARIANT B: only when origin_id names a real TASK row. A proposal-id /
  // external grouping origin (no tasks-row) is a documented non-FK shape, not
  // a strand — there is nothing in `tasks` to kind-check, so we skip silently.
  const rootRes = await store.query({
    sql: `SELECT kind, fix_for_task_id FROM tasks WHERE id = ?`,
    args: [oid],
  })
  if (rootRes.rows.length === 0) {
    return
  }
  const rootRow = rootRes.rows[0] as unknown as {
    kind: string | null
    fix_for_task_id: string | null
  }
  const rootKind = rootRow.kind ?? 'task'
  // 'structured-write' is a recognized self-rooted terminal bookkeeping
  // kind (Arc.recordStructuredWrite): always origin_id = id, never
  // recoverable/dispatchable, and excluded from ordinary task listings via
  // ORDINARY_TASK_SQL. It is a real Arc root, just not a TaskKind union
  // member, so it is allowed here alongside 'task' / 'diagnose'.
  if (rootKind !== 'task' && rootKind !== 'diagnose' && rootKind !== 'structured-write') {
    throw new ArcInvariantError(
      `Arc root ${oid} (for Action ${arcId}) has kind='${rootKind}'; an Arc root must be kind 'task', 'diagnose', or 'structured-write'`,
    )
  }
  if (rootRow.fix_for_task_id !== null) {
    throw new ArcInvariantError(
      `Arc root ${oid} (for Action ${arcId}) has fix_for_task_id='${rootRow.fix_for_task_id}'; a recovery row can never be an Arc root`,
    )
  }
}

/**
 * Run {@link assertArcInvariant} only when `MARS_ARC_INVARIANT_CHECK === '1'`.
 * Centralises the env gate so every call site is a single `await` and the
 * production transaction path pays no SELECT round-trip. It is invoked at the
 * TAIL of every mutating Arc write method (after the batch/atomic commit); the
 * vitest setup sets the flag so the suite enforces it on every arc-mutating
 * test.
 */
export const maybeAssertArcInvariant = async (
  arcId: string,
  store: ArcStorePort,
): Promise<void> => {
  if (process.env.MARS_ARC_INVARIANT_CHECK === '1') {
    await assertArcInvariant(arcId, store)
  }
}
