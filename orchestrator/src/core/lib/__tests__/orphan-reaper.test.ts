import { describe, it, expect, vi } from 'vitest'
import {
  classifyCommand,
  DEFAULT_AGENT_IDLE_SECONDS,
  DEFAULT_AGENT_MAX_AGE_SECONDS,
  DEFAULT_MIN_AGE_SECONDS,
  formatSweepSummary,
  idleSecondsFromLedger,
  judgeProcess,
  judgeProcessTable,
  normalizeCommand,
  parseCpuTimeSeconds,
  parseEtimeSeconds,
  parsePsLine,
  resolveAgentMaxAgeSeconds,
  sweepOrphans,
  taskIdFromCommand,
  updateActivityLedger,
  type ActivityLedger,
  type JudgeOptions,
  type ProcessRow,
} from '../orphan-reaper'

/**
 * Every test here works against a FIXTURE process table. Nothing shells out to
 * `ps`/`pgrep`, and the kill path is always injected, so no real pid is ever
 * signalled — reaping the machine's own vitest run would be memorable.
 */

const REPO = '/Users/dev/mars-framework'
const WORKTREES = `${REPO}/.mars/worktrees`

const row = (over: Partial<ProcessRow> = {}): ProcessRow => ({
  pid: 4242,
  ppid: 1,
  pgid: 4242,
  ageSeconds: 11_000,
  cpuSeconds: 900,
  command: `node ${WORKTREES}/mars-abc123/node_modules/vitest/dist/worker.js`,
  ...over,
})

const opts = (over: Partial<JudgeOptions> = {}): JudgeOptions => ({
  worktreesRoot: WORKTREES,
  inFlightTaskIds: new Set<string>(),
  minAgeSeconds: 600,
  protectedPids: new Set<number>(),
  protectedPgid: null,
  agentIdleSeconds: 900,
  agentMaxAgeSeconds: Infinity,
  idleSecondsByGroup: new Map<number, number>(),
  ...over,
})

/**
 * The real argv of a dispatched coder. `ps` renders the embedded prompt's
 * newlines as octal escapes, and a Mars coder prompt names both the worktree
 * and the verify command — which is precisely why the old whole-argv regex
 * classified every coder as a leaked test runner.
 */
const CODER_ARGV =
  `/opt/homebrew/bin/claude -p ## Commit exit condition\\012\\012This run is not complete until ` +
  `\`git rev-list --count main..HEAD\` returns greater than 0.\\012\\012Work in ` +
  `${WORKTREES}/mars-abc123 and verify with \`npx tsc --noEmit && npm run build && npx vitest run\`.`

describe('parseEtimeSeconds (macOS `ps -o etime=`, since `etimes` is Linux-only)', () => {
  it('parses mm:ss', () => {
    expect(parseEtimeSeconds('07:31')).toBe(451)
  })

  it('parses hh:mm:ss', () => {
    expect(parseEtimeSeconds('03:07:29')).toBe(11_249)
  })

  it('parses dd-hh:mm:ss', () => {
    expect(parseEtimeSeconds('04-03:54:37')).toBe(4 * 86_400 + 3 * 3_600 + 54 * 60 + 37)
  })

  it('tolerates leading whitespace from column-aligned ps output', () => {
    expect(parseEtimeSeconds('   12:00 ')).toBe(720)
  })

  it('returns null (never 0) for an unparseable field, so it cannot look brand new', () => {
    expect(parseEtimeSeconds('')).toBeNull()
    expect(parseEtimeSeconds('-')).toBeNull()
    expect(parseEtimeSeconds('11249')).toBeNull()
  })
})

describe('parseCpuTimeSeconds (`ps -o time=`, which carries a fractional tail)', () => {
  it('parses mm:ss.ff as macOS prints it', () => {
    expect(parseCpuTimeSeconds('19:52.14')).toBeCloseTo(19 * 60 + 52.14, 5)
  })

  it('parses hh:mm:ss', () => {
    expect(parseCpuTimeSeconds('1:03:07')).toBe(3_787)
  })

  it('parses a zero sample', () => {
    expect(parseCpuTimeSeconds('0:00.00')).toBe(0)
  })

  it('returns null for an unparseable field rather than a bogus zero', () => {
    // A bogus 0 would read as "no CPU consumed", making a busy process look idle.
    expect(parseCpuTimeSeconds('-')).toBeNull()
    expect(parseCpuTimeSeconds('')).toBeNull()
  })
})

