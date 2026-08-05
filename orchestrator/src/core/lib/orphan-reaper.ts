/**
 * Orphan reaper — the Steward's autonomous cleanup of leaked verify/test
 * subprocesses and abandoned agent sessions.
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
 * ## The incident the AGENT-SESSION rules exist for
 *
 * The reaper used to test one regex ({@link VERIFY_RUNNER_RE}) against the
 * FULL argv of every candidate. An agent CLI carries its entire task prompt in
 * argv (`claude -p '<prompt>'`), and a Mars coder prompt routinely names the
 * worktree path AND a verify command — `npx vitest run`, `tsc --noEmit`, `npm
 * run build`. So every long-running coder matched the "leaked test runner"
 * signature and got SIGTERMed by its own orchestrator at
 * {@link DEFAULT_MIN_AGE_SECONDS} + one sweep interval — around 14 minutes,
 * mid-implementation, with the work uncommitted.
 *
 * Three coders died this way before it was diagnosed (mars-95dc249a at 834 s,
 * mars-b5f5524c at 1508 s, mars-961d5d14 at 872 s; 2026-08-04/05). Two of them
 * spawned recovery tasks that inherited the same fate. The `task=` field in the
 * kill log read `mars-95dc249a\012\012Run`, which was the tell: the decoder had
 * walked off the end of a real id into the prompt body, so `task-not-in-flight`
 * was true for EVERY coder regardless of what the daemon had in flight.
 *
 * Three defects, all fixed here:
 *
 *  1. Agent sessions are now classified by argv[0] ({@link classifyCommand})
 *     and never matched against the verify-runner regex, so a prompt that
 *     merely MENTIONS vitest can no longer be mistaken for vitest.
 *  2. {@link taskIdFromCommand} accepts only a well-formed id charset, so a
 *     path embedded in prompt prose cannot yield a bogus "not in flight" id.
 *  3. An agent session is reaped on IDLENESS, never on age alone — see below.
 *
 * ## Two populations, two rules
 *
 * **Verify runners** are reaped on age, exactly as before. A leaked vitest is
 * typically busy (that was the whole incident: 43–73 % CPU), so idleness is
 * useless as a signal for them and the wall-clock threshold stays.
 *
 * **Agent sessions** are reaped only when the session has genuinely stopped
 * doing anything: no CPU progress anywhere in its process group for
 * {@link DEFAULT_AGENT_IDLE_SECONDS}. Group-wide accounting is what makes this
 * safe — an agent blocked in `read()` while `npm test` runs burns no CPU
 * itself, but its child does, and the child shares its process group. A hard
 * wall-clock cap is available via {@link DEFAULT_AGENT_MAX_AGE_SECONDS} and is
 * INFINITE by default: absent an explicit operator override, a working agent is
 * never killed for merely taking a long time.
 *
 * Idleness needs memory across sweeps — one `ps` sample cannot distinguish
 * "wedged" from "waiting on a slow API call". {@link updateActivityLedger}
 * keeps the last-progress timestamp per process group, so a session must look
 * idle across consecutive sweeps before it is eligible.
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
 *   never used to decide whether a process is busy. `ps -o time=` (cumulative
 *   CPU) sampled across sweeps IS a valid progress signal, and is what the
 *   idleness ledger uses.
 * - `ps` renders non-printable argv bytes as octal escapes, so a multi-line
 *   agent prompt arrives as one line containing literal `\012` sequences.
 *   {@link normalizeCommand} flattens them before anything is matched.
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
  /** Cumulative CPU time consumed by this process, in seconds. */
  cpuSeconds: number
  /** Full argv as reported by `ps -o command=`. */
  command: string
}

/**
 * What kind of process a candidate row is, decided from argv[0] alone.
 *
 * The distinction is load-bearing: a `verify-runner` is reaped on age, an
 * `agent-session` only on idleness. Deciding it from argv[0] — rather than
 * from a regex over the whole argv — is what stops an agent prompt that
 * mentions `vitest` from being classified as vitest.
 */
export type ProcessKind = 'verify-runner' | 'agent-session' | 'foreign'

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
  /** Agent session whose process group has made no CPU progress. */
  | 'agent-idle'
  /** Agent session past the operator-configured hard wall-clock cap. */
  | 'agent-max-age'
  /** Agent session still making progress — never reaped, however old. */
  | 'agent-active'

