/**
 * Orphan reaper — the Steward's autonomous cleanup of leaked verify/test
 * subprocesses.
 *
 * ## The incident this exists for
 *
 * The orchestrator spawns test/verify runners (vitest, tsc, playwright, …)
 * inside `.mars/worktrees/<task-id>/` during the `verify` step. When a task is
 * aborted, times out, or the daemon restarts, those children used to survive:
 * they got reparented to init (PPID 1) and kept burning CPU indefinitely.
 * Observed in production: 15 orphaned vitest processes aged 187–249 minutes,
 * seven of them at 43–73 % CPU each, eating ~3.5 of 10 cores.
 *
 * That produced a self-sustaining deadlock — high machine load made the
 * autotuner refuse to raise the implement cap, the backlog drained at a third
 * speed, and nothing ever reaped the orphans, so load never fell. Reaping is
 * therefore not a reporting nicety: it is the only thing that breaks the loop.
 *
 * ## Design
 *
 * The decision logic ({@link judgeProcess}) is a pure function over a fixture
 * process table so it can be unit-tested without shelling out or signalling a
 * real pid. Enumeration and killing are injectable side effects.
 *
 * ## Platform notes (macOS / darwin)
 *
 * - `ps -o etimes=` is Linux-only. We parse `ps -o etime=` (`[[dd-]hh:]mm:ss`).
 * - `ps -o comm=` prints only the executable name (`node`), which never matches
 *   `vitest`. We match full argv via `pgrep -f`, then feed the pid list to `ps`.
 * - `ps %cpu` is a LIFETIME AVERAGE, not an instantaneous sample, so it is
 *   never used to decide whether a process is busy.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** One row of the process table, already parsed. */
export interface ProcessRow {
  pid: number
  ppid: number
  /** Process-group id. Killing `-pgid` reaps the leader AND its descendants. */
  pgid: number
  /** Elapsed wall-clock time since the process started, in seconds. */
  ageSeconds: number
  /** Full argv as reported by `ps -o command=`. */
  command: string
}

/** Why a process was (or was not) judged an orphan. */
export type OrphanReason =
  /** Reparented to init — the orchestrator that spawned it is gone. */
  | 'reparented'
  /** Belongs to a worktree whose task is no longer in flight. */
  | 'task-not-in-flight'
  /** Not one of the orchestrator's own verify/test subprocess signatures. */
  | 'not-orchestrator-owned'
  /** The reaper's own process or process group — never signalled. */
  | 'self'
  /** Younger than the conservative age threshold; a healthy long test. */
  | 'too-young'
  /** Still parented to a live process and its task is in flight. */
  | 'live-parent'

export interface OrphanVerdict {
  pid: number
  pgid: number
  ageSeconds: number
  command: string
  /** Task id decoded from the `.mars/worktrees/<task-id>/` path, when present. */
  taskId: string | null
  verdict: 'reap' | 'skip'
  reason: OrphanReason
}

export interface OrphanSweepSummary {
  /** Rows returned by the enumerator (before any filtering). */
  scanned: number
  /** Process groups actually signalled. */
  reaped: number
  /** Rows deliberately left alone. */
  skipped: number
  details: readonly OrphanVerdict[]
}

/**
 * Full-argv tokens that identify a test/verify runner. A process only
 * qualifies when its argv ALSO points inside this repo's
 * `.mars/worktrees/` tree, so a developer's own `vitest` in an unrelated
 * checkout is never a candidate.
 *
 * `tsx` and bare `node` are deliberately absent — they are too broad and
 * would catch the dev-install CLI wrapper.
 */
const VERIFY_RUNNER_RE =
  /(?:^|[\s/])(?:vitest|jest|mocha|playwright|cypress|tsc)(?:$|[\s/.])|\b(?:npm|pnpm|yarn)\b[^\n]*\b(?:test|typecheck)\b/

/**
 * The `pgrep -f` pattern used to enumerate candidates. Deliberately broad
 * (every process whose argv mentions a Mars worktree); the precise filtering
 * — repo scoping and runner-signature matching — happens in
 * {@link judgeProcess}, which is unit-tested.
 *
 * `pgrep` takes an extended regular expression, hence the escaped dot.
 */
export const ORPHAN_PGREP_PATTERN = '\\.mars/worktrees/'

/**
 * Parse a `ps -o etime=` field. Format is `[[dd-]hh:]mm:ss`.
 * Returns `null` when the field does not match (never a bogus 0, which would
 * make an unparseable row look brand new and therefore protected).
 */
export const parseEtimeSeconds = (raw: string): number | null => {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const minutes = Number(m[3])
  const seconds = Number(m[4])
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

/**
 * Parse one line of `ps -ww -o pid=,ppid=,pgid=,etime=,command=` output.
 * Returns `null` for blank or malformed lines.
 */
export const parsePsLine = (line: string): ProcessRow | null => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
  if (!m) return null
  const ageSeconds = parseEtimeSeconds(m[4])
  if (ageSeconds === null) return null
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    pgid: Number(m[3]),
    ageSeconds,
    command: m[5],
  }
}