describe('normalizeCommand', () => {
  it('flattens the octal escapes `ps` uses for newlines in an argv', () => {
    expect(normalizeCommand('claude -p line one\\012\\012line two')).toBe(
      'claude -p line one line two',
    )
  })

  it('collapses whitespace runs so matching sees one clean line', () => {
    expect(normalizeCommand('  node    a.js   --flag  ')).toBe('node a.js --flag')
  })
})

describe('classifyCommand — the argv[0] rule that keeps prompts out of matching', () => {
  it('classifies a real test runner as a verify runner', () => {
    expect(
      classifyCommand(`node ${WORKTREES}/mars-abc123/node_modules/.bin/vitest run`),
    ).toBe('verify-runner')
  })

  it('classifies an agent CLI as an agent session, whatever its prompt says', () => {
    expect(classifyCommand(CODER_ARGV)).toBe('agent-session')
  })

  it('does not let a prompt that quotes `vitest` turn a coder into a runner', () => {
    // The regression that killed three coders: the prompt below mentions every
    // verify runner there is, and none of it may count.
    expect(
      classifyCommand('claude -p run `npx vitest run` and `tsc --noEmit` when done'),
    ).toBe('agent-session')
  })

  it('recognises every agent CLI by basename, including absolute paths', () => {
    expect(classifyCommand('/opt/homebrew/bin/claude -p hi')).toBe('agent-session')
    expect(classifyCommand('/usr/local/bin/codex exec do the thing')).toBe('agent-session')
    expect(classifyCommand('gemini -p hi')).toBe('agent-session')
  })

  it('classifies anything else as foreign', () => {
    expect(classifyCommand('node server.js')).toBe('foreign')
    expect(classifyCommand('/bin/zsh -l')).toBe('foreign')
  })
})

describe('parsePsLine', () => {
  it('parses a full row and keeps the whole argv', () => {
    const parsed = parsePsLine(
      `  91234  1  91234 03:07:29 19:52.14 node ${WORKTREES}/mars-abc123/node_modules/.bin/vitest run --reporter=dot`,
    )
    expect(parsed).toEqual({
      pid: 91234,
      ppid: 1,
      pgid: 91234,
      ageSeconds: 11_249,
      cpuSeconds: 19 * 60 + 52.14,
      command: `node ${WORKTREES}/mars-abc123/node_modules/.bin/vitest run --reporter=dot`,
    })
  })

  it('returns null for blank and malformed lines', () => {
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('   ')).toBeNull()
    expect(parsePsLine('not a ps row')).toBeNull()
  })

  it('returns null when the etime field is unparseable rather than guessing an age', () => {
    expect(parsePsLine('1 1 1 ?? 0:00.00 node vitest')).toBeNull()
  })

  it('returns null when the cpu-time field is unparseable', () => {
    expect(parsePsLine('1 1 1 03:07:29 ?? node vitest')).toBeNull()
  })
})

describe('taskIdFromCommand', () => {
  it('decodes the task id from a worktree path', () => {
    expect(
      taskIdFromCommand(`node ${WORKTREES}/mars-abc123/node_modules/vitest`, WORKTREES),
    ).toBe('mars-abc123')
  })

  it('decodes a task id at the end of the argv', () => {
    expect(taskIdFromCommand(`sh -c cd ${WORKTREES}/mars-xyz`, WORKTREES)).toBe('mars-xyz')
  })

  it('stops at the end of the id when the path is quoted inside prompt prose', () => {
    // The old decoder read to the next slash-or-whitespace and produced
    // `mars-abc123\012\012Run`, an id no in-flight set could ever contain — so
    // `task-not-in-flight` was true for every coder. Observed in production.
    expect(taskIdFromCommand(CODER_ARGV, WORKTREES)).toBe('mars-abc123')
    expect(
      taskIdFromCommand(`claude -p cd ${WORKTREES}/mars-abc123\\012\\012Run the suite`, WORKTREES),
    ).toBe('mars-abc123')
  })

  it('returns null for an unrelated argv', () => {
    expect(taskIdFromCommand('node /somewhere/else/vitest', WORKTREES)).toBeNull()
  })

  it('returns null for another repo’s worktrees (the sweep is repo-scoped)', () => {
    expect(
      taskIdFromCommand('node /other/repo/.mars/worktrees/mars-zzz/vitest', WORKTREES),
    ).toBeNull()
  })
})