export interface OrphanVerdict {
  pid: number
  pgid: number
  ageSeconds: number
  command: string
  /** Task id decoded from the `.mars/worktrees/<task-id>/` path, when present. */
  taskId: string | null
  /** Which population this row belongs to, and therefore which rule applied. */
  kind: ProcessKind
  /** Seconds since this row's process group last made CPU progress; null when unknown. */
  idleSeconds: number | null
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
 *
 * Only ever tested against a row whose argv[0] is NOT an agent CLI. Agent
 * prompts quote these very commands; see the module header.
 */
const VERIFY_RUNNER_RE =
  /(?:^|[\s/])(?:vitest|jest|mocha|playwright|cypress|tsc)(?:$|[\s/.])|\b(?:npm|pnpm|yarn)\b[^\n]*\b(?:test|typecheck)\b/

/**
 * Executable basenames that mean "this process IS an agent session", matched
 * against argv[0] only. These carry their whole prompt in argv, so nothing
 * beyond argv[0] can be trusted as a signature.
 */
const AGENT_BINARIES = new Set(['claude', 'codex', 'gemini'])

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
 * `ps` escapes non-printable argv bytes as three-digit octal (`\012` for LF),
 * so a multi-line agent prompt arrives as ONE line peppered with literal
 * backslash-digit-digit-digit sequences. Flatten them to spaces before any
 * matching or id decoding, or a worktree path followed by a newline decodes as
 * the task id `mars-abc123\012\012Run`.
 */
const OCTAL_ESCAPE_RE = /\\[0-7]{3}/g

/** Collapse octal escapes and runs of whitespace so argv is one clean line. */
export const normalizeCommand = (command: string): string =>
  command.replace(OCTAL_ESCAPE_RE, ' ').replace(/\s+/g, ' ').trim()

/**
 * Decide which population a row belongs to, from argv[0] alone.
 *
 * argv[0] is the ONLY part of an agent CLI's argv that is not attacker- (or
 * rather prompt-) controlled. Everything after it may quote arbitrary shell
 * commands, so no signature regex may be applied to it.
 */
export const classifyCommand = (command: string): ProcessKind => {
  const normalized = normalizeCommand(command)
  const argv0 = normalized.split(' ')[0] ?? ''
  const binary = argv0.slice(argv0.lastIndexOf('/') + 1).replace(/\.(?:exe|cmd|bat)$/i, '')
  if (AGENT_BINARIES.has(binary)) return 'agent-session'
  return VERIFY_RUNNER_RE.test(normalized) ? 'verify-runner' : 'foreign'
}

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
 * Parse a `ps -o time=` field (cumulative CPU). Same shape as `etime` but with
 * an optional fractional-seconds tail: `19:52.14`, `1:03:07.99`, `2-04:11:07`.
 *
 * Returns `null` when unparseable. Callers treat `null` as "no progress
 * evidence", which keeps an unreadable row OUT of the reap path rather than
 * making it look permanently idle.
 */
export const parseCpuTimeSeconds = (raw: string): number | null => {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/)
  if (!m) return null
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const minutes = Number(m[3])
  const seconds = Number(m[4])
  const fraction = m[5] ? Number(`0.${m[5]}`) : 0
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds + fraction
}

/**
 * Parse one line of `ps -ww -o pid=,ppid=,pgid=,etime=,time=,command=` output.
 * Returns `null` for blank or malformed lines.
 */
export const parsePsLine = (line: string): ProcessRow | null => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
  if (!m) return null
  const ageSeconds = parseEtimeSeconds(m[4])
  if (ageSeconds === null) return null
  const cpuSeconds = parseCpuTimeSeconds(m[5])
  if (cpuSeconds === null) return null
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    pgid: Number(m[3]),
    ageSeconds,
    cpuSeconds,
    command: m[6],
  }
}

/**
 * Decode the task id from an argv that points inside `<worktreesRoot>/<id>/…`.
 * Returns `null` when the argv does not reference the tree at all.
 *
 * Only the task-id charset (`[A-Za-z0-9._-]`) is accepted, so a worktree path
 * quoted inside an agent prompt yields the real id and stops there. The old
 * "read to the next slash or whitespace" rule ran past the end of the id into
 * prompt prose — producing ids no in-flight set could ever contain, which made
 * `task-not-in-flight` fire for every coder. See the module header.
 */
export const taskIdFromCommand = (
  command: string,
  worktreesRoot: string,
): string | null => {
  const needle = `${worktreesRoot}/`
  const normalized = normalizeCommand(command)
  const at = normalized.indexOf(needle)
  if (at === -1) return null
  const id = normalized.slice(at + needle.length).match(/^[A-Za-z0-9._-]+/)?.[0]
  return id !== undefined && id.length > 0 ? id : null
}

