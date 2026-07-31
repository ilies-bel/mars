import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_MIN_AGE_SECONDS,
  formatSweepSummary,
  judgeProcess,
  judgeProcessTable,
  parseEtimeSeconds,
  parsePsLine,
  sweepOrphans,
  taskIdFromCommand,
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
  command: `node ${WORKTREES}/mars-abc123/node_modules/vitest/dist/worker.js`,
  ...over,
})

const opts = (over: Partial<JudgeOptions> = {}): JudgeOptions => ({
  worktreesRoot: WORKTREES,
  inFlightTaskIds: new Set<string>(),
  minAgeSeconds: 600,
  protectedPids: new Set<number>(),
  protectedPgid: null,
  ...over,
})

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

describe('parsePsLine', () => {
  it('parses a full row and keeps the whole argv', () => {
    const parsed = parsePsLine(
      `  91234  1  91234 03:07:29 node ${WORKTREES}/mars-abc123/node_modules/.bin/vitest run --reporter=dot`,
    )
    expect(parsed).toEqual({
      pid: 91234,
      ppid: 1,
      pgid: 91234,
      ageSeconds: 11_249,
      command: `node ${WORKTREES}/mars-abc123/node_modules/.bin/vitest run --reporter=dot`,
    })
  })

  it('returns null for blank and malformed lines', () => {
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('   ')).toBeNull()
    expect(parsePsLine('not a ps row')).toBeNull()
  })

  it('returns null when the etime field is unparseable rather than guessing an age', () => {
    expect(parsePsLine('1 1 1 ?? node vitest')).toBeNull()
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

  it('returns null for an unrelated argv', () => {
    expect(taskIdFromCommand('node /somewhere/else/vitest', WORKTREES)).toBeNull()
  })

  it('returns null for another repo’s worktrees (the sweep is repo-scoped)', () => {
    expect(
      taskIdFromCommand('node /other/repo/.mars/worktrees/mars-zzz/vitest', WORKTREES),
    ).toBeNull()
  })
})

describe('judgeProcess — the classification that must not regress', () => {
  it('reaps a reparented vitest under a Mars worktree', () => {
    const v = judgeProcess(row({ ppid: 1 }), opts())
    expect(v.verdict).toBe('reap')
    expect(v.reason).toBe('reparented')
    expect(v.taskId).toBe('mars-abc123')
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

  it('ignores a non-runner process inside a worktree (e.g. the coder agent itself)', () => {
    const v = judgeProcess(
      row({ command: `claude -p --cwd ${WORKTREES}/mars-abc123` }),
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

describe('sweepOrphans', () => {
  const sweepWith = async (
    rows: readonly ProcessRow[],
    over: {
      inFlight?: ReadonlySet<string>
      alive?: (pgid: number) => boolean
    } = {},
  ) => {
    const kills: Array<{ pgid: number; signal: NodeJS.Signals }> = []
    const logs: string[] = []
    const summary = await sweepOrphans({
      repoRoot: REPO,
      inFlightTaskIds: over.inFlight ?? new Set<string>(),
      minAgeSeconds: 600,
      graceMs: 0,
      log: (l) => logs.push(l),
      listProcesses: () => Promise.resolve(rows),
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

  it('logs pid, age, and the orphan reason for every kill', async () => {
    const { logs } = await sweepWith([row({ pid: 91234, pgid: 91234, ageSeconds: 11_249 })])
    const line = logs.find((l) => l.includes('reaping'))
    expect(line).toBeDefined()
    expect(line).toContain('pid=91234')
    expect(line).toContain('age=11249s')
    expect(line).toContain('reason=reparented')
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
      ownPgid: () => Promise.resolve(null),
      killGroup,
      groupAlive: () => false,
      sleep: () => Promise.resolve(),
    })
    expect(killGroup).not.toHaveBeenCalled()
  })
})

describe('defaults', () => {
  it('uses a conservative age threshold well above any legitimate verify step', () => {
    expect(DEFAULT_MIN_AGE_SECONDS).toBeGreaterThanOrEqual(300)
  })
})