describe('judgeProcess — verify runners are reaped on age, as before', () => {
  it('reaps a reparented vitest under a Mars worktree', () => {
    const v = judgeProcess(row({ ppid: 1 }), opts())
    expect(v.verdict).toBe('reap')
    expect(v.reason).toBe('reparented')
    expect(v.taskId).toBe('mars-abc123')
    expect(v.kind).toBe('verify-runner')
  })

  it('reaps a live-parented runner whose task is no longer in flight', () => {
    const v = judgeProcess(row({ ppid: 500 }), opts({ inFlightTaskIds: new Set(['mars-other']) }))
    expect(v.verdict).toBe('reap')
    expect(v.reason).toBe('task-not-in-flight')
  })

  it('spares a runner whose task IS in flight', () => {
    const v = judgeProcess(
      row({ ppid: 500 }),
      opts({ inFlightTaskIds: new Set(['mars-abc123']) }),
    )
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('live-parent')
  })

  it('spares a healthy long-running suite that is younger than the age threshold', () => {
    const v = judgeProcess(row({ ppid: 1, ageSeconds: 120 }), opts({ minAgeSeconds: 600 }))
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('too-young')
  })

  it('applies the age gate even to a reparented process (conservative by design)', () => {
    expect(judgeProcess(row({ ppid: 1, ageSeconds: 599 }), opts()).verdict).toBe('skip')
    expect(judgeProcess(row({ ppid: 1, ageSeconds: 601 }), opts()).verdict).toBe('reap')
  })

  it('reaps a BUSY leaked runner — idleness is not required for this population', () => {
    // The original incident was 15 vitest processes at 43–73 % CPU. Gating them
    // on idleness would have left every one of them running.
    const v = judgeProcess(
      row({ ppid: 1 }),
      opts({ idleSecondsByGroup: new Map([[4242, 0]]) }),
    )
    expect(v.verdict).toBe('reap')
  })

  it('ignores a vitest that is NOT under a Mars worktree', () => {
    const v = judgeProcess(
      row({ command: 'node /Users/dev/other-project/node_modules/.bin/vitest run' }),
      opts(),
    )
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('not-orchestrator-owned')
  })

  it("ignores another repo's worktree processes", () => {
    const v = judgeProcess(
      row({ command: 'node /elsewhere/.mars/worktrees/mars-abc123/node_modules/vitest' }),
      opts(),
    )
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('not-orchestrator-owned')
  })

  it('recognises the other verify runners, not just vitest', () => {
    for (const cmd of [
      `node ${WORKTREES}/mars-abc123/node_modules/.bin/tsc --noEmit`,
      `node ${WORKTREES}/mars-abc123/node_modules/.bin/jest --ci`,
      `node ${WORKTREES}/mars-abc123/node_modules/.bin/playwright test`,
      `npm --prefix ${WORKTREES}/mars-abc123 run test`,
    ]) {
      expect(judgeProcess(row({ command: cmd }), opts()).verdict, cmd).toBe('reap')
    }
  })

  it('never touches the reaper’s own pid or process group', () => {
    expect(judgeProcess(row({ pid: 777 }), opts({ protectedPids: new Set([777]) })).reason).toBe(
      'self',
    )
    expect(judgeProcess(row({ pgid: 900 }), opts({ protectedPgid: 900 })).reason).toBe('self')
  })

  it('classifies a whole fixture table', () => {
    const rows: ProcessRow[] = [
      row({ pid: 1, pgid: 1 }),
      row({ pid: 2, pgid: 2, ageSeconds: 5 }),
      row({ pid: 3, pgid: 3, command: 'node /elsewhere/vitest' }),
    ]
    expect(judgeProcessTable(rows, opts()).map((v) => v.verdict)).toEqual([
      'reap',
      'skip',
      'skip',
    ])
  })
})

