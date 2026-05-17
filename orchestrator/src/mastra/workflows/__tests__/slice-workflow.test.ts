import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  describeSliceFailure,
  buildSlicerPrompt,
  slicerOutputSchema,
  sliceFilesForPersistence,
} from '../slice-workflow'

describe('slicing brief: structured-write constraint', () => {
  const sampleIdea = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: 'a problem',
    solution: 'a solution',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it('forbids a slice whose sole deliverable is a glossary or ADR change', () => {
    const brief = buildSlicerPrompt(sampleIdea)

    // The constraint is stated as explicit guidance to the slicer:
    // never emit a slice whose sole deliverable is a glossary/ADR change.
    expect(brief).toMatch(/glossary/i)
    expect(brief).toMatch(/ADR/)
    expect(brief).toMatch(/never\s+produce\s+a\s+slice/i)
    expect(brief).toMatch(/sole\s+deliverable/i)
  })

  it('frames such PRD content as an upstream process violation, not a branch to handle', () => {
    const brief = buildSlicerPrompt(sampleIdea)

    expect(brief).toMatch(/upstream\s+process\s+violation/i)
    // It is settled during grilling, before the PRD is promoted.
    expect(brief).toMatch(/grill/i)
    expect(brief).toMatch(/before[\s\S]*?promot/i)
  })

  it('names the codified "structured-write" concept so the constraint is keyed to settled vocabulary', () => {
    const brief = buildSlicerPrompt(sampleIdea)

    // The constraint must be expressed in the settled glossary term (ADR
    // 0019 / glossary "Structured-write"), not only as a generic
    // "glossary/ADR change", so a PRD author and the slicer both see the
    // exact vocabulary the grill step recorded.
    expect(brief).toMatch(/structured-write/i)
    // And it must say that structured-writes are settled at grill time.
    expect(brief).toMatch(/structured-write[\s\S]*?grill/i)
  })
})

describe('slicer prompt: anti-hallucination guidance', () => {
  const sampleIdea = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: '',
    solution: '',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it('replaces a single `files` array with explicit modifies / creates instructions', () => {
    const brief = buildSlicerPrompt(sampleIdea)
    // The new schema names: both must be documented as separate output fields.
    expect(brief).toMatch(/modifies\s+—/)
    expect(brief).toMatch(/creates\s+—/)
    // Anti-hallucination cue for modifies.
    expect(brief).toMatch(/ALREADY EXIST/)
    expect(brief).toMatch(/OMIT it/i)
  })

  it('documents the NEW: prefix convention for paths under directories that do not yet exist', () => {
    const brief = buildSlicerPrompt(sampleIdea)
    expect(brief).toMatch(/NEW:/)
    // The worked example must show the prefix on a real-looking path.
    expect(brief).toContain("'NEW: orchestrator/src/manifest/load.ts'")
  })

  it('requires verifyCmd to cd into the project subdirectory when relevant', () => {
    const brief = buildSlicerPrompt(sampleIdea)
    expect(brief).toMatch(/cd\s+orchestrator\s+&&\s+npx vitest/)
    expect(brief).toMatch(/subdirectory/i)
  })

  it('does not redundantly redescribe vertical slices (TDD_WORKER_BRIEF carries that)', () => {
    const brief = buildSlicerPrompt(sampleIdea)
    // The old multi-line "Vertical-slice rules" section is gone; only the
    // condensed one-liner remains.
    expect(brief).not.toMatch(/Vertical-slice rules/)
    expect(brief).toMatch(/thin vertical tracer/)
  })

  it('shows the new modifies+creates+cd-prefixed verifyCmd in the example JSON', () => {
    const brief = buildSlicerPrompt(sampleIdea)
    expect(brief).toMatch(/"modifies":\["src\/foo\.ts"\]/)
    expect(brief).toMatch(/"creates":\["src\/foo\.test\.ts"\]/)
    expect(brief).toMatch(/"verifyCmd":"cd src && npx vitest run foo\.test\.ts"/)
    // The legacy "files" key must not survive in the example.
    expect(brief).not.toMatch(/"files":/)
  })
})

describe('slicerOutputSchema: modifies + creates', () => {
  it('accepts a slice that splits paths across modifies and creates', () => {
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 't',
          type: 'AFK',
          whatToBuild: 'x',
          acceptanceCriteria: ['a'],
          blockedBy: [],
          modifies: ['src/existing.ts'],
          creates: ['src/new.test.ts'],
          verifyCmd: 'cd src && npx vitest run new.test.ts',
          taskType: 'auto',
        },
      ],
    })
    expect(parsed.slices[0].modifies).toEqual(['src/existing.ts'])
    expect(parsed.slices[0].creates).toEqual(['src/new.test.ts'])
  })

  it('defaults both modifies and creates to [] when the slicer omits them', () => {
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 't',
          type: 'AFK',
          whatToBuild: 'x',
          acceptanceCriteria: ['a'],
          blockedBy: [],
        },
      ],
    })
    expect(parsed.slices[0].modifies).toEqual([])
    expect(parsed.slices[0].creates).toEqual([])
  })

  it('preserves the NEW: prefix on a creates entry verbatim through schema parse', () => {
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 't',
          type: 'AFK',
          whatToBuild: 'x',
          acceptanceCriteria: ['a'],
          blockedBy: [],
          modifies: [],
          creates: ['NEW: orchestrator/src/manifest/load.ts'],
        },
      ],
    })
    expect(parsed.slices[0].creates).toEqual([
      'NEW: orchestrator/src/manifest/load.ts',
    ])
  })
})