export interface JudgeOptions {
  /** Absolute path of `<repo>/.mars/worktrees` — scopes the sweep to this repo. */
  worktreesRoot: string
  /** Task ids the daemon currently has in flight; their processes are healthy. */
  inFlightTaskIds: ReadonlySet<string>
  /** Nothing younger than this is ever reaped. Verify runners only. */
  minAgeSeconds: number
  /** Pids that must never be signalled (the daemon, its parent). */
  protectedPids: ReadonlySet<number>
  /** The reaper's own process group, when known. Never signalled. */
  protectedPgid: number | null
  /**
   * How long an agent session's process group must show zero CPU progress
   * before it is eligible for reaping.
   */
  agentIdleSeconds: number
  /**
   * Hard wall-clock cap for agent sessions. `Infinity` (the default) means a
   * session is never reaped for age alone — only for idleness.
   */
  agentMaxAgeSeconds: number
  /**
   * pgid → seconds since that process group last made CPU progress.
   * A group absent from the map has no progress history yet and is treated as
   * active: silence that has not been OBSERVED across sweeps is not evidence.
   */
  idleSecondsByGroup: ReadonlyMap<number, number>
}

/**
 * Pure classifier: decide whether one process row is a genuine orphan.
 *
 * Common preconditions — a row is only ever a candidate when:
 *   1. its argv points inside this repo's `.mars/worktrees/` tree AND argv[0]
 *      identifies it as either a verify runner or an agent session;
 *   2. it is neither the reaper's own process nor in the reaper's group.
 *
 * A **verify runner** is then reaped when it is older than `minAgeSeconds` AND
 * is either reparented to init or belongs to a task that is no longer in
 * flight. (Unchanged: a leaked test runner is usually busy, so idleness cannot
 * be used to detect it.)
 *
 * An **agent session** is reaped when it is past `agentMaxAgeSeconds`
 * (`Infinity` by default, i.e. never), or when its process group has been idle
 * for at least `agentIdleSeconds` AND it is reparented or no longer in flight.
 * A session still making progress is spared no matter how long it has run.
 */