describe('judgeProcess — agent sessions are reaped on idleness, never on age', () => {
  const coder = (over: Partial<ProcessRow> = {}): ProcessRow =>
    row({ pid: 900, pgid: 900, command: CODER_ARGV, ...over })

  it('spares a coder that has been working for hours', () => {
    // The exact regression: mars-b5f5524c was SIGTERMed at 1508 s mid-run.
    const v = judgeProcess(
      coder({ ppid: 1, ageSeconds: 11_000 }),
      opts({ idleSecondsByGroup: new Map([[900, 30]]) }),
    )
    expect(v.kind).toBe('agent-session')
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('agent-active')
  })

  it('spares a coder with no observed idleness history at all', () => {
    // A cold ledger must never be read as "silent forever".
    const v = judgeProcess(coder({ ppid: 1 }), opts({ idleSecondsByGroup: new Map() }))
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('agent-active')
    expect(v.idleSeconds).toBeNull()
  })

  it('spares a coder idle for less than the threshold (a slow model round-trip)', () => {
    const v = judgeProcess(
      coder({ ppid: 1 }),
      opts({ agentIdleSeconds: 900, idleSecondsByGroup: new Map([[900, 899]]) }),
    )
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('agent-active')
  })

  it('reaps a reparented coder once it has been idle past the threshold', () => {
    const v = judgeProcess(
      coder({ ppid: 1 }),
      opts({ agentIdleSeconds: 900, idleSecondsByGroup: new Map([[900, 901]]) }),
    )
    expect(v.verdict).toBe('reap')
    expect(v.reason).toBe('agent-idle')
  })

  it('reaps an idle coder whose task is no longer in flight', () => {
    const v = judgeProcess(
      coder({ ppid: 500 }),
      opts({
        agentIdleSeconds: 900,
        idleSecondsByGroup: new Map([[900, 1_800]]),
        inFlightTaskIds: new Set(['mars-other']),
      }),
    )
    expect(v.verdict).toBe('reap')
    expect(v.reason).toBe('agent-idle')
  })

  it('spares an idle coder that is still in flight — the phantom watchdog owns it', () => {
    const v = judgeProcess(
      coder({ ppid: 500 }),
      opts({
        agentIdleSeconds: 900,
        idleSecondsByGroup: new Map([[900, 1_800]]),
        inFlightTaskIds: new Set(['mars-abc123']),
      }),
    )
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('live-parent')
  })

  it('never reaps on age when the cap is infinite, however old the session is', () => {
    const v = judgeProcess(
      coder({ ppid: 1, ageSeconds: 86_400 }),
      opts({ agentMaxAgeSeconds: Infinity, idleSecondsByGroup: new Map([[900, 0]]) }),
    )
    expect(v.verdict).toBe('skip')
  })

  it('honours an operator-configured hard cap ahead of every other rule', () => {
    const v = judgeProcess(
      coder({ ppid: 500, ageSeconds: 3_601 }),
      opts({
        agentMaxAgeSeconds: 3_600,
        idleSecondsByGroup: new Map([[900, 0]]),
        inFlightTaskIds: new Set(['mars-abc123']),
      }),
    )
    expect(v.verdict).toBe('reap')
    expect(v.reason).toBe('agent-max-age')
  })

  it('spares an agent whose argv does not name a worktree at all', () => {
    // A developer's own interactive session must never be a candidate.
    const v = judgeProcess(coder({ command: 'claude -p fix the bug' }), opts())
    expect(v.verdict).toBe('skip')
    expect(v.reason).toBe('not-orchestrator-owned')
  })
})

