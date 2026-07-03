/**
 * Tests for arc reflect step-timeline: every Step span under an arc's origin,
 * walked in started_at order. Each entry surfaces step name, worker name
 * (LLM-backed spans), outcome, duration, transcript/sessionId (LLM), and
 * verifyOutput (verify spans).
 *
 * All behaviour is tested through the public interface: loadDeepReflectArc().stepTimeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface DeepQueryModule {
  loadDeepReflectArc: typeof import('../deep-reflect-query').loadDeepReflectArc
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-timeline-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface Modules {
  q: QueueModule
  dq: DeepQueryModule
}

const loadModules = async (repo: string): Promise<Modules> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const dq = (await import('../deep-reflect-query')) as unknown as DeepQueryModule
  return { q, dq }
}

/**
 * Insert a step_ended row directly into trace_events.
 * The `timestamp` field is the span's END time (ISO-8601).
 * The `durationMs` in payload lets `startedAt` be derived.
 */
const insertSpanEnded = async (
  q: QueueModule,
  opts: {
    originId: string
    timestamp: string
    stepName: string
    workerName?: string
    phase?: string
    outcome?: 'completed' | 'failed' | 'killed'
    durationMs?: number
    sessionId?: string
    transcript?: string
    verifyOutput?: string
    commandOutput?: string
  },
): Promise<void> => {
  const payload: Record<string, unknown> = {
    stepName: opts.stepName,
    workflowInstanceId: `wf-${randomUUID()}`,
    outcome: opts.outcome ?? 'completed',
    durationMs: opts.durationMs ?? 100,
  }
  if (opts.workerName !== undefined) payload.workerName = opts.workerName
  if (opts.sessionId !== undefined) payload.sessionId = opts.sessionId
  if (opts.transcript !== undefined) payload.transcript = opts.transcript
  if (opts.verifyOutput !== undefined) payload.verifyOutput = opts.verifyOutput
  if (opts.commandOutput !== undefined) payload.commandOutput = opts.commandOutput

  const severity =
    opts.outcome === 'failed' ? 'error' : opts.outcome === 'killed' ? 'warn' : 'info'

  await q.resolveQueueClient().execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'step_ended', ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      opts.timestamp,
      severity,
      opts.originId,
      opts.originId,
      opts.phase ?? null,
      JSON.stringify(payload),
    ],
  })
}

describe('arc step timeline — basic step ordering', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reflects each task step (setup, code, verify, merge) in started_at order', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('implement feature X', undefined, { skipTriage: true })
    const originId = task.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:00.100Z',
      stepName: 'setup-worktree',
      phase: 'setup',
      durationMs: 100,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:05.000Z',
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      durationMs: 4900,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:07.000Z',
      stepName: 'verify',
      phase: 'verify',
      durationMs: 2000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:08.000Z',
      stepName: 'merge',
      phase: 'merge',
      durationMs: 1000,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    expect(arc).not.toBeNull()
    const timeline = arc!.stepTimeline
    expect(timeline).toHaveLength(4)
    expect(timeline.map((s) => s.stepName)).toEqual([
      'setup-worktree',
      'run-claude-code',
      'verify',
      'merge',
    ])
  })

  it('each timeline entry surfaces outcome and durationMs', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('check timeline fields', undefined, { skipTriage: true })
    const originId = task.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:00.500Z',
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      outcome: 'completed',
      durationMs: 500,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:03.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'failed',
      durationMs: 2500,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const timeline = arc!.stepTimeline

    const codeEntry = timeline.find((s) => s.stepName === 'run-claude-code')
    expect(codeEntry).toBeDefined()
    expect(codeEntry!.outcome).toBe('completed')
    expect(codeEntry!.durationMs).toBe(500)

    const verifyEntry = timeline.find((s) => s.stepName === 'verify')
    expect(verifyEntry).toBeDefined()
    expect(verifyEntry!.outcome).toBe('failed')
    expect(verifyEntry!.durationMs).toBe(2500)
  })
})