describe('sliceFilesForPersistence: backwards-compat concatenation', () => {
  it('concatenates modifies first, then creates, into a single array', () => {
    expect(
      sliceFilesForPersistence({
        modifies: ['a.ts', 'b.ts'],
        creates: ['c.ts', 'NEW: d/e.ts'],
      }),
    ).toEqual(['a.ts', 'b.ts', 'c.ts', 'NEW: d/e.ts'])
  })

  it('returns [] when both inputs are empty', () => {
    expect(sliceFilesForPersistence({ modifies: [], creates: [] })).toEqual([])
  })
})

describe('enqueueTask round-trip: slicer split lands in tasks.files_json', () => {
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-files-'))
    execFileSync('git', ['init', '-q'], { cwd: r })
    mkdirSync(resolve(r, '.mars'), { recursive: true })
    return r
  }

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('persists modifies + creates concatenated into spec.files', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = await import('../../queue')
    await queue.initQueue()

    const slice = {
      modifies: ['src/existing.ts'],
      creates: ['src/new.test.ts'],
    }
    const files = sliceFilesForPersistence(slice)
    const task = await queue.enqueueTask('p', undefined, {
      spec: {
        files,
        verifyCmd: 'cd src && npx vitest run new.test.ts',
        doneCriteria: ['a'],
        taskType: 'auto',
      },
    })
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.spec?.files).toEqual([
      'src/existing.ts',
      'src/new.test.ts',
    ])
  })

  it("round-trips a creates entry that uses the 'NEW: ' prefix verbatim", async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = await import('../../queue')
    await queue.initQueue()

    // Simulate a slicer output that uses the prefix to flag a brand-new
    // directory — exactly the case (orchestrator/src/manifest/) that
    // had previously blocked three slices.
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 't',
          type: 'AFK',
          whatToBuild: 'x',
          acceptanceCriteria: ['a'],
          blockedBy: [],
          modifies: ['orchestrator/src/mastra/queue.ts'],
          creates: ['NEW: orchestrator/src/manifest/load.ts'],
        },
      ],
    })
    const slice = parsed.slices[0]
    const files = sliceFilesForPersistence(slice)
    const task = await queue.enqueueTask('p', undefined, {
      spec: {
        files,
        verifyCmd: null,
        doneCriteria: slice.acceptanceCriteria,
        taskType: slice.taskType,
      },
    })
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.spec?.files).toEqual([
      'orchestrator/src/mastra/queue.ts',
      'NEW: orchestrator/src/manifest/load.ts',
    ])
  })
})