describe('activity ledger', () => {
  it('stamps a newly seen group as active now', () => {
    const next = updateActivityLedger(new Map([[10, 5]]), new Map(), 1_000)
    expect(next.get(10)).toEqual({ cpuSeconds: 5, lastProgressAtMs: 1_000 })
  })

  it('re-stamps a group whose cpu total rose', () => {
    const prior: ActivityLedger = new Map([[10, { cpuSeconds: 5, lastProgressAtMs: 1_000 }]])
    const next = updateActivityLedger(new Map([[10, 6]]), prior, 9_000)
    expect(next.get(10)).toEqual({ cpuSeconds: 6, lastProgressAtMs: 9_000 })
  })

  it('keeps the old timestamp when cpu did not move, so idleness accumulates', () => {
    const prior: ActivityLedger = new Map([[10, { cpuSeconds: 5, lastProgressAtMs: 1_000 }]])
    const next = updateActivityLedger(new Map([[10, 5]]), prior, 9_000)
    expect(next.get(10)).toEqual({ cpuSeconds: 5, lastProgressAtMs: 1_000 })
  })

  it('drops groups that are no longer present', () => {
    const prior: ActivityLedger = new Map([[10, { cpuSeconds: 5, lastProgressAtMs: 1_000 }]])
    expect(updateActivityLedger(new Map(), prior, 9_000).has(10)).toBe(false)
  })

  it('never mutates the ledger it was given', () => {
    const prior: ActivityLedger = new Map([[10, { cpuSeconds: 5, lastProgressAtMs: 1_000 }]])
    updateActivityLedger(new Map([[10, 99]]), prior, 9_000)
    expect(prior.get(10)).toEqual({ cpuSeconds: 5, lastProgressAtMs: 1_000 })
  })

  it('derives idle seconds, flooring at zero', () => {
    const ledger: ActivityLedger = new Map([
      [10, { cpuSeconds: 5, lastProgressAtMs: 1_000 }],
      [11, { cpuSeconds: 5, lastProgressAtMs: 61_000 }],
    ])
    const idle = idleSecondsFromLedger(ledger, 61_000)
    expect(idle.get(10)).toBe(60)
    expect(idle.get(11)).toBe(0)
  })
})

describe('resolveAgentMaxAgeSeconds', () => {
  it('is infinite when unset — a working agent is never killed for taking long', () => {
    expect(resolveAgentMaxAgeSeconds(undefined)).toBe(Infinity)
    expect(resolveAgentMaxAgeSeconds('')).toBe(Infinity)
    expect(resolveAgentMaxAgeSeconds('   ')).toBe(Infinity)
  })

  it('accepts the explicit no-cap spellings', () => {
    expect(resolveAgentMaxAgeSeconds('infinite')).toBe(Infinity)
    expect(resolveAgentMaxAgeSeconds('Infinity')).toBe(Infinity)
    expect(resolveAgentMaxAgeSeconds('none')).toBe(Infinity)
  })

  it('accepts a positive number of seconds', () => {
    expect(resolveAgentMaxAgeSeconds('3600')).toBe(3_600)
  })

  it('falls back to infinite for zero, negatives, and nonsense', () => {
    expect(resolveAgentMaxAgeSeconds('0')).toBe(Infinity)
    expect(resolveAgentMaxAgeSeconds('-5')).toBe(Infinity)
    expect(resolveAgentMaxAgeSeconds('soon')).toBe(Infinity)
  })
})

