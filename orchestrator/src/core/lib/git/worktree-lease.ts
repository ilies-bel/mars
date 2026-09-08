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
 * The lease is a sibling file `<worktreePath>.lease.json` holding the task id,
 * the OS pid of the coder subprocess (`pid`), and the OS pid of the daemon
 * that acquired the lease (`daemonPid`). Sibling, not inside the tree, for the
 * same reason the removal tombstone is a sibling: `git worktree remove` deletes
 * the directory wholesale, and a lease that vanishes with it would be silently
 * lost mid-hold.
 *
 * ## Recorded pids and stale detection
 *
 * At acquisition time the coder subprocess has not yet been spawned, so the
 * lease is written with `pid = process.pid` (the daemon's own pid) as a
 * placeholder. Once the subprocess starts, the caller MUST call
 * `updatePid(coderPid)` so the lease records the actual coder process.
 *
 * `daemonPid` is always the daemon's pid and never changes. It is the key to
 * orphan detection:
 *
 *   - If `daemonPid` is dead the lease is stale — the daemon that spawned
 *     the coder is gone. Even if `pid` (the coder subprocess) is still alive
 *     with PPID=1 (adopted by launchd after the daemon exited), the coder is
 *     an orphan: the daemon that can coordinate cleanup no longer exists, and
 *     the worktree must be freed.
 *   - If `daemonPid` is alive but `pid` is dead, the coder crashed while the
 *     daemon was still running — the lease is stale and must be reclaimed.
 *   - If both are alive the lease is live and another coder is legitimately
 *     running in the tree.
 *
 * Old lease files written before `daemonPid` was introduced contain only
 * `pid`. For backward compatibility, if `daemonPid` is absent, the check falls
 * back to `pid` alone (old behaviour: stale only when `pid` is dead).
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
 * NOT to be confused with the OPERATOR lease (`leaseOwner`/`leasedAt` on the
 * task row, `core/arc.ts` + `tools/human/await-human.ts`). That one records a
 * human owning a task parked at a manual step, is measured in hours, expires
 * into an alert, and never blocks anything. This one is machine-scoped,
 * measured in the length of one coder run, and its entire purpose is to block.
 */
import { open, readFile, unlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { isPidAlive } from './lock'

/** The recorded holder of a worktree lease. */
export interface WorktreeLease {
  /** Task id whose coder occupies the worktree. */
  taskId: string
  /** Branch the holder checked out, when known. */
  branch: string | null
  /**
   * OS pid of the coder subprocess.
   *
   * Initially set to the daemon's own pid as a placeholder (the subprocess
   * has not yet been spawned at acquire time). The caller MUST call
   * `updatePid(coderPid)` once the subprocess starts to replace the
   * placeholder with the actual coder pid, enabling dead-coder detection even
   * while the daemon is alive.
   *
   * A dead `pid` means the coder subprocess has exited — the lease is stale
   * and must be reclaimed.
   */
  pid: number
  /**
   * OS pid of the daemon that acquired this lease.
   *
   * Set at acquisition time and never changed. Used for orphan detection: if
   * the daemon is dead but `pid` (the coder subprocess) is still alive with
   * PPID=1, the coder is an orphan — the daemon that can coordinate cleanup
   * is gone, and the lease must be reclaimed. See module doc comment for the
   * full stale-detection logic.
   *
   * Absent in lease files written by older daemons (before this field was
   * introduced). Readers fall back to checking only `pid` when `daemonPid`
   * is not present.
   */
  daemonPid?: number
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
 * A lease is considered stale — and is reclaimed (unlinked) — when:
 *   - The file is absent, unparseable, or malformed.
 *   - `daemonPid` is present and is dead: the daemon that spawned the coder
 *     is gone. Even if `pid` (the coder) is still alive as an orphan (PPID=1),
 *     the coordinating daemon is absent and the worktree must be freed.
 *   - `pid` (the coder subprocess) is dead: the coder exited while the daemon
 *     was still alive (normal exit or crash).
 *
 * Old lease files without `daemonPid` fall back to checking only `pid`.
 *
 * Reclaiming on read is what keeps a daemon crash from stranding every
 * worktree it held — the first acquire attempt after the old daemon dies
 * will silently free the stale lease.
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

  // ── Orphan detection: check the daemon pid first ─────────────────────────
  // A live coder whose daemon is dead is an orphan (PPID=1). The daemon cannot
  // coordinate cleanup, so we treat this lease as stale and free the worktree.
  // Old leases without daemonPid skip this check and fall through to the pid
  // check below (backward compat: stale only when pid is dead).
  const daemonPid =
    typeof record.daemonPid === 'number' &&
    Number.isInteger(record.daemonPid) &&
    record.daemonPid > 0
      ? record.daemonPid
      : null

  if (daemonPid !== null && !isPidAlive(daemonPid)) {
    console.log(
      `[worktree-lease] releasing stale lease on ${worktreePath}: ` +
        `daemon pid ${daemonPid} (task ${record.taskId}) is no longer alive` +
        (isPidAlive(pid) ? ` (coder pid ${pid} is an orphan and will be swept at startup)` : ''),
    )
    await unlink(path).catch(() => {})
    return null
  }

  // ── Coder-pid check: detect a dead coder even while the daemon lives ──────
  if (!isPidAlive(pid)) {
    console.log(
      `[worktree-lease] releasing stale lease on ${worktreePath}: ` +
        `coder pid ${pid} (task ${record.taskId}) is no longer alive`,
    )
    await unlink(path).catch(() => {})
    return null
  }

  return {
    taskId: record.taskId,
    branch: typeof record.branch === 'string' ? record.branch : null,
    pid,
    daemonPid: daemonPid ?? undefined,
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
   * Update the recorded coder pid from the daemon-pid placeholder to the
   * actual coder subprocess pid.
   *
   * Called once per coder dispatch, after the subprocess is spawned and its
   * OS pid is known. The initial lease records `process.pid` (the daemon's
   * pid) in BOTH `pid` and `daemonPid`. This update replaces `pid` with the
   * coder subprocess pid so that `readLiveWorktreeLease` can detect a dead
   * coder (via `pid`) even while the daemon stays alive — while `daemonPid`
   * stays fixed at the daemon's pid for orphan detection (a coder whose
   * daemon is dead is an orphan even if the coder process itself is alive).
   *
   * Best-effort: a write failure leaves the daemon's pid in `pid` (which is
   * conservative — a live daemon means a live holder). The `release` closure
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
 * ## Why both `pid` and `daemonPid` start as the daemon's pid
 *
 * At acquire time the coder subprocess has not yet been spawned — its pid is
 * unknown. We write `process.pid` (the daemon's pid) as the placeholder for
 * both fields so:
 *   - `pid` blocks concurrent acquires while the caller proceeds to spawn.
 *   - `daemonPid` is set once and never changed; it always identifies the
 *     acquiring daemon for orphan detection after the daemon exits.
 *
 * Once the subprocess pid is known, the caller MUST call `updatePid(coderPid)`
 * to replace `pid` with the real subprocess pid. `daemonPid` stays unchanged.
 *
 * If the coder runs in-process (no subprocess, `onPid` never fires), the
 * daemon's pid stays in both fields. This is correct: the daemon being alive
 * means the run is still ongoing, and a daemon crash makes `isPidAlive` return
 * false for `daemonPid`, releasing the stale lease on the next read.
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
      // Record the daemon's pid as the placeholder for both `pid` and
      // `daemonPid`. `pid` will be updated to the coder subprocess pid once it
      // is known (via `updatePid`). `daemonPid` stays fixed at the daemon's
      // pid for the lifetime of this lease so orphan detection can identify
      // leases whose daemon is dead even if the coder process is still alive.
      let lease: WorktreeLease = {
        taskId: args.taskId,
        branch: args.branch ?? null,
        pid: process.pid,
        daemonPid: process.pid,
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
          // Update only the `pid` field (the coder subprocess). `daemonPid`
          // stays fixed at process.pid (the acquiring daemon's pid) so orphan
          // detection can identify this lease even after the daemon exits.
          //
          // writeFileSync is deliberate: the onPid callback that triggers this
          // update does NOT await the returned Promise (it fires and forgets), so
          // an async write leaves a window where the lease still shows the old
          // daemon pid. Any reader that calls readLiveWorktreeLease while that
          // window is open would see the daemon pid (always alive) and believe the
          // lease is live. Synchronous I/O closes that window — the update is
          // visible to any subsequent readLiveWorktreeLease call on the same
          // event-loop tick. The file is tiny (< 256 bytes) so the sync cost is
          // negligible compared to the coder subprocess lifetime.
          lease = { ...lease, pid }
          writeFileSync(path, JSON.stringify(lease), 'utf8')
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
