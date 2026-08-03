/**
 * Slice F.2: dirty-main detection helper.
 *
 * Both detection points (dispatch-time before worktree spawn, and verify-time
 * at the top of the verify step) share this helper. It probes the integration
 * branch's working tree with `git status --porcelain`. When the branch is
 * dirty, active-committer dedup is keyed on the integration branch name:
 * parallel integration branches each get their own independent committer,
 * and all tasks on the same branch share one committer regardless of which
 * files are dirty or where HEAD is.
 *
 * All git calls go through `runTool` so they emit `tool_invoked` trace events
 * (slice C). The single source of truth for "dirty" is the porcelain output —
 * non-empty ⇒ dirty.
 *
 * The helper is best-effort against transient git failures: if `git status`
 * itself errors, it returns `{ dirty: false }` and the caller proceeds as if
 * the branch is clean. The legacy `checkSetupPreflight` backstop that used to
 * catch transient git failures was retired in slice K; pessimistically
 * reporting clean here is the documented fallback now.
 */
import { runTool, type TraceCtx } from './run-tool'
import { probeWorkerLiveness } from './worker-liveness'
import { attachToExistingFixTask } from '../queue-fix-tasks'
import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from '../store/task-store'
import { Arc } from '../arc'
import type { TraceEventStore } from './trace-events-store'

// ---------------------------------------------------------------------------
// Shared guard: stranded-checkout detection
// ---------------------------------------------------------------------------

/**
 * Probes whether `repoRoot` is actually checked out on `integrationBranch`.
 * Returns `{ status: 'ok' }` when the branch matches (or is detached at the
 * integration tip), `{ status: 'stranded', currentBranch }` when the primary
 * checkout is on a different branch (e.g. a task branch left behind by a
 * crashed merge step).
 *
 * Shared by `checkIntegrationBranchDirty` and `classifyIntegrationDirtState`
 * to avoid misreading a stale branch's state as dirty main.
 */