export const judgeProcess = (
  row: ProcessRow,
  opts: JudgeOptions,
): OrphanVerdict => {
  const taskId = taskIdFromCommand(row.command, opts.worktreesRoot)
  const kind = classifyCommand(row.command)
  const idleSeconds = opts.idleSecondsByGroup.get(row.pgid) ?? null
  const base = {
    pid: row.pid,
    pgid: row.pgid,
    ageSeconds: row.ageSeconds,
    command: row.command,
    taskId,
    kind,
    idleSeconds,
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

  if (taskId === null || kind === 'foreign') {
    return skip('not-orchestrator-owned')
  }
  if (
    opts.protectedPids.has(row.pid) ||
    (opts.protectedPgid !== null && row.pgid === opts.protectedPgid)
  ) {
    return skip('self')
  }

  /** Ownership test shared by both populations: is anyone still minding it? */
  const abandoned = (): OrphanVerdict => {
    if (row.ppid === 1) return reap('reparented')
    if (!opts.inFlightTaskIds.has(taskId)) return reap('task-not-in-flight')
    return skip('live-parent')
  }

  if (kind === 'agent-session') {
    // The operator's explicit wall-clock override wins over every other
    // consideration. Infinite by default, so this branch is normally dead.
    if (row.ageSeconds >= opts.agentMaxAgeSeconds) return reap('agent-max-age')
    // No observed idleness, or not idle long enough: the session is working.
    // A long run is not a stuck run.
    if (idleSeconds === null || idleSeconds < opts.agentIdleSeconds) {
      return skip('agent-active')
    }
    const verdict = abandoned()
    // Preserve the sharper reason on the reap path: an idle session that is
    // also abandoned is reported as 'agent-idle' so the log says WHY the
    // idleness rule — not the age rule — allowed the kill.
    return verdict.verdict === 'reap' ? reap('agent-idle') : verdict
  }

  if (row.ageSeconds < opts.minAgeSeconds) return skip('too-young')
  return abandoned()
}

/**
 * Classify a whole process table. Exported separately from {@link sweepOrphans}
 * so the decision logic can be exercised against fixtures with no I/O at all.
 */
export const judgeProcessTable = (
  rows: readonly ProcessRow[],
  opts: JudgeOptions,
): readonly OrphanVerdict[] => rows.map((row) => judgeProcess(row, opts))

// ── Activity ledger ─────────────────────────────────────────────────────────

/** Cumulative CPU of a process group, plus when it last advanced. */
export interface GroupActivity {
  /** Sum of cumulative CPU seconds across every member of the group. */
  cpuSeconds: number
  /** Epoch ms at which `cpuSeconds` was last observed to increase. */
  lastProgressAtMs: number
}

export type ActivityLedger = Map<number, GroupActivity>

/**
 * Fold a fresh CPU sample into the ledger and return the updated one.
 *
 * A group whose CPU total rose since the previous sweep is stamped active
 * *now*. A group whose total is unchanged keeps its previous timestamp, so
 * idleness accumulates across sweeps rather than being decided by a single
 * sample — which is the whole point: one sample cannot tell a wedged agent
 * from one waiting on a slow API call.
 *
 * Groups absent from the sample are dropped; their processes are gone.
 * Pure: the input ledger is never mutated.
 */
export const updateActivityLedger = (
  sample: ReadonlyMap<number, number>,
  previous: ReadonlyMap<number, GroupActivity>,
  nowMs: number,
): ActivityLedger => {
  const next: ActivityLedger = new Map()
  for (const [pgid, cpuSeconds] of sample) {
    const prior = previous.get(pgid)
    const progressed = prior === undefined || cpuSeconds > prior.cpuSeconds
    next.set(pgid, {
      cpuSeconds,
      lastProgressAtMs: progressed ? nowMs : prior.lastProgressAtMs,
    })
  }
  return next
}

/**
 * Derive "seconds since last progress" per group from a ledger.
 *
 * A group first seen in this very sweep yields 0 — never a large number — so a
 * cold ledger (first sweep after a daemon start) can never reap anything for
 * idleness. Idleness must be *observed*, not assumed.
 */
export const idleSecondsFromLedger = (
  ledger: ReadonlyMap<number, GroupActivity>,
  nowMs: number,
): ReadonlyMap<number, number> => {
  const out = new Map<number, number>()
  for (const [pgid, activity] of ledger) {
    out.set(pgid, Math.max(0, Math.round((nowMs - activity.lastProgressAtMs) / 1000)))
  }
  return out
}

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
      ['-ww', '-o', 'pid=,ppid=,pgid=,etime=,time=,command=', '-p', pids.join(',')],
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

/**
 * Sum cumulative CPU seconds per process group across EVERY process on the
 * machine.
 *
 * Group-wide, not per-candidate, and deliberately so: an agent blocked reading
 * its child's stdout accrues no CPU of its own while `npm test` grinds away in
 * the same process group. Charging the child's CPU to the group is what stops
 * "agent is waiting on a long build" from reading as "agent is wedged". It also
 * catches descendants that `pgrep -f .mars/worktrees` never matched, because
 * their own argv does not mention the worktree.
 *
 * One `ps` per sweep. Returns an empty map on failure, which reads downstream
 * as "no progress evidence" and therefore spares everything.
 */
export const readGroupCpuSeconds = async (): Promise<ReadonlyMap<number, number>> => {
  const totals = new Map<number, number>()
  let out = ''
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pgid=,time='], {
      maxBuffer: PS_MAX_BUFFER,
    })
    out = stdout
  } catch {
    return totals
  }
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/)
    if (!m) continue
    const cpu = parseCpuTimeSeconds(m[2])
    if (cpu === null) continue
    const pgid = Number(m[1])
    totals.set(pgid, (totals.get(pgid) ?? 0) + cpu)
  }
  return totals
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
 * Default conservative age threshold for VERIFY RUNNERS. Production orphans
 * were 187–249 minutes old; ten minutes is far below that yet comfortably
 * above any legitimate verify step (the integration gate's own ceiling is ~2
 * minutes).
 *
 * This threshold does NOT apply to agent sessions — applying it to them is
 * exactly the bug documented in the module header.
 */
export const DEFAULT_MIN_AGE_SECONDS = Number(
  process.env.MARS_ORPHAN_MIN_AGE_SECONDS ?? 600,
)

/**
 * How long an agent session's process group must show zero CPU progress before
 * the reaper will consider it. Fifteen minutes: comfortably longer than any
 * single model round-trip (including a long extended-thinking turn or a
 * retried rate-limited request), far shorter than a wedged session left
 * overnight. Override with `MARS_AGENT_IDLE_SECONDS`.
 */
export const DEFAULT_AGENT_IDLE_SECONDS = Number(
  process.env.MARS_AGENT_IDLE_SECONDS ?? 900,
)

/**
 * Hard wall-clock cap for agent sessions — **infinite by default**.
 *
 * A coder that has been working for three hours is doing exactly what it was
 * asked to do; killing it discards the work and spawns a recovery task that
 * starts from nothing. So there is no default time limit: only the idleness
 * rule can reap a session unless an operator opts in.
 *
 * Set `MARS_AGENT_MAX_AGE_SECONDS` to a positive number of seconds to impose
 * one. `0`, `infinite`, `none`, and any unparseable value all mean no cap.
 */