describe('runSlice failure compensation: a failed slice must not strand the idea', () => {
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-compensate-'))
    execFileSync('git', ['init', '-q'], { cwd: r })
    mkdirSync(resolve(r, '.mars'), { recursive: true })
    return r
  }

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../lib/git')
    vi.doUnmock('../../queue')
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const validSlicerOutput = {
    slices: [
      {
        title: 't',
        type: 'AFK' as const,
        whatToBuild: 'x',
        acceptanceCriteria: ['a'],
        blockedBy: [] as number[],
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,
        taskType: 'auto' as const,
      },
    ],
  }

  // Seed a fresh idea in 'prd-ready' status (the precondition `generateStep`
  // checks) and return its id.
  const seedPrdReadyIdea = async (): Promise<string> => {
    const proposals = await import('../../proposals')
    await proposals.initProposals()
    const idea = await proposals.createProposal('t', {
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(idea.id, 'as a user, I want X')
    const promoted = await proposals.promoteProposal(idea.id)
    expect(promoted.status).toBe('prd-ready')
    return idea.id
  }

  const countTasksForIdea = async (ideaId: string): Promise<number> => {
    const queue = await vi.importActual<typeof import('../../queue')>(
      '../../queue',
    )
    await queue.initQueue()
    const rows = await queue.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE parent_proposal_id = ?`,
      args: [ideaId],
    })
    return Number((rows.rows[0] as unknown as { n: number | bigint }).n ?? 0)
  }

  it('leaves the idea at prd-ready when slicer parse fails (zero-slice / invalid output)', async () => {
    // claude -p succeeds at the process level but emits something that is
    // NOT a valid slicerOutput JSON. parseSlicerOutput throws — that
    // throw lands BEFORE Phase 4 flips the idea, so the idea must still
    // be prd-ready and no tasks must have been inserted.
    vi.doMock('../../lib/git', async () => {
      const actual = await vi.importActual<typeof import('../../lib/git')>(
        '../../lib/git',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope({ slices: [] }), // schema requires min(1) → parse fails
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(ideaId)).rejects.toThrow()

    const proposals = await import('../../proposals')
    const after = await proposals.getProposal(ideaId)
    expect(after?.status).toBe('prd-ready')
    expect(await countTasksForIdea(ideaId)).toBe(0)
  })

  it('reverts the idea back to prd-ready and deletes inserted tasks when a failure fires AFTER Phase 4', async () => {
    // Phase 4 is the LAST write that flips the idea to 'sliced'. A
    // failure in Phase 5 (the proposal→task blocker transfer) used to
    // leave the idea wedged at 'sliced' with zero surviving tasks
    // because the catch block only deleted the tasks and re-threw.
    // We simulate that exact shape by stubbing the slicer to emit a
    // valid one-slice output AND forcing transferProposalBlockerToTask
    // to throw — the catch must now revert the idea AND clean tasks.
    vi.doMock('../../lib/git', async () => {
      const actual = await vi.importActual<typeof import('../../lib/git')>(
        '../../lib/git',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(validSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.doMock('../../queue', async () => {
      const actual = await vi.importActual<typeof import('../../queue')>(
        '../../queue',
      )
      return {
        ...actual,
        transferProposalBlockerToTask: vi.fn(async () => {
          throw new Error('phase 5 injected failure')
        }),
      }
    })
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(ideaId)).rejects.toThrow(
      /phase 5 injected failure/,
    )

    const proposals = await import('../../proposals')
    const after = await proposals.getProposal(ideaId)
    // The whole point of the compensating revert: a Phase 5 failure
    // must not strand the idea at 'sliced'.
    expect(after?.status).toBe('prd-ready')
    // And no tasks must survive — the cleanup loop should have deleted
    // every row Phase 1 inserted.
    expect(await countTasksForIdea(ideaId)).toBe(0)
  })

  it('leaves the idea at prd-ready when claude -p exits non-zero (slicer outage)', async () => {
    // A genuine slicer outage: claude exits non-zero before any DB
    // write fires. The idea must remain prd-ready so the daemon's
    // auto-slice loop (which only picks up prd-ready ideas) can
    // retry once the slicer is healthy.
    vi.doMock('../../lib/git', async () => {
      const actual = await vi.importActual<typeof import('../../lib/git')>(
        '../../lib/git',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'slicer agent crashed',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(ideaId)).rejects.toThrow()

    const proposals = await import('../../proposals')
    const after = await proposals.getProposal(ideaId)
    expect(after?.status).toBe('prd-ready')
    expect(await countTasksForIdea(ideaId)).toBe(0)
  })
})

describe('describeSliceFailure', () => {
  it('includes the failing step error text, not just the status word', () => {
    const result = {
      status: 'failed',
      error: new Error('top-level run aborted'),
      steps: {
        'some-other-step': { status: 'success', output: {} },
        generate: {
          status: 'failed',
          error: new Error('slicer agent returned invalid JSON: unexpected token'),
        },
      },
    }

    const msg = describeSliceFailure(result)

    expect(msg).toContain('slice workflow failed')
    expect(msg).toContain('top-level run aborted')
    expect(msg).toContain('step "generate" failed')
    expect(msg).toContain('slicer agent returned invalid JSON: unexpected token')
    // The whole point: the cause is present, not discarded.
    expect(msg).not.toBe('slice workflow failed')
  })

  it('handles a serialized (storage-rehydrated) step error object', () => {
    const result = {
      status: 'failed',
      steps: {
        generate: {
          status: 'failed',
          error: {
            name: 'TimeoutError',
            message: 'claude -p exceeded deadline after 600000ms',
            stack: 'TimeoutError: ...',
          },
        },
      },
    }

    const msg = describeSliceFailure(result)

    expect(msg).toContain('step "generate" failed')
    expect(msg).toContain('TimeoutError')
    expect(msg).toContain('claude -p exceeded deadline after 600000ms')
  })

  it('handles a bare string error', () => {
    const msg = describeSliceFailure({
      status: 'failed',
      error: 'database is locked',
    })

    expect(msg).toContain('slice workflow failed')
    expect(msg).toContain('database is locked')
  })

  it('still produces a useful message when no error detail is present', () => {
    const msg = describeSliceFailure({ status: 'suspended', steps: {} })

    expect(msg).toBe('slice workflow suspended')
  })

  it('bounds the message length so it stays log-friendly', () => {
    const huge = 'x'.repeat(5000)
    const msg = describeSliceFailure({
      status: 'failed',
      steps: { generate: { status: 'failed', error: new Error(huge) } },
    })

    expect(msg.length).toBeLessThanOrEqual(1001) // 1000 + ellipsis
    expect(msg.endsWith('…')).toBe(true)
  })

  it('reports only the first failing step', () => {
    const msg = describeSliceFailure({
      status: 'failed',
      steps: {
        a: { status: 'failed', error: new Error('first failure') },
        b: { status: 'failed', error: new Error('second failure') },
      },
    })

    expect(msg).toContain('first failure')
    expect(msg).not.toContain('second failure')
  })
})
