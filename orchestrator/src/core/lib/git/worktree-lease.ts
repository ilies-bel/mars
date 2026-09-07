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
 *    the caller reports which task holds the tree (`mars task stop <id>`
 *    releases it early).
 *
 * A holder whose pid is dead is stale: the daemon that owned it (and therefore
 * the coder child it spawned) is gone, so the lease is reclaimed on read.
 *
 * NOT to be confused with the OPERATOR lease (`leaseOwner`/`leasedAt` on the
 * task row, `core/arc.ts` + `tools/human/await-human.ts`). That one records a
 * human owning a task parked at a manual step, is measured in hours, expires
 * into an alert, and never blocks anything. This one is machine-scoped,
 * measured in the length of one coder run, and its entire purpose is to block.
 */
import { open, readFile, unlink, writeFile } from 'node:fs/promises'
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
    console.log(
      `[worktree-lease] releasing stale lease on ${worktreePath}: ` +
        `pid ${pid} (task ${record.taskId}) is no longer alive`,
    )
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
 * Handle returned by {@link acquireWorktreeLease}.
 *
 * Two responsibilities:
 *  - `release()` — relinquish the exclusive lease (ownership-checked).
 *  - `updatePid(pid)` — swap the placeholder daemon pid for the coder's real
 *    subprocess pid, so `readLiveWorktreeLease` can detect a dead coder even
 *    when the daemon is still alive.
 */
export interface WorktreeLeaseHandle {
  /**
   * Release the exclusive lease. Ownership-checked: unlinks only when the
   * lease file still records this task + pid, so a lease another process
   * legitimately reclaimed after we were declared stale is never deleted out
   * from under it.
   */
  release(): Promise<void>
  /**
   * Update the recorded pid to the coder's actual subprocess pid.
   *
   * Called once per coder dispatch, after the subprocess is spawned and its
   * OS pid is known. The initial lease records `process.pid` (the daemon's
   * pid) as a placeholder so the file exists and blocks concurrent acquires;
   * this update replaces it with the pid of the actual coder process, so
   * `readLiveWorktreeLease` can detect a dead coder and release the stale
   * lease — even when the daemon is still alive.
   *
   * Best-effort: a write failure leaves the daemon's pid in the lease
   * (conservative: a live daemon means a live holder). The `release` closure
   * still cleans up on exit regardless.
   */
  updatePid(pid: number): Promise<void>
}

/**
 * Take the exclusive lease on `worktreePath`, or throw
 * {@link WorktreeLeaseHeldError} when a live coder already holds it.
 *
 * Returns a {@link WorktreeLeaseHandle} with `release` and `updatePid`.
 * Release is ownership-checked: it unlinks only a lease still recorded as
 * ours, so a lease another process legitimately reclaimed after we were
 * declared stale is never deleted out from under it.
 *
 * ## Why the initial pid is the daemon's
 *
 * At acquire time the coder subprocess has not yet been spawned — its pid is
 * unknown. We write `process.pid` (the daemon's pid) as a placeholder that
 * blocks concurrent acquires while the caller proceeds to spawn the coder.
 * Once the subprocess pid is known, the caller MUST call `updatePid(coderPid)`
 * so that a crashed coder can be detected as stale even when the daemon is
 * still alive.
 *
 * If the coder runs in-process (no subprocess, `onPid` never fires), the
 * daemon's pid stays in the lease. This is correct: the daemon being alive
 * means the run is still ongoing, and a daemon crash makes `isPidAlive` return
 * false, releasing the stale lease on the next read.
 */
export const acquireWorktreeLease = async (args: {
  worktreePath: string
  taskId: string
  branch?: string | null
}): Promise<WorktreeLeaseHandle> => {
  const path = worktreeLeasePath(args.worktreePath)

  // Two attempts: the first EEXIST may be a stale lease that
  // `readLiveWorktreeLease` just reclaimed, in which case the retry claims the
  // freed tree. A second EEXIST with no live holder means another process won
  // the same reclaim — contended, so refuse rather than spin.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const handle = await open(path, 'wx')
      // Record the daemon's pid as a placeholder. The coder's real subprocess
      // pid is not yet known. The caller must call updatePid(coderPid) once
      // the subprocess starts so stale-lease detection works correctly even
      // when the daemon stays alive after the coder crashes.
      let lease: WorktreeLease = {
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

      const release = async (): Promise<void> => {
        // Ownership check: only delete the file when it still records OUR
        // task. If another process legitimately reclaimed a stale lease
        // (our process was declared dead and the tree was reassigned), we
        // must not delete their lease. Compare taskId only — not pid —
        // because updatePid() changes the pid after acquisition and the
        // release closure's captured `lease.pid` may already be stale.
        let current: WorktreeLease | null = null
        try {
          current = await readLiveWorktreeLease(args.worktreePath)
        } catch {
          // If we can't read, unlink unconditionally — better to release
          // than to strand the worktree.
        }
        if (current !== null && current.taskId !== args.taskId) {
          return
        }
        await unlink(path).catch(() => {})
      }

      const updatePid = async (pid: number): Promise<void> => {
        try {
          lease = { ...lease, pid }
          await writeFile(path, JSON.stringify(lease), 'utf8')
        } catch (err) {
          // Non-fatal: daemon's pid stays. The release closure cleans up on exit.
          console.warn(
            `[worktree-lease] updatePid(${pid}) for task ${args.taskId} failed (non-fatal):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      return { release, updatePid }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = await readLiveWorktreeLease(args.worktreePath)
      if (holder !== null) throw new WorktreeLeaseHeldError(args.worktreePath, holder)
      if (attempt === 2) throw new WorktreeLeaseHeldError(args.worktreePath, null)
    }
  }

  // Unreachable: the loop either returns the handle or throws.
  throw new WorktreeLeaseHeldError(args.worktreePath, null)
}