describe('sweepOrphans', () => {
  const sweepWith = async (
    rows: readonly ProcessRow[],
    over: {
      inFlight?: ReadonlySet<string>
      alive?: (pgid: number) => boolean
      groupCpu?: ReadonlyMap<number, number>
      ledger?: ActivityLedger
      nowMs?: number
      agentIdleSeconds?: number
    } = {},
  ) => {
    const kills: Array<{ pgid: number; signal: NodeJS.Signals }> = []
    const logs: string[] = []
    const summary = await sweepOrphans({
      repoRoot: REPO,
      inFlightTaskIds: over.inFlight ?? new Set<string>(),
      minAgeSeconds: 600,
      agentIdleSeconds: over.agentIdleSeconds ?? 900,
      agentMaxAgeSeconds: Infinity,
      graceMs: 0,
      log: (l) => logs.push(l),
      listProcesses: () => Promise.resolve(rows),
      groupCpuSeconds: () => Promise.resolve(over.groupCpu ?? new Map()),
      activityLedger: over.ledger ?? new Map(),
      nowMs: () => over.nowMs ?? 0,
      ownPgid: () => Promise.resolve(null),
      killGroup: (pgid, signal) => {
        kills.push({ pgid, signal })
      },
      groupAlive: over.alive ?? ((): boolean => false),
      sleep: () => Promise.resolve(),
    })
    return { summary, kills, logs }
  }

  it('returns an empty summary when nothing matches', async () => {
    const { summary, kills } = await sweepWith([])
    expect(summary).toEqual({ scanned: 0, reaped: 0, skipped: 0, details: [] })
    expect(kills).toEqual([])
  })

  it('kills by process GROUP, not by pid', async () => {
    const { kills } = await sweepWith([row({ pid: 4242, pgid: 4242 })])
    expect(kills).toEqual([{ pgid: 4242, signal: 'SIGTERM' }])
  })

  it('signals each group once even when several rows share it', async () => {
    const { summary, kills } = await sweepWith([
      row({ pid: 10, pgid: 10 }),
      row({ pid: 11, pgid: 10 }),
      row({ pid: 12, pgid: 10 }),
    ])
    expect(kills.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1)
    expect(summary.scanned).toBe(3)
    expect(summary.reaped).toBe(1)
  })

  it('escalates to SIGKILL when the group survives SIGTERM', async () => {
    const { kills, logs } = await sweepWith([row({ pid: 55, pgid: 55 })], {
      alive: () => true,
    })
    expect(kills).toEqual([
      { pgid: 55, signal: 'SIGTERM' },
      { pgid: 55, signal: 'SIGKILL' },
    ])
    expect(logs.join('\n')).toContain('escalated to SIGKILL')
  })

  it('does not escalate when the group died on SIGTERM', async () => {
    const { kills } = await sweepWith([row({ pid: 55, pgid: 55 })], { alive: () => false })
    expect(kills.map((k) => k.signal)).toEqual(['SIGTERM'])
  })

  it('logs pid, age, idle time, kind, and the orphan reason for every kill', async () => {
    const { logs } = await sweepWith([row({ pid: 91234, pgid: 91234, ageSeconds: 11_249 })])
    const line = logs.find((l) => l.includes('reaping'))
    expect(line).toBeDefined()
    expect(line).toContain('pid=91234')
    expect(line).toContain('age=11249s')
    expect(line).toContain('kind=verify-runner')
    expect(line).toContain('reason=reparented')
  })

  it('logs a flattened one-line argv, not a prompt full of octal escapes', async () => {
    const { logs } = await sweepWith([
      row({ pid: 1, pgid: 1, command: `node ${WORKTREES}/mars-abc123/.bin/vitest\\012run` }),
    ])
    const line = logs.find((l) => l.includes('reaping'))
    expect(line).not.toContain('\\012')
  })

  it('returns a structured summary callers can act on', async () => {
    const { summary } = await sweepWith(
      [
        row({ pid: 1, pgid: 1 }),
        row({ pid: 2, pgid: 2, ppid: 500 }),
        row({ pid: 3, pgid: 3, ageSeconds: 10 }),
        row({ pid: 4, pgid: 4, command: 'node /elsewhere/vitest' }),
      ],
      { inFlight: new Set(['mars-abc123']) },
    )
    expect(summary.scanned).toBe(4)
    // pid 1 is reparented -> reaped. pid 2's task is in flight -> spared.
    expect(summary.reaped).toBe(1)
    expect(summary.skipped).toBe(3)
    expect(summary.details).toHaveLength(4)
    expect(formatSweepSummary(summary)).toBe('scanned 4, reaped 1 group(s), skipped 3')
  })

  it('survives a kill that throws (group already gone) without escalating it', async () => {
    const kills: NodeJS.Signals[] = []
    const summary = await sweepOrphans({
      repoRoot: REPO,
      inFlightTaskIds: new Set<string>(),
      minAgeSeconds: 600,
      graceMs: 0,
      listProcesses: () => Promise.resolve([row({ pid: 7, pgid: 7 })]),
      groupCpuSeconds: () => Promise.resolve(new Map()),
      activityLedger: new Map(),
      ownPgid: () => Promise.resolve(null),
      killGroup: (_pgid, signal) => {
        kills.push(signal)
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      },
      groupAlive: () => true,
      sleep: () => Promise.resolve(),
    })
    expect(kills).toEqual(['SIGTERM'])
    expect(summary.reaped).toBe(1)
  })

  it('never signals anything when every candidate is healthy', async () => {
    const killGroup = vi.fn()
    await sweepOrphans({
      repoRoot: REPO,
      inFlightTaskIds: new Set(['mars-abc123']),
      minAgeSeconds: 600,
      graceMs: 0,
      listProcesses: () => Promise.resolve([row({ ppid: 500 })]),
      groupCpuSeconds: () => Promise.resolve(new Map()),
      activityLedger: new Map(),
      ownPgid: () => Promise.resolve(null),
      killGroup,
      groupAlive: () => false,
      sleep: () => Promise.resolve(),
    })
    expect(killGroup).not.toHaveBeenCalled()
  })

  it('never reaps a coder on the first sweep, however old — the ledger is cold', async () => {
    const { kills } = await sweepWith(
      [row({ pid: 900, pgid: 900, ppid: 1, ageSeconds: 20_000, command: CODER_ARGV })],
      { groupCpu: new Map([[900, 400]]), nowMs: 0 },
    )
    expect(kills).toEqual([])
  })

  it('reaps a coder only after consecutive sweeps show its group flatlined', async () => {
    const ledger: ActivityLedger = new Map()
    const coderRow = row({
      pid: 900,
      pgid: 900,
      ppid: 1,
      ageSeconds: 20_000,
      command: CODER_ARGV,
    })

    // Sweep 1 at t=0: first observation, nothing can be idle yet.
    const first = await sweepWith([coderRow], {
      ledger,
      groupCpu: new Map([[900, 400]]),
      nowMs: 0,
    })
    expect(first.kills).toEqual([])

    // Sweep 2 five minutes later, CPU advanced: still working.
    const second = await sweepWith([coderRow], {
      ledger,
      groupCpu: new Map([[900, 460]]),
      nowMs: 300_000,
    })
    expect(second.kills).toEqual([])

    // Sweep 3 twenty minutes after that, CPU unchanged: idle 1200 s > 900 s.
    const third = await sweepWith([coderRow], {
      ledger,
      groupCpu: new Map([[900, 460]]),
      nowMs: 1_500_000,
    })
    expect(third.kills).toEqual([{ pgid: 900, signal: 'SIGTERM' }])
    expect(third.logs.join('\n')).toContain('reason=agent-idle')
  })

  it('keeps sparing a coder whose child burns CPU while the agent itself blocks', async () => {
    // Group-wide accounting is the point: `claude` waiting on `npm test` shows
    // no CPU of its own, but the test run is in the same process group.
    const ledger: ActivityLedger = new Map()
    const coderRow = row({
      pid: 900,
      pgid: 900,
      ppid: 1,
      cpuSeconds: 400,
      ageSeconds: 20_000,
      command: CODER_ARGV,
    })
    await sweepWith([coderRow], { ledger, groupCpu: new Map([[900, 400]]), nowMs: 0 })
    const later = await sweepWith([coderRow], {
      ledger,
      // The agent's own cpuSeconds never moved; the group's did.
      groupCpu: new Map([[900, 3_000]]),
      nowMs: 3_600_000,
    })
    expect(later.kills).toEqual([])
  })

  it('refreshes the ledger even on a sweep with no candidates', async () => {
    // Otherwise a group that idled while unmatched looks instantly reapable the
    // moment it shows up again.
    const ledger: ActivityLedger = new Map()
    await sweepWith([], { ledger, groupCpu: new Map([[900, 400]]), nowMs: 0 })
    expect(ledger.get(900)).toEqual({ cpuSeconds: 400, lastProgressAtMs: 0 })
  })
})

describe('defaults', () => {
  it('uses a conservative age threshold well above any legitimate verify step', () => {
    expect(DEFAULT_MIN_AGE_SECONDS).toBeGreaterThanOrEqual(300)
  })

  it('gives agent sessions an idle window longer than any single model round-trip', () => {
    expect(DEFAULT_AGENT_IDLE_SECONDS).toBeGreaterThanOrEqual(600)
  })

  it('imposes NO wall-clock cap on agent sessions by default', () => {
    expect(DEFAULT_AGENT_MAX_AGE_SECONDS).toBe(Infinity)
  })
})