/**
 * Decode the task id from an argv that points inside `<worktreesRoot>/<id>/…`.
 * Returns `null` when the argv does not reference the tree at all.
 */
export const taskIdFromCommand = (
  command: string,
  worktreesRoot: string,
): string | null => {
  const needle = `${worktreesRoot}/`
  const at = command.indexOf(needle)
  if (at === -1) return null
  const rest = command.slice(at + needle.length)
  const end = rest.search(/[/\s]/)
  const id = end === -1 ? rest : rest.slice(0, end)
  return id.length > 0 ? id : null
}

export interface JudgeOptions {
  /** Absolute path of `<repo>/.mars/worktrees` — scopes the sweep to this repo. */
  worktreesRoot: string
  /** Task ids the daemon currently has in flight; their processes are healthy. */
  inFlightTaskIds: ReadonlySet<string>
  /** Nothing younger than this is ever reaped. */
  minAgeSeconds: number
  /** Pids that must never be signalled (the daemon, its parent). */
  protectedPids: ReadonlySet<number>
  /** The reaper's own process group, when known. Never signalled. */
  protectedPgid: number | null
}

/**
 * Pure classifier: decide whether one process row is a genuine orphan.
 *
 * A row is reaped only when ALL of the following hold:
 *   1. its argv points inside this repo's `.mars/worktrees/` tree AND matches a
 *      known verify/test runner signature;
 *   2. it is neither the reaper's own process nor in the reaper's group;
 *   3. it is older than `minAgeSeconds` (so a healthy long-running suite is
 *      never killed);
 *   4. AND it is either reparented to init (ppid 1) or belongs to a task id
 *      that is no longer in flight.
 */
export const judgeProcess = (
  row: ProcessRow,
  opts: JudgeOptions,
): OrphanVerdict => {
  const taskId = taskIdFromCommand(row.command, opts.worktreesRoot)
  const base = {
    pid: row.pid,
    pgid: row.pgid,
    ageSeconds: row.ageSeconds,
    command: row.command,
    taskId,
  }
  const skip = (reason: OrphanReason): OrphanVerdict => ({
    ...base,
    verdict: 'skip',
    reason,
  })
  const reap = (reason: OrphanReason): OrphanVerdict => ({
    ...base,
    verdict: 'reap',
    reason,
  })

  if (taskId === null || !VERIFY_RUNNER_RE.test(row.command)) {
    return skip('not-orchestrator-owned')
  }
  if (
    opts.protectedPids.has(row.pid) ||
    (opts.protectedPgid !== null && row.pgid === opts.protectedPgid)
  ) {
    return skip('self')
  }
  if (row.ageSeconds < opts.minAgeSeconds) return skip('too-young')
  if (row.ppid === 1) return reap('reparented')
  if (!opts.inFlightTaskIds.has(taskId)) return reap('task-not-in-flight')
  return skip('live-parent')
}

/**
 * Classify a whole process table. Exported separately from {@link sweepOrphans}
 * so the decision logic can be exercised against fixtures with no I/O at all.
 */
export const judgeProcessTable = (
  rows: readonly ProcessRow[],
  opts: JudgeOptions,
): readonly OrphanVerdict[] => rows.map((row) => judgeProcess(row, opts))

// ── Live enumeration ────────────────────────────────────────────────────────

const PS_MAX_BUFFER = 8 * 1024 * 1024

/**
 * Enumerate candidate processes with `pgrep -f` (full-argv match) and then
 * `ps` for the fields we need. `ps -o comm=` would print only `node`, so the
 * argv must come from `ps -o command=` with `-ww` to defeat width truncation.
 */
export const listCandidateProcesses = async (): Promise<readonly ProcessRow[]> => {
  let pidOutput = ''
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', ORPHAN_PGREP_PATTERN], {
      maxBuffer: PS_MAX_BUFFER,
    })
    pidOutput = stdout
  } catch {
    // pgrep exits 1 when nothing matches — that is the common, healthy case.
    // Any other failure (pgrep absent) is equally non-fatal: no candidates.
    return []
  }
  const pids = pidOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
  if (pids.length === 0) return []

  let psOutput = ''
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-ww', '-o', 'pid=,ppid=,pgid=,etime=,command=', '-p', pids.join(',')],
      { maxBuffer: PS_MAX_BUFFER },
    )
    psOutput = stdout
  } catch {
    // Every candidate exited between pgrep and ps — `ps -p` exits 1 on an
    // empty selection. Nothing to reap.
    return []
  }
  const rows: ProcessRow[] = []
  for (const line of psOutput.split('\n')) {
    const row = parsePsLine(line)
    if (row !== null) rows.push(row)
  }
  return rows
}