describe('arc step timeline — Proposal arc (Planner + Slicer at top)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('shows Planner span first and Slicer span second when the arc origin is a Proposal', async () => {
    const { q, dq } = await loadModules(repo)
    const proposal = await q.enqueueTask('proposal: build widget system', undefined, {
      skipTriage: true,
    })
    const originId = proposal.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T09:00:01.000Z',
      stepName: 'generate-plan',
      workerName: 'Planner',
      phase: 'code',
      durationMs: 1000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T09:00:05.000Z',
      stepName: 'generate-slices',
      workerName: 'Slicer',
      phase: 'code',
      durationMs: 4000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T09:00:10.000Z',
      stepName: 'setup-worktree',
      phase: 'setup',
      durationMs: 100,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T09:00:20.000Z',
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      durationMs: 10000,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    expect(arc).not.toBeNull()
    const timeline = arc!.stepTimeline
    expect(timeline.length).toBeGreaterThanOrEqual(2)

    expect(timeline[0].stepName).toBe('generate-plan')
    expect(timeline[0].workerName).toBe('Planner')
    expect(timeline[1].stepName).toBe('generate-slices')
    expect(timeline[1].workerName).toBe('Slicer')
  })
})

describe('arc step timeline — multiple verify runs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('produces three separate verify entries when verify ran three times', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('task with retries', undefined, { skipTriage: true })
    const originId = task.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:05.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'failed',
      durationMs: 3000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:30:05.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'failed',
      durationMs: 2000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T11:00:05.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'completed',
      durationMs: 1500,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const verifyEntries = arc!.stepTimeline.filter((s) => s.stepName === 'verify')

    expect(verifyEntries).toHaveLength(3)
    expect(verifyEntries[0].outcome).toBe('failed')
    expect(verifyEntries[1].outcome).toBe('failed')
    expect(verifyEntries[2].outcome).toBe('completed')
  })
})

describe('arc step timeline — recovery flow', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('shows recovery-dispatch span and subsequent fix task spans inline in chronological order', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('task that needs recovery', undefined, { skipTriage: true })
    const originId = task.id

    // Original task workflow
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:00.100Z',
      stepName: 'setup-worktree',
      phase: 'setup',
      durationMs: 100,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:05.000Z',
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      durationMs: 4900,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:08.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'failed',
      durationMs: 3000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:09.000Z',
      stepName: 'recovery-dispatch',
      phase: 'verify',
      outcome: 'completed',
      durationMs: 1000,
    })
    // Fix task workflow
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:05:00.100Z',
      stepName: 'setup-worktree',
      phase: 'setup',
      durationMs: 100,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:05:08.000Z',
      stepName: 'run-claude-code',
      workerName: 'Fixer',
      phase: 'code',
      durationMs: 7900,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:05:11.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'completed',
      durationMs: 3000,
    })
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:05:12.000Z',
      stepName: 'merge',
      phase: 'merge',
      durationMs: 1000,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const timeline = arc!.stepTimeline
    const stepNames = timeline.map((s) => s.stepName)

    const recoveryIdx = stepNames.indexOf('recovery-dispatch')
    expect(recoveryIdx).toBeGreaterThan(-1)

    // First verify (failed) comes before recovery-dispatch
    const firstVerifyIdx = stepNames.indexOf('verify')
    expect(firstVerifyIdx).toBeLessThan(recoveryIdx)

    // Fixer span comes after recovery-dispatch
    const fixerIdx = timeline.findIndex(
      (s) => s.stepName === 'run-claude-code' && s.workerName === 'Fixer',
    )
    expect(fixerIdx).toBeGreaterThan(recoveryIdx)

    // merge comes last
    const mergeIdx = stepNames.lastIndexOf('merge')
    expect(mergeIdx).toBe(stepNames.length - 1)
  })
})