export const resolveAgentMaxAgeSeconds = (
  raw: string | undefined = process.env.MARS_AGENT_MAX_AGE_SECONDS,
): number => {
  if (raw === undefined || raw.trim() === '') return Infinity
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'infinite' || normalized === 'infinity' || normalized === 'none') {
    return Infinity
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity
}

export const DEFAULT_AGENT_MAX_AGE_SECONDS = resolveAgentMaxAgeSeconds()

/** Grace between the group SIGTERM and the escalation to SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = Number(
  process.env.MARS_ORPHAN_KILL_GRACE_MS ?? 2_000,
)

/**
 * Process-group activity history, retained between sweeps so idleness can be
 * measured rather than guessed. Module-level because the daemon calls
 * {@link sweepOrphans} from three sites (boot, periodic interval, autotuner
 * hold path) and they must share one history; tests inject their own.
 */
const sharedActivityLedger: ActivityLedger = new Map()

export interface OrphanSweepOptions {
  /** Repo root; `<repoRoot>/.mars/worktrees` scopes the sweep. */
  repoRoot: string
  /** Task ids currently in flight — their subprocesses are healthy. */
  inFlightTaskIds: ReadonlySet<string>
  minAgeSeconds?: number
  agentIdleSeconds?: number
  agentMaxAgeSeconds?: number
  graceMs?: number
  log?: (line: string) => void
  // ── injected side effects (tests pass fakes so no real pid is signalled) ──
  listProcesses?: () => Promise<readonly ProcessRow[]>
  groupCpuSeconds?: () => Promise<ReadonlyMap<number, number>>
  /** Persistent progress history. Defaults to the module-level ledger. */
  activityLedger?: ActivityLedger
  nowMs?: () => number
  ownPgid?: () => Promise<number | null>
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void
  groupAlive?: (pgid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

/**
 * Detect and reap orphaned verify/test subprocesses and abandoned agent
 * sessions.
 *
 * Each reaped group gets a SIGTERM to `-pgid` (so descendants die with the
 * leader) and, after `graceMs`, a SIGKILL if anything in the group survived —
 * a child that ignores SIGTERM must not be able to keep the group alive.
 *
 * Every kill is logged with pid, age, idle time, and the reason the process was
 * judged an orphan. Returns a structured summary so callers can log and act on
 * it.
 */
export const sweepOrphans = async (
  opts: OrphanSweepOptions,
): Promise<OrphanSweepSummary> => {
  const listProcesses = opts.listProcesses ?? listCandidateProcesses
  const groupCpuSeconds = opts.groupCpuSeconds ?? readGroupCpuSeconds
  const killGroup = opts.killGroup ?? defaultKillGroup
  const groupAlive = opts.groupAlive ?? defaultGroupAlive
  const sleep = opts.sleep ?? defaultSleep
  const ownPgid = opts.ownPgid ?? readOwnPgid
  const now = opts.nowMs ?? Date.now
  const ledger = opts.activityLedger ?? sharedActivityLedger
  const log = opts.log ?? ((): void => {})
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS

  const rows = await listProcesses()

  // Fold the CPU sample into the ledger on EVERY sweep, including sweeps with
  // no candidates. Skipping it would leave a stale history behind and let a
  // group that idled while unmatched look instantly reapable when it
  // reappears.
  const nowMs = now()
  const refreshed = updateActivityLedger(await groupCpuSeconds(), ledger, nowMs)
  ledger.clear()
  for (const [pgid, activity] of refreshed) ledger.set(pgid, activity)

  if (rows.length === 0) {
    return { scanned: 0, reaped: 0, skipped: 0, details: [] }
  }

  const verdicts = judgeProcessTable(rows, {
    worktreesRoot: `${opts.repoRoot.replace(/\/$/, '')}/.mars/worktrees`,
    inFlightTaskIds: opts.inFlightTaskIds,
    minAgeSeconds: opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS,
    agentIdleSeconds: opts.agentIdleSeconds ?? DEFAULT_AGENT_IDLE_SECONDS,
    agentMaxAgeSeconds: opts.agentMaxAgeSeconds ?? DEFAULT_AGENT_MAX_AGE_SECONDS,
    idleSecondsByGroup: idleSecondsFromLedger(ledger, nowMs),
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
      `[orphan-reaper] reaping pid=${v.pid} pgid=${v.pgid} kind=${v.kind} age=${v.ageSeconds}s idle=${v.idleSeconds ?? '?'}s task=${v.taskId ?? '?'} reason=${v.reason} cmd=${normalizeCommand(v.command).slice(0, 160)}`,
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
