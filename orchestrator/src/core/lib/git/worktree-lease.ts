/**
 * The exclusive per-worktree coder lease.
 *
 * A worktree is a single-writer resource: the coder agent running inside it
 * commits with `git add -A`, and the surrounding pipeline runs `git clean`,
 * `git rebase` and `git commit` against the same tree. Two agents sharing one
 * `.mars/worktrees/<id>` therefore cross-contaminate by construction — observed
 * during recovery task `fix-2b98a126`, where a second coder's `git add -A`
 * swept the first coder's throwaway probe file into a real commit and HEAD
 * moved under a running agent mid-run.
 *
 * The lease is a sibling file `<worktreePath>.lease.json` holding the task id
 * and the OS pid of the process running the coder. Sibling, not inside the
 * tree, for the same reason the removal tombstone is a sibling: `git worktree
 * remove` deletes the directory wholesale, and a lease that vanishes with it
 * would be silently lost mid-hold.
 *
 * Two properties matter and neither is provided by `acquireLock`
 * (`./lock.ts`, the `.merge.lock` primitive):
 *
 * 1. **Same-pid holders are live, not stale.** `acquireLock` treats a lock
 *    whose recorded pid equals `process.pid` as reclaimable, because its one
 *    job is serialising a critical section inside a single daemon. That rule
 *    is exactly wrong here: the common collision is two coders dispatched by
 *    the *same* daemon, so a same-pid lease must be honoured.
 * 2. **Refuse, do not wait.** A coder run lasts minutes to hours. Blocking on
 *    the lease would pin an implement semaphore slot for the duration, so a
 *    contended acquire throws {@link WorktreeLeaseHeldError} immediately and
 *    the caller reports which task holds the tree.
 *
 * A holder whose pid is dead is stale: the daemon that owned it (and therefore
 * the coder child it spawned) is gone, so the lease is reclaimed on read.
 */
import { open, readFile, unlink } from 'node:fs/promises'
import { isPidAlive } from './lock'

/** The recorded holder of a worktree lease. */
export interface WorktreeLease {
  /** Task id whose coder occupies the worktree. */
  taskId: string
  /** Branch the holder checked out, when known. */
  branch: string | null
  /** OS pid of the process running the coder (the daemon, not the child). */
  pid: number
  /** Epoch milliseconds at which the lease was taken. */
  acquiredAt: number
}

/**
 * Path of the lease file for a worktree. A sibling of the worktree directory,
 * mirroring the `<path>.removed.json` tombstone convention in `./worktree.ts`.
 */
export const worktreeLeasePath = (worktreePath: string): string =>
  `${worktreePath}.lease.json`

/**
 * Thrown when a worktree is already occupied by a live coder. `holder` is the
 * recorded occupant, or `null` when the lease file kept changing under us (a
 * reclaim race) — the tree is contended either way and dispatch must not
 * proceed.
 */
export class WorktreeLeaseHeldError extends Error {
  readonly worktreePath: string
  readonly holder: WorktreeLease | null

  constructor(worktreePath: string, holder: WorktreeLease | null) {
    super(
      holder === null
        ? `worktree ${worktreePath} is contended: its lease changed hands while acquiring`
        : `worktree ${worktreePath} is already leased by task ${holder.taskId} ` +
          `(pid ${holder.pid}, held since ${new Date(holder.acquiredAt).toISOString()})`,
    )
    this.name = 'WorktreeLeaseHeldError'
    this.worktreePath = worktreePath
    this.holder = holder
  }
}

/**
 * Read the lease on `worktreePath`, or `null` when the worktree is free.
 *
 * A lease file that is absent, unparseable, malformed, or owned by a dead pid
 * counts as free — and a stale one is unlinked here so the next acquire can
 * claim the tree. Reclaiming on read is what keeps a daemon crash from
 * stranding every worktree it held.
 */
export const readLiveWorktreeLease = async (
  worktreePath: string,
): Promise<WorktreeLease | null> => {
  const path = worktreeLeasePath(worktreePath)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await unlink(path).catch(() => {})
    return null
  }

  const record = parsed as Partial<WorktreeLease> | null
  const pid = record?.pid
  if (
    record === null ||
    typeof record !== 'object' ||
    typeof record.taskId !== 'string' ||
    record.taskId.length === 0 ||
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    await unlink(path).catch(() => {})
    return null
  }

  if (!isPidAlive(pid)) {
    await unlink(path).catch(() => {})
    return null
  }

  return {
    taskId: record.taskId,
    branch: typeof record.branch === 'string' ? record.branch : null,
    pid,
    acquiredAt:
      typeof record.acquiredAt === 'number' ? record.acquiredAt : Date.now(),
  }
}

/**
 * Take the exclusive lease on `worktreePath`, or throw
 * {@link WorktreeLeaseHeldError} when a live coder already holds it.
 *
 * Returns the release closure. Release is ownership-checked: it unlinks only a
 * lease still recorded as ours, so a lease another process legitimately
 * reclaimed after we were declared stale is never deleted out from under it.
 */
export const acquireWorktreeLease = async (args: {
  worktreePath: string
  taskId: string
  branch?: string | null
}): Promise<() => Promise<void>> => {
  const path = worktreeLeasePath(args.worktreePath)

  // Two attempts: the first EEXIST may be a stale lease that
  // `readLiveWorktreeLease` just reclaimed, in which case the retry claims the
  // freed tree. A second EEXIST with no live holder means another process won
  // the same reclaim — contended, so refuse rather than spin.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const handle = await open(path, 'wx')
      const lease: WorktreeLease = {
        taskId: args.taskId,
        branch: args.branch ?? null,
        pid: process.pid,
        acquiredAt: Date.now(),
      }
      try {
        await handle.write(JSON.stringify(lease))
      } finally {
        await handle.close()
      }
      return async () => {
        const current = await readLiveWorktreeLease(args.worktreePath)
        if (
          current !== null &&
          (current.pid !== lease.pid || current.taskId !== lease.taskId)
        ) {
          return
        }
        await unlink(path).catch(() => {})
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = await readLiveWorktreeLease(args.worktreePath)
      if (holder !== null) throw new WorktreeLeaseHeldError(args.worktreePath, holder)
      if (attempt === 2) throw new WorktreeLeaseHeldError(args.worktreePath, null)
    }
  }

  // Unreachable: the loop either returns the release closure or throws.
  throw new WorktreeLeaseHeldError(args.worktreePath, null)
}