describe('arc step timeline — LLM-backed entries surface transcript and sessionId', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('surfaces sessionId on LLM-backed span entries', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('LLM session check', undefined, { skipTriage: true })
    const originId = task.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:05.000Z',
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      durationMs: 5000,
      sessionId: 'session-abc-123',
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const codeEntry = arc!.stepTimeline.find((s) => s.stepName === 'run-claude-code')
    expect(codeEntry).toBeDefined()
    expect(codeEntry!.sessionId).toBe('session-abc-123')
    expect(codeEntry!.workerName).toBe('Coder')
  })

  it('stepTimeline.transcript is always null after the durable-transcript migration (hard cut)', async () => {
    // After the durable-transcript migration, transcripts are stored as
    // gzip-compressed BLOBs in task_durable_transcripts — never inline in
    // step_ended payloads. The ArcSpanEntry.transcript field is therefore
    // always null regardless of what is in the step_ended payload.
    // The per-task conversation is read from task_durable_transcripts and
    // surfaced in ArcTaskEntry.conversation.
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('transcript check', undefined, { skipTriage: true })
    const originId = task.id

    // Insert a step_ended event that still contains an inline transcript
    // (simulating a pre-migration or legacy row). stepTimeline must ignore it.
    const transcriptJson = JSON.stringify([{ type: 'assistant', message: { content: 'done' } }])
    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:10.000Z',
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      durationMs: 10000,
      transcript: transcriptJson,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const codeEntry = arc!.stepTimeline.find((s) => s.stepName === 'run-claude-code')
    expect(codeEntry).toBeDefined()
    // Hard cut: inline transcript in step_ended payload is ignored.
    expect(codeEntry!.transcript).toBeNull()
  })

  it('surfaces verifyOutput on verify span entries', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('verify output check', undefined, { skipTriage: true })
    const originId = task.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:08.000Z',
      stepName: 'verify',
      phase: 'verify',
      outcome: 'failed',
      durationMs: 3000,
      verifyOutput: 'Error: 2 tests failed\n  - test A\n  - test B',
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const verifyEntry = arc!.stepTimeline.find((s) => s.stepName === 'verify')
    expect(verifyEntry).toBeDefined()
    expect(verifyEntry!.verifyOutput).toBe('Error: 2 tests failed\n  - test A\n  - test B')
  })

  it('surfaces null transcript and null sessionId on non-LLM span entries', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('non-llm entry check', undefined, { skipTriage: true })
    const originId = task.id

    await insertSpanEnded(q, {
      originId,
      timestamp: '2025-01-01T10:00:00.100Z',
      stepName: 'setup-worktree',
      phase: 'setup',
      durationMs: 100,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const setupEntry = arc!.stepTimeline.find((s) => s.stepName === 'setup-worktree')
    expect(setupEntry).toBeDefined()
    expect(setupEntry!.workerName).toBeNull()
    expect(setupEntry!.sessionId).toBeNull()
    expect(setupEntry!.transcript).toBeNull()
  })

  it('returns empty stepTimeline when no step_ended events exist for the arc', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('no spans task', undefined, { skipTriage: true })

    const arc = await dq.loadDeepReflectArc(task.id)
    expect(arc).not.toBeNull()
    expect(arc!.stepTimeline).toEqual([])
  })
})

describe('arc step timeline — startedAt derivation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('derives startedAt as endedAt minus durationMs', async () => {
    const { q, dq } = await loadModules(repo)
    const task = await q.enqueueTask('startedAt derivation', undefined, { skipTriage: true })
    const originId = task.id

    const endedAt = '2025-01-01T10:00:05.000Z'
    const durationMs = 5000
    const expectedStartedAt = new Date(
      new Date(endedAt).getTime() - durationMs,
    ).toISOString()

    await insertSpanEnded(q, {
      originId,
      timestamp: endedAt,
      stepName: 'run-claude-code',
      workerName: 'Coder',
      phase: 'code',
      outcome: 'completed',
      durationMs,
    })

    const arc = await dq.loadDeepReflectArc(originId)
    const entry = arc!.stepTimeline[0]
    expect(entry.startedAt).toBe(expectedStartedAt)
  })
})