const probeIntegrationBranch = async (
  repoRoot: string,
  integrationBranch: string,
  traceCtx: TraceCtx,
): Promise<{ status: 'ok' } | { status: 'stranded'; currentBranch: string }> => {
  const branchProbe = await runTool(
    {
      tool: 'git',
      argv: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => null)

  if (branchProbe === null || branchProbe.exitCode !== 0) return { status: 'ok' }

  const currentBranch = branchProbe.stdout.trim()
  if (currentBranch === integrationBranch) return { status: 'ok' }

  if (currentBranch === 'HEAD') {
    // Detached HEAD is OK when it points to the integration branch tip.
    const headShaProbe = await runTool(
      {
        tool: 'git',
        argv: ['rev-parse', 'HEAD'],
        cwd: repoRoot,
        taskId: traceCtx.taskId ?? null,
        originId: traceCtx.originId ?? null,
        phase: traceCtx.phase ?? null,
        expectsFailure: true,
      },
      traceCtx.store,
    ).catch(() => null)
    const integShaProbe = await runTool(
      {
        tool: 'git',
        argv: ['rev-parse', integrationBranch],
        cwd: repoRoot,
        taskId: traceCtx.taskId ?? null,
        originId: traceCtx.originId ?? null,
        phase: traceCtx.phase ?? null,
        expectsFailure: true,
      },
      traceCtx.store,
    ).catch(() => null)
    if (
      headShaProbe?.exitCode === 0 &&
      integShaProbe?.exitCode === 0 &&
      headShaProbe.stdout.trim() === integShaProbe.stdout.trim()
    ) {
      return { status: 'ok' } // Detached at integration branch tip — fine.
    }
  }

  return { status: 'stranded', currentBranch }
}

// ---------------------------------------------------------------------------
// Classify dirt state
// ---------------------------------------------------------------------------

/**
 * Discriminated-union result for `classifyIntegrationDirtState`.
 *
 * - `clean`            — no dirty files; committer is not needed.
 * - `committer-scope`  — dirty files a fresh main-committer can legitimately
 *                        stage and commit (modified tracked files, new untracked
 *                        files). `statusOutput` is the raw porcelain output.
 * - `unrelated`        — dirt the committer CANNOT resolve survives a committer
 *                        run: ignored entries, unmerged/conflicted paths,
 *                        submodule gitlink changes, or paths whose parent
 *                        directory is ignored. `contaminatedPaths` lists those
 *                        paths verbatim so callers can quote them in alerts.
 */
export type ClassifyIntegrationDirtStateResult =
  | { kind: 'clean' }
  | { kind: 'committer-scope'; statusOutput: string }
  | { kind: 'unrelated'; statusOutput: string; contaminatedPaths: string[] }

/**
 * Returns `true` when a porcelain v1 line represents dirt a fresh
 * main-committer cannot resolve:
 *
 * - `XY[0] === 'U'`     — unmerged on the index side (UU, UD, UA, …)
 * - `XY[1] === 'U'`     — unmerged on the worktree side (DU, AU, …)
 *
 * Plain `!!` ignored entries are NOT unresolvable dirt: every dev checkout
 * carries them (node_modules/, dist/, .DS_Store, …), they can never reach a
 * commit, and a committer resolves them by ignoring them — treating them as
 * contamination blocked every dispatch on any machine with a .gitignore.
 *
 * For '??'-with-ignored-parent detection, use `classifyIntegrationDirtState`
 * which has access to the full set of ignored directory prefixes.
 */
export const isCommitterUnresolvable = (porcelainLine: string): boolean => {
  if (porcelainLine.length < 2) return false
  const xy = porcelainLine.slice(0, 2)
  if (xy[0] === 'U' || xy[1] === 'U') return true
  return false
}

/** Extract the destination path from a porcelain v1 line. */
const parsePorcelainPath = (line: string): string => {
  // Format: "XY PATH" or "XY ORIG -> DEST" (rename/copy)
  const raw = line.slice(3)
  const arrowIdx = raw.indexOf(' -> ')
  return arrowIdx >= 0 ? raw.slice(arrowIdx + 4).trim() : raw.trim()
}

/**
 * Classify the integration branch's dirty state into three outcomes.
 *
 * Runs three git probes:
 *  1. `git status --porcelain --untracked-files=all` — standard dirty check
 *  2. `git status --ignored --porcelain`             — captures `!!` ignored entries
 *  3. `git ls-files --unmerged`                      — detects unresolved conflicts
 *
 * Additionally probes `git ls-files --stage` to detect submodule gitlink
 * changes (mode 160000 entries).
 *
 * Contamination rules (→ `'unrelated'`):
 *  - `XY === '!!'`           — ignored entries; a checkpoint never captures these
 *  - `XY[0|1] === 'U'`       — unmerged/conflicted paths
 *  - mode 160000 paths       — submodule gitlink changes
 *  - `??` inside ignored dir — untracked files whose parent directory is ignored
 */
export const classifyIntegrationDirtState = async (input: {
  repoRoot: string
  integrationBranch: string
  traceCtx: TraceCtx
}): Promise<ClassifyIntegrationDirtStateResult> => {
  const { repoRoot, integrationBranch, traceCtx } = input

  // Stranded-checkout guard: if the primary checkout is on a task branch,
  // bail out as clean rather than misreading its state.
  const guard = await probeIntegrationBranch(repoRoot, integrationBranch, traceCtx)
  if (guard.status === 'stranded') {
    console.warn(
      `[main-dirty] classify: integration branch repoRoot is checked out on ${guard.currentBranch}, expected ${integrationBranch}; returning clean`,
    )
    return { kind: 'clean' }
  }

  const nullResult = { exitCode: 1, stdout: '', stderr: '', durationMs: 0, traceEventId: '' }

  // 1. git status --porcelain --untracked-files=all
  const status = await runTool(
    {
      tool: 'git',
      argv: ['status', '--porcelain', '--untracked-files=all'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => nullResult)

  // 2. git status --ignored --porcelain (captures !! entries)
  const ignoredStatus = await runTool(
    {
      tool: 'git',
      argv: ['status', '--ignored', '--porcelain'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => nullResult)

  // 3. git ls-files --unmerged (detects conflict stages)
  const unmergedProbe = await runTool(
    {
      tool: 'git',
      argv: ['ls-files', '--unmerged'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => nullResult)

  // Parse regular status lines (non-empty).
  const regularLines = status.exitCode === 0
    ? status.stdout.split('\n').filter(Boolean)
    : []

  // Extract only !! lines from the --ignored output (avoid duplicating regular entries).
  const ignoredOnlyLines = ignoredStatus.exitCode === 0
    ? ignoredStatus.stdout.split('\n').filter((l) => l.slice(0, 2) === '!!')
    : []

  // Parse unmerged paths from ls-files --unmerged (format: "MODE SHA STAGE\tPATH").
  const unmergedPaths = new Set<string>()
  if (unmergedProbe.exitCode === 0 && unmergedProbe.stdout.trim().length > 0) {
    for (const line of unmergedProbe.stdout.split('\n').filter(Boolean)) {
      const tabIdx = line.indexOf('\t')
      if (tabIdx >= 0) unmergedPaths.add(line.slice(tabIdx + 1).trim())
    }
  }

  // Combine for status output. Plain ignored entries (`!!`) are benign — they
  // exist in every dev checkout and cannot reach a commit — so they neither
  // dirty the branch nor appear in statusOutput; they are only consulted below
  // as directory prefixes for the '??'-with-ignored-parent contamination case.
  const allStatusLines = [...regularLines]
  const statusOutput = allStatusLines.join('\n') + (allStatusLines.length > 0 ? '\n' : '')

  // Early exit: fully clean.
  if (allStatusLines.length === 0 && unmergedPaths.size === 0) {
    return { kind: 'clean' }
  }

  // Build set of ignored directory prefixes (from !! entries ending with '/').
  const ignoredDirPrefixes = new Set<string>()
  for (const line of ignoredOnlyLines) {
    const p = parsePorcelainPath(line)
    if (p.endsWith('/')) ignoredDirPrefixes.add(p)
  }

  // Detect submodule gitlinks via git ls-files --stage (mode 160000).
  const submodulePaths = new Set<string>()
  const stageProbe = await runTool(
    {
      tool: 'git',
      argv: ['ls-files', '--stage'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => null)
  if (stageProbe !== null && stageProbe.exitCode === 0) {
    for (const line of stageProbe.stdout.split('\n').filter(Boolean)) {
      if (line.startsWith('160000 ')) {
        const tabIdx = line.indexOf('\t')
        if (tabIdx >= 0) submodulePaths.add(line.slice(tabIdx + 1).trim())
      }
    }
  }

  // Collect contaminated paths.
  const seen = new Set<string>()
  const contaminatedPaths: string[] = []
  const addContaminated = (p: string): void => {
    if (!seen.has(p)) { seen.add(p); contaminatedPaths.push(p) }
  }

  for (const line of allStatusLines) {
    if (isCommitterUnresolvable(line)) {
      addContaminated(parsePorcelainPath(line))
      continue
    }
    const p = parsePorcelainPath(line)
    // Submodule gitlink change.
    if (submodulePaths.has(p)) {
      addContaminated(p)
      continue
    }
    // '??'-with-ignored-parent: untracked file inside an ignored directory.
    if (line.slice(0, 2) === '??') {
      for (const dir of ignoredDirPrefixes) {
        if (p.startsWith(dir)) { addContaminated(p); break }
      }
    }
  }

  // Also add unmerged paths confirmed by ls-files --unmerged.
  for (const p of unmergedPaths) addContaminated(p)

  if (contaminatedPaths.length > 0) {
    return { kind: 'unrelated', statusOutput, contaminatedPaths }
  }

  return { kind: 'committer-scope', statusOutput }
}

export interface CheckIntegrationBranchDirtyInput {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /**
   * Integration branch name (e.g. 'main'). Used to guard against stranded
   * checkouts: if repoRoot HEAD is on a different branch (e.g. a task branch
   * left behind by a crashed merge step), the probe returns dirty:false and
   * emits a warning rather than misreading that branch's state as dirty main.
   */
  integrationBranch: string
  /** Trace context; phase is left to the caller's run (setup or verify). */
  traceCtx: TraceCtx
}

export interface IntegrationBranchDirtyResult {
  dirty: boolean
  /**
   * Raw `git status --porcelain` output (untracked included). Empty string
   * when clean. Surfaced for log lines and the aggregated actionQueue row.
   */
  statusOutput: string
}

/**
 * Probe the integration branch's working tree.
 *
 * Failure-mode contract:
 *  - Non-zero exit from `git rev-parse --abbrev-ref HEAD` ⇒ skip the
 *    stranded-checkout guard and proceed to the status check (best-effort).
 *  - Non-zero exit from `git status` ⇒ treat as clean (return dirty:false).
 *    Pessimistically reporting clean here is safer than throwing, which
 *    would crash the dispatch loop on a transient git hiccup. (The legacy
 *    setup-time preflight that doubled as a backstop was retired in
 *    slice K.)
 */
export const checkIntegrationBranchDirty = async (
  input: CheckIntegrationBranchDirtyInput,
): Promise<IntegrationBranchDirtyResult> => {
  const { repoRoot, traceCtx, integrationBranch } = input

  // Guard: verify repoRoot is actually on the integration branch. If the
  // primary checkout is stranded on a task branch after a crashed merge step,
  // `git status` reads that branch's state as "dirty main" and drives a
  // false-positive committer loop. Returning dirty:false here is safe —
  // pessimistically reporting clean prevents the loop without losing work.
  const guard = await probeIntegrationBranch(repoRoot, integrationBranch, traceCtx)
  if (guard.status === 'stranded') {
    console.warn(
      `[main-dirty] integration branch repoRoot is checked out on ${guard.currentBranch}, expected ${integrationBranch}; skipping dirty-main probe`,
    )
    return { dirty: false, statusOutput: '' }
  }

  // `--untracked-files=all` so a wholly-new directory shows up file-by-file
  // — the same convention as the post-coder porcelain parse. The committer
  // recipe operator will read these paths verbatim.
  const status = await runTool(
    {
      tool: 'git',
      argv: ['status', '--porcelain', '--untracked-files=all'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      // Non-zero exit on `git status` here is a real error (e.g. repoRoot is
      // not a git repo), but we still want the trace classed as `warn` since
      // we recover by treating the branch as clean.
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch((err: unknown) => {
    // Spawn-time errors fall through as "treat as clean" too.
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: 0,
      traceEventId: '',
    }
  })

  if (status.exitCode !== 0) {
    return { dirty: false, statusOutput: '' }
  }
  const statusOutput = status.stdout
  if (statusOutput.length === 0) {
    return { dirty: false, statusOutput: '' }
  }

  return { dirty: true, statusOutput }
}

/**
 * Failure code emitted whenever dirty-main detection parks a task. Aligns
 * with the failure-reason catalog entry in `failure-reasons/built-in.ts`.
 * Kept as a module constant so the dispatch-time and verify-time call sites
 * cannot drift.
 */
export const VERIFY_MAIN_DIRTY_CODE = 'verify:main-dirty'

/**
 * Recipe name that resolves the committer agent (see
 * `recipes/built-in/main-commiter.md`). Stored on the recovery task's
 * `recovery_payload` so future actionQueue / UI code can render which recipe a
 * given recovery is running.
 */
export const MAIN_COMMITER_RECIPE = 'main-commiter'

/**
 * Shape of the JSON blob persisted on `tasks.recovery_payload` for a
 * `main-commiter` recovery. Other recipes that adopt the same column will
 * use their own shape; the column is opaque at the persistence layer.
 */
export interface MainCommiterPayload {
  recipe: typeof MAIN_COMMITER_RECIPE
  /**
   * Integration branch the committer is parked on. This is the active-committer
   * dedup key: parallel integration branches each get their own independent
   * committer, and all tasks on the same branch share one committer regardless
   * of what files are dirty or where HEAD is.
   */
  integrationBranch: string
}

/**
 * Parse a recovery_payload string into a typed MainCommiterPayload, returning
 * null when the payload is missing, malformed, or for a different recipe.
 * Used by the catalog auto-resolve and aggregated-actionQueue-row paths.
 */
export const parseMainCommiterPayload = (
  raw: string | null,
): MainCommiterPayload | null => {
  if (raw === null || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<MainCommiterPayload>
    if (parsed.recipe !== MAIN_COMMITER_RECIPE) return null
    if (typeof parsed.integrationBranch !== 'string') return null
    return {
      recipe: MAIN_COMMITER_RECIPE,
      integrationBranch: parsed.integrationBranch,
    }
  } catch {
    return null
  }
}

/** Serialise a payload for the `recovery_payload` column. */
export const serialiseMainCommiterPayload = (
  payload: MainCommiterPayload,
): string => JSON.stringify(payload)

/**
 * Status set `resolveActiveMainCommitter` uses to locate a committer that can
 * still accept new sources (i.e. an in-flight committer). 'done' is NOT
 * included here — a done committer can no longer unblock dependents (done
 * tasks do not transition back), so attaching a new source to one would
 * create a phantom blocker that can never resolve.
 *
 * 'failed' is NOT included: a failed committer is a dead-end that can never
 * unblock its dependents, so attaching new tasks to it would wedge them
 * permanently. The on-failure handler in server.ts releases blocked
 * dependents of a failed committer back to 'queued' and raises an
 * action-queue item for the operator. A fresh committer is spawned when the
 * branch is still dirty after a failure.
 */
const ACTIVE_COMMITTER_STATUSES = [
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
  'blocked',
] as const

/**
 * Grace window applied ONLY to the zombie-committer check, and only when the
 * daemon reports the committer as not-in-flight.
 *
 * This is deliberately NOT a work timeout. Liveness is the primary signal: a
 * committer that is genuinely working is in the daemon's flight tracker and is
 * classified `alive` no matter how many minutes it has been running, because
 * the tracker entry — not row age — is what the check reads. The grace only
 * suppresses the narrow transition races where the row already says `running`
 * but the tracker entry is momentarily absent (the dispatcher's eager
 * `status='running'` write racing `commitInFlight`, or a slot handoff). Sixty
 * seconds is orders of magnitude larger than either window.
 */
const COMMITTER_ZOMBIE_GRACE_MS = 60_000

/**
 * The committer statuses that imply a worker process. Only these are subject
 * to the zombie check.
 *
 * `queued` and `blocked` are excluded because they legitimately have no
 * process — a queued committer is waiting for a dispatch slot, and the
 * `queued-committer-reseed` reconciler owns its staleness. `verifying`,
 * `merging` and `vega-reconciling` are excluded because those phases hand the
 * task between semaphore slots (verify slot, merge queue), so a transiently
 * absent tracker entry is expected there and each has its own startup-recovery
 * step. Narrow on purpose: the only status a vanished worker strands forever
 * with no other recovery path is `running`.
 */
const PROCESS_BACKED_COMMITTER_STATUSES = new Set(['running'])

/**
 * How `resolveActiveMainCommitter` classified the newest matching committer.
 *
 * - `none`   — no committer in an attachable status for this branch.
 * - `alive`  — safe to attach; the committer can still reach `done` and
 *              unblock its dependents.
 * - `zombie` — the row claims a process-backed status but this daemon holds no
 *              worker for it. Attaching would convert a transient condition
 *              into a permanent, queue-wide deadlock, because every later task
 *              attaches too. Must be reaped and replaced.
 */
export type ActiveMainCommitterResolution =
  | { kind: 'none' }
  | { kind: 'alive'; id: string; status: string }
  | { kind: 'zombie'; id: string; status: string }

/**
 * Look up the most recently created `main-commiter` recovery task whose
 * `integrationBranch` matches, and classify whether it is safe to attach to.
 *
 * Dedup is branch-keyed: parallel integration branches each get their own
 * committer, and all tasks on the same branch share one active committer.
 *
 * Done committers are NOT included — a done task cannot be reactivated, so
 * attaching a new source to it would create a phantom blocker. A new dirty
 * episode on the same branch always spawns a fresh committer.
 * Failed committers are excluded — see ACTIVE_COMMITTER_STATUSES.
 *
 * LIVENESS. A `running` row is a claim, not a fact. When the daemon restarts
 * mid-run it kills the worker process but the row keeps saying `running`
 * forever, and every subsequent task that hits dirty-main used to attach to
 * that corpse — 2026-07-30 incident: 23 tasks parked behind one dead committer,
 * 0 queued / 43 blocked, surviving two daemon restarts. So a committer in a
 * process-backed status is only `alive` when the daemon positively reports a
 * worker for it (see `lib/worker-liveness.ts`). Outside a daemon the probe
 * answers `'unknown'` and the committer is treated as alive — a process that
 * does not own the workers has no standing to declare one dead.
 */
export const resolveActiveMainCommitter = async (
  integrationBranch: string,
  store: TaskStore,
  nowMs: number = Date.now(),
): Promise<ActiveMainCommitterResolution> => {
  const placeholders = ACTIVE_COMMITTER_STATUSES.map(() => '?').join(',')
  const r = await store.query({
    sql: `SELECT id, status, updated_at FROM tasks
           WHERE kind = 'fix'
             AND status IN (${placeholders})
             AND recovery_payload::jsonb ->> 'recipe' = ?
             AND recovery_payload::jsonb ->> 'integrationBranch' = ?
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [...ACTIVE_COMMITTER_STATUSES, MAIN_COMMITER_RECIPE, integrationBranch],
  })
  if (r.rows.length === 0) return { kind: 'none' }
  const row = r.rows[0] as unknown as {
    id: string
    status: string
    updated_at: string | Date | null
  }

  if (!PROCESS_BACKED_COMMITTER_STATUSES.has(row.status)) {
    return { kind: 'alive', id: row.id, status: row.status }
  }
  if (probeWorkerLiveness(row.id) !== 'dead') {
    return { kind: 'alive', id: row.id, status: row.status }
  }
  // Not in flight. Apply the race-suppressing grace before declaring it dead.
  const updatedMs =
    row.updated_at instanceof Date
      ? row.updated_at.getTime()
      : Date.parse(String(row.updated_at ?? ''))
  if (Number.isFinite(updatedMs) && nowMs - updatedMs <= COMMITTER_ZOMBIE_GRACE_MS) {
    return { kind: 'alive', id: row.id, status: row.status }
  }
  return { kind: 'zombie', id: row.id, status: row.status }
}

/**
 * Failure signature stamped on a committer reaped because its worker vanished.
 * Distinct from a committer that ran and failed on its own merits — this one
 * never got the chance.
 */
export const COMMITTER_WORKER_VANISHED_CODE = 'main-commiter:worker-vanished'

/**
 * Reap a zombie committer through the audited task seam.
 *
 * Transitions the row `running` -> `failed`. This is the ONLY safe reaping
 * gesture: deleting the row would strand every dependent on a dangling
 * `task_blockers` edge, and leaving it `running` is what caused the deadlock in
 * the first place. `failed` is the state the rest of the machinery already
 * knows how to resolve —
 *
 *  - the daemon's on-failure handler raises the aggregated committer
 *    action-queue row while keeping every dependent parked on its edge;
 *  - `reparentStrandedDependentsOntoNewCommitter`, which the fresh-spawn path
 *    below always calls, then moves every dependent still blocked on this
 *    now-`failed` committer onto the replacement;
 *  - the failed-committer startup reconciler restores the same aggregated
 *    operator alert if the daemon dies between the two.
 *
 * `running` is not a terminal status, so this transition does not touch the
 * `reject_terminal_task_transition` trigger.
 */
const reapZombieCommitter = async (
  committerTaskId: string,
  status: string,
  integrationBranch: string,
): Promise<void> => {
  const { updateTask } = await import('../queue')
  await updateTask(committerTaskId, {
    status: 'failed',
    failedPhase: 'code',
    failureReason: COMMITTER_WORKER_VANISHED_CODE,
    failureReasonCode: COMMITTER_WORKER_VANISHED_CODE,
    failureSignature: COMMITTER_WORKER_VANISHED_CODE,
    error:
      `main-commiter for ${integrationBranch} was left in status=${status} with no worker process ` +
      `(daemon restart or worker crash). Reaped so its dependents are not parked behind it forever; ` +
      `a fresh committer has been spawned to take over.`,
  })
  console.warn(
    `[main-dirty] reaped zombie main-commiter ${committerTaskId} (status=${status}, no worker process) on ${integrationBranch}`,
  )
}

/**
 * Title surfaced on the `tasks.error` column of the source task when it
 * parks on a `main-commiter`. Kept short — the bulk of the context is on
 * the recovery task itself.
 */
export const SOURCE_ERROR_SUMMARY = (
  integrationBranch: string,
  dispatchPhase: 'dispatch' | 'verify' | 'merge',
): string =>
  `dirty integration branch (${integrationBranch}) detected at ${dispatchPhase}; parked behind main-commiter recovery`

export interface MainCommitterResolution {
  /** The recovery task id the source is now blocked on. */
  fixTaskId: string
  /** `true` when a brand-new committer row was inserted; `false` when the source attached to an existing one. */
  spawned: boolean
  /** Status of the existing committer when attaching ('failed' is also possible per dedup rules). */
  attachedToStatus: string | null
  /**
   * Set to the id of a committer that was reaped as a zombie (process-backed
   * status, no worker) immediately before this fresh spawn. `null` on every
   * ordinary spawn/attach. Surfaced so callers can log the replacement.
   */
  reapedZombieCommitterId: string | null
}

export interface SpawnOrAttachInput {
  /** The task that hit dirty-main and must be parked. Must NOT itself be a recovery (kind !== 'fix'). */
  sourceTaskId: string
  /** Result of `checkIntegrationBranchDirty`. Must be `dirty: true`. */
  detection: IntegrationBranchDirtyResult
  /** Integration branch label captured at detection time. */
  integrationBranch: string
  /** Which phase tripped detection — drives the recorded `failure_reason`. */
  dispatchPhase: 'dispatch' | 'verify' | 'merge'
  /** Pre-rendered recipe body. */
  recipePrompt: string
  /** Origin id of the source, so the recovery row inherits it. */
  sourceOriginId: string
  /** Trace event store for the `recovery_spawned` emit. */
  traceStore: TraceEventStore
  store?: TaskStore
}

/**
 * Dedup-aware spawn for `main-commiter`. Either inserts a fresh recovery
 * task and parks the source behind it, or — when an active committer for the
 * same integration branch already exists — attaches the source to the existing
 * recovery via `attachToExistingFixTask`.
 *
 * Dedup is branch-keyed: parallel integration branches each get their own
 * independent committer, and all tasks on the same branch share one active
 * committer regardless of which files are dirty or where HEAD is. A done or
 * failed committer is never reused — done means the work was completed (a new
 * dirty episode requires a fresh committer), and failed is a dead-end.
 *
 * Attach requires LIVENESS, not just an attachable status. Serializing every
 * dirty-main task behind one committer is correct and deliberate — but only
 * while that committer can still finish. A committer whose worker process is
 * gone can never reach `done`, so parking behind it is permanent, and because
 * every later task parks behind it too, the deadlock is self-amplifying and
 * survives daemon restarts. When `resolveActiveMainCommitter` reports a zombie
 * this function reaps it to `failed` and falls through to the fresh-spawn
 * branch, whose `reparentStrandedDependentsOntoNewCommitter` call moves the
 * corpse's dependents onto the replacement. Recover and replace — never park.
 *
 * The new fix-task row is inserted directly (not via `upsertFixTask`)
 * because the catalog-driven recipe path is signature-agnostic — there is
 * no entry for `verify:main-dirty` in the legacy `recipes` map in
 * `fix-recipes.ts`. The two writes (fix-task INSERT + task_blockers INSERT
 * + source UPDATE) share one batch so a crash leaves no orphan row.
 *
 * This function is ALSO the legitimate exemption from the F.1 ADR-0040
 * leaf-node guard: the fresh-spawn branch inserts an origin → recovery
 * `task_blockers` edge directly, mirroring `upsertFixTask`'s exemption.
 * The attach branch goes through `attachToExistingFixTask`, which carries
 * the same exemption (and documents it in the SQL site comment).
 */
export const spawnOrAttachMainCommitter = async (
  input: SpawnOrAttachInput,
): Promise<MainCommitterResolution> => {
  if (input.detection.dirty !== true) {
    throw new Error(
      'spawnOrAttachMainCommitter called with a clean detection result',
    )
  }

  const s = input.store ?? (await getDefaultTaskStore())

  // Look for an ACTIVE (non-done, non-failed) committer for this integration
  // branch. Branch-keyed dedup means: one active committer per branch at a
  // time, shared by all tasks that hit dirty-main on that branch.
  const existing = await resolveActiveMainCommitter(input.integrationBranch, s)

  if (existing.kind === 'alive') {
    await attachToExistingFixTask({
      sourceTaskId: input.sourceTaskId,
      fixTaskId: existing.id,
      errorSummary: SOURCE_ERROR_SUMMARY(
        input.integrationBranch,
        input.dispatchPhase,
      ),
      store: s,
    })
    return {
      fixTaskId: existing.id,
      spawned: false,
      attachedToStatus: existing.status,
      reapedZombieCommitterId: null,
    }
  }

  // Zombie: the committer's row still claims a process-backed status but its
  // worker is gone. Reap it to `failed` through the audited seam FIRST, so the
  // fresh spawn below sees a dead-end committer it can reparent dependents off
  // of, then continue into the ordinary fresh-spawn path.
  let reapedZombieCommitterId: string | null = null
  if (existing.kind === 'zombie') {
    await reapZombieCommitter(existing.id, existing.status, input.integrationBranch)
    reapedZombieCommitterId = existing.id
  }

  // No attachable committer for this branch — spawn fresh. Done committers are
  // intentionally NOT reused: a done committer proves main was clean when it
  // verified, but re-detecting dirt means a genuinely new dirty episode that
  // needs a fresh committer.
  const arc = Arc.load(input.sourceOriginId, s)
  const { fixTaskId } = await arc.spawnMainCommitterRecovery({
    sourceTaskId: input.sourceTaskId,
    integrationBranch: input.integrationBranch,
    dispatchPhase: input.dispatchPhase,
    recipePrompt: input.recipePrompt,
    sourceOriginId: input.sourceOriginId,
    traceStore: input.traceStore,
  })
  // Moves every dependent still `blocked` on a FAILED committer for this branch
  // — including the zombie just reaped — onto the replacement.
  await Arc.reparentStrandedDependentsOntoNewCommitter(
    fixTaskId,
    input.integrationBranch,
  )
  return {
    fixTaskId,
    spawned: true,
    attachedToStatus: null,
    reapedZombieCommitterId,
  }
}