/** Read this process's own process-group id via `ps`; `null` when unavailable. */
export const readOwnPgid = async (): Promise<number | null> => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    const n = Number(stdout.trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** True when at least one process still lives in `pgid`. */
const defaultGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    // EPERM means the group exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const defaultKillGroup = (pgid: number, signal: NodeJS.Signals): void => {
  process.kill(-pgid, signal)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Default conservative age threshold. Production orphans were 187–249 minutes
 * old; ten minutes is far below that yet comfortably above any legitimate
 * verify step (the integration gate's own ceiling is ~2 minutes).
 */
export const DEFAULT_MIN_AGE_SECONDS = Number(
  process.env.MARS_ORPHAN_MIN_AGE_SECONDS ?? 600,
)

/** Grace between the group SIGTERM and the escalation to SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = Number(
  process.env.MARS_ORPHAN_KILL_GRACE_MS ?? 2_000,
)

export interface OrphanSweepOptions {
  /** Repo root; `<repoRoot>/.mars/worktrees` scopes the sweep. */
  repoRoot: string
  /** Task ids currently in flight — their subprocesses are healthy. */
  inFlightTaskIds: ReadonlySet<string>
  minAgeSeconds?: number
  graceMs?: number
  log?: (line: string) => void
  // ── injected side effects (tests pass fakes so no real pid is signalled) ──
  listProcesses?: () => Promise<readonly ProcessRow[]>
  ownPgid?: () => Promise<number | null>
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void
  groupAlive?: (pgid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

/**
 * Detect and reap orphaned verify/test subprocesses.
 *
 * Each reaped group gets a SIGTERM to `-pgid` (so descendants die with the
 * leader) and, after `graceMs`, a SIGKILL if anything in the group survived —
 * a child that ignores SIGTERM must not be able to keep the group alive.
 *
 * Every kill is logged with pid, age, and the reason the process was judged an
 * orphan. Returns a structured summary so callers can log and act on it.
 */
export const sweepOrphans = async (
  opts: OrphanSweepOptions,
): Promise<OrphanSweepSummary> => {
  const listProcesses = opts.listProcesses ?? listCandidateProcesses
  const killGroup = opts.killGroup ?? defaultKillGroup
  const groupAlive = opts.groupAlive ?? defaultGroupAlive
  const sleep = opts.sleep ?? defaultSleep
  const ownPgid = opts.ownPgid ?? readOwnPgid
  const log = opts.log ?? ((): void => {})
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS

  const rows = await listProcesses()
  if (rows.length === 0) {
    return { scanned: 0, reaped: 0, skipped: 0, details: [] }
  }

  const verdicts = judgeProcessTable(rows, {
    worktreesRoot: `${opts.repoRoot.replace(/\/$/, '')}/.mars/worktrees`,
    inFlightTaskIds: opts.inFlightTaskIds,
    minAgeSeconds: opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS,
    protectedPids: new Set([process.pid, process.ppid]),
    protectedPgid: await ownPgid(),
  })

  // One SIGTERM per distinct group — several rows usually share one pgid
  // (npm → vitest → forks all live in the group the orchestrator created).
  const doomed = verdicts.filter((v) => v.verdict === 'reap')
  const groups = new Map<number, OrphanVerdict>()
  for (const v of doomed) {
    if (!groups.has(v.pgid)) groups.set(v.pgid, v)
  }

  for (const v of doomed) {
    log(
      `[orphan-reaper] reaping pid=${v.pid} pgid=${v.pgid} age=${v.ageSeconds}s task=${v.taskId ?? '?'} reason=${v.reason} cmd=${v.command.slice(0, 160)}`,
    )
  }

  const signalled: number[] = []
  for (const pgid of groups.keys()) {
    try {
      killGroup(pgid, 'SIGTERM')
      signalled.push(pgid)
    } catch {
      // Group already gone, or not ours to signal — nothing to escalate.
    }
  }

  if (signalled.length > 0) {
    await sleep(graceMs)
    for (const pgid of signalled) {
      if (!groupAlive(pgid)) continue
      try {
        killGroup(pgid, 'SIGKILL')
        log(`[orphan-reaper] pgid=${pgid} ignored SIGTERM; escalated to SIGKILL`)
      } catch {
        // Raced with a natural exit.
      }
    }
  }

  const skipped = verdicts.length - doomed.length
  return {
    scanned: rows.length,
    reaped: groups.size,
    skipped,
    details: verdicts,
  }
}

/** One-line rendering of a sweep summary, for `[steward-tune]`-style logs. */
export const formatSweepSummary = (s: OrphanSweepSummary): string =>
  `scanned ${s.scanned}, reaped ${s.reaped} group(s), skipped ${s.skipped}`
