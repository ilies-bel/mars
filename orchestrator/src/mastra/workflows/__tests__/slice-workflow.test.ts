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
  injectSchemaDropBlockers,
  composeTaskPrompt,
} from '../slice-workflow'
import {
  composePrompt,
  resolveWorkerSystemPrompt,
  CODER_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from '../implement-workflow'
import { TDD_WORKER_BRIEF } from '../tdd-brief'

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

  it('leaves the idea at prd-ready when generate-slices times out (exit 124)', async () => {
    // Regression test for the original bug: `mars idea slice 06e677fb`
    // failed when the slicer hit the 300s wall (claude -p exited 124),
    // yet the idea's status was left as 'sliced' with zero tasks.
    //
    // The exitCode=124 throw fires OUTSIDE the try-catch block (before any
    // Phase 1-4 DB write), so `ideaFlipped` is never set and no compensation
    // is needed. This test pins that: a timeout must NOT set the idea to
    // 'sliced', and `mars idea slice` must be re-runnable without a manual
    // `mars idea set <id> status prd-ready` poke.
    vi.doMock('../../lib/git', async () => {
      const actual = await vi.importActual<typeof import('../../lib/git')>(
        '../../lib/git',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 124,
          stdout: '',
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(ideaId)).rejects.toThrow(/124/)

    const proposals = await import('../../proposals')
    const after = await proposals.getProposal(ideaId)
    // Must remain prd-ready — `mars idea slice` must be directly re-runnable.
    expect(after?.status).toBe('prd-ready')
    // Zero tasks: no partial state was committed to the queue.
    expect(await countTasksForIdea(ideaId)).toBe(0)
  })

  it('on success: atomically flips idea to sliced AND inserts the expected slice tasks', async () => {
    // The idea→sliced status transition must be atomic with successful
    // slice-task creation. This test verifies the "happy path" invariant:
    // a successful runSlice must produce BOTH idea.status='sliced' AND
    // the expected tasks in the queue — not one without the other.
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
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(ideaId)

    // Status flip: the idea must now be 'sliced'.
    const proposals = await import('../../proposals')
    const after = await proposals.getProposal(ideaId)
    expect(after?.status).toBe('sliced')

    // Task creation: the returned taskIds must match what was inserted.
    expect(result.taskIds).toHaveLength(1)
    expect(await countTasksForIdea(ideaId)).toBe(1)

    // The returned ideaId must match, and status must be the settled string.
    expect(result.ideaId).toBe(ideaId)
    expect(result.status).toBe('sliced')
  })

  it('cleans up orphaned tasks from a previous crash before re-slicing', async () => {
    // Crash-recovery deduplication: a process crash between Phase 1
    // (task inserts) and Phase 4 (status flip) leaves the idea prd-ready
    // with orphaned tasks from the crashed run. Without a pre-flight
    // cleanup, a retry would INSERT a second set of tasks on top of the
    // orphans, duplicating the queue work. The pre-flight must delete any
    // tasks with parent_proposal_id = idea.id before Phase 1 runs, so a
    // retry lands exactly N tasks — not N orphans + N fresh ones.
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
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    // Simulate the crash: manually insert an orphaned task that claims
    // this idea as its parent (as if Phase 1 ran but the process died
    // before Phase 4 could flip the status).
    const queue = await vi.importActual<typeof import('../../queue')>(
      '../../queue',
    )
    await queue.initQueue()
    await queue.enqueueTask('orphaned task from crashed run', undefined, {
      parentProposalId: ideaId,
      sliceIndex: 1,
    })
    expect(await countTasksForIdea(ideaId)).toBe(1) // orphan is there

    // Now re-run the slice — this is the retry after the crash.
    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(ideaId)

    // The retry must produce exactly the fresh slicer output (1 slice),
    // not 1 orphan + 1 new = 2. The orphan must have been cleaned up.
    expect(result.taskIds).toHaveLength(1)
    expect(await countTasksForIdea(ideaId)).toBe(1)

    // And the idea must now be sliced (not prd-ready).
    const proposals = await import('../../proposals')
    const after = await proposals.getProposal(ideaId)
    expect(after?.status).toBe('sliced')
  })
})

describe('injectSchemaDropBlockers: schema-drop ↔ consumer edges', () => {
  // Mirrors the concrete failure from PRD
  // 1b7498f6-remove-all-usd-cost-usd-mentions-from-th: a "Drop
  // total_cost_usd column from queue.db schema (hard cut, no migration)"
  // slice was emitted with ZERO blocker edges even though three sibling
  // slices removed the read-side of the same column. The drop dispatched
  // first and burned its full retry budget on
  // `SQLITE_ERROR: no such column: s.total_cost_usd`. Six inbox items
  // later (final one 496b528e), the operator manually wired the edges.
  // This test pins the injection so the regression cannot recur silently.
  it('blocks a schema-drop slice on every consumer slice that mentions the dropped column (1b7498f6 shape)', () => {
    const slices = [
      {
        title: 'Update README to drop mentions of total_cost_usd from cost docs',
        whatToBuild: 'Edit README to remove the total_cost_usd column from cost docs',
        blockedBy: [] as number[],
      },
      {
        title: 'Remove total_cost_usd from claude-usage parser',
        whatToBuild: 'Stop reading total_cost_usd from the parser output',
        blockedBy: [] as number[],
      },
      {
        title: 'Remove total_cost_usd from reflect-signals storage layer',
        whatToBuild: 'Stop writing total_cost_usd through the storage layer',
        blockedBy: [] as number[],
      },
      {
        title: 'Remove total_cost_usd from reflect-query aggregation',
        whatToBuild: 'Stop summing total_cost_usd in the aggregation query',
        blockedBy: [] as number[],
      },
      {
        title: 'Drop total_cost_usd column from queue.db schema (hard cut, no migration)',
        whatToBuild: 'Drop the total_cost_usd column from the tasks table',
        blockedBy: [] as number[],
      },
    ]

    injectSchemaDropBlockers(slices)

    // Schema-drop (slice 5, 1-based) must wait on every consumer slice
    // (1..4) that mentions total_cost_usd.
    expect(slices[4].blockedBy).toEqual([1, 2, 3, 4])
    // Consumer slices must NOT acquire reverse edges — only the drop is
    // repaired.
    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([])
    expect(slices[2].blockedBy).toEqual([])
    expect(slices[3].blockedBy).toEqual([])
  })

  it('preserves consumer-slice upstream blockers — does not flatten the dependency tree', () => {
    const slices = [
      {
        title: 'Remove foo_bar from parser',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
      {
        // Consumer slice 2 was sliced with an existing dependency on
        // slice 1 — e.g. parser tests must pass before the aggregator
        // update can land. That edge must survive the injection.
        title: 'Remove foo_bar from aggregator',
        whatToBuild: '',
        blockedBy: [1],
      },
      {
        title: 'Drop foo_bar column from schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    injectSchemaDropBlockers(slices)

    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([1])
    expect(slices[2].blockedBy).toEqual([1, 2])
  })

  it('is a no-op when the PRD contains no schema-drop slice', () => {
    const slices = [
      {
        title: 'Add caching to the parser',
        whatToBuild: 'Memoize parser output',
        blockedBy: [] as number[],
      },
      {
        title: 'Add caching to the aggregator',
        whatToBuild: 'Memoize aggregator output',
        blockedBy: [] as number[],
      },
    ]

    injectSchemaDropBlockers(slices)

    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('avoids cycles when a consumer slice already declares the schema-drop as its upstream', () => {
    const slices = [
      {
        // Inverted slicer ordering: consumer says it waits on the drop.
        // Adding the reverse edge would produce a 1↔2 cycle.
        title: 'Remove total_cost_usd from parser',
        whatToBuild: '',
        blockedBy: [2],
      },
      {
        title: 'Drop total_cost_usd column from schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    injectSchemaDropBlockers(slices)

    expect(slices[0].blockedBy).toEqual([2])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('does not link slices that share no snake_case identifier with the drop', () => {
    const slices = [
      {
        title: 'Tweak unrelated docs',
        whatToBuild: 'Update README front matter',
        blockedBy: [] as number[],
      },
      {
        title: 'Drop total_cost_usd column from queue.db schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    injectSchemaDropBlockers(slices)

    expect(slices[1].blockedBy).toEqual([])
  })

  it('is idempotent — re-running over already-injected slices produces no duplicates', () => {
    const slices = [
      {
        title: 'Remove total_cost_usd from parser',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
      {
        title: 'Drop total_cost_usd column from schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    injectSchemaDropBlockers(slices)
    injectSchemaDropBlockers(slices)

    expect(slices[1].blockedBy).toEqual([1])
  })
})

describe('runSlice → queue: schema-drop blocker injection round-trip', () => {
  // Integration-level pin for the 1b7498f6 regression. The
  // injectSchemaDropBlockers unit tests above prove the helper
  // computes the right edges; this one proves the helper is actually
  // invoked from generateStep — removing the call from generateStep
  // (while leaving the helper exported) must break this test.
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-blockers-'))
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
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const seedPrdReadyIdea = async (): Promise<string> => {
    const proposals = await import('../../proposals')
    await proposals.initProposals()
    const idea = await proposals.createProposal('Remove total_cost_usd', {
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(idea.id, 'as a user, I want X')
    const promoted = await proposals.promoteProposal(idea.id)
    expect(promoted.status).toBe('prd-ready')
    return idea.id
  }

  // Mirrors the 8-slice / no-blockers shape that PRD
  // 1b7498f6-remove-all-usd-cost-usd-mentions-from-th emitted: a
  // schema-drop slice plus four consumer slices that mention
  // total_cost_usd, every slice's `blockedBy` empty. After runSlice
  // lands, the schema-drop task must have task_blocker rows pointing
  // at each consumer.
  const slicer1b7498f6Shape = {
    slices: [
      {
        title: 'Update README to drop mentions of total_cost_usd from cost docs',
        type: 'AFK' as const,
        whatToBuild: 'Edit the README to drop mentions of total_cost_usd',
        acceptanceCriteria: ['README updated'],
        blockedBy: [] as number[],
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,
        taskType: 'auto' as const,
      },
      {
        title: 'Remove total_cost_usd from claude-usage parser',
        type: 'AFK' as const,
        whatToBuild: 'Stop reading total_cost_usd from the parser output',
        acceptanceCriteria: ['parser no longer references total_cost_usd'],
        blockedBy: [] as number[],
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,
        taskType: 'auto' as const,
      },
      {
        title: 'Remove total_cost_usd from reflect-signals storage layer',
        type: 'AFK' as const,
        whatToBuild: 'Stop writing total_cost_usd through the storage layer',
        acceptanceCriteria: ['storage layer no longer writes total_cost_usd'],
        blockedBy: [] as number[],
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,
        taskType: 'auto' as const,
      },
      {
        title: 'Remove total_cost_usd from reflect-query aggregation',
        type: 'AFK' as const,
        whatToBuild: 'Stop summing total_cost_usd in the aggregation query',
        acceptanceCriteria: ['aggregation no longer references total_cost_usd'],
        blockedBy: [] as number[],
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,
        taskType: 'auto' as const,
      },
      {
        title:
          'Drop total_cost_usd column from queue.db schema (hard cut, no migration)',
        type: 'AFK' as const,
        whatToBuild: 'Drop the total_cost_usd column from the tasks table',
        acceptanceCriteria: ['total_cost_usd column dropped'],
        blockedBy: [] as number[],
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,
        taskType: 'auto' as const,
      },
    ],
  }

  it('persists blocker edges from the schema-drop slice onto every consumer slice', async () => {
    vi.doMock('../../lib/git', async () => {
      const actual = await vi.importActual<typeof import('../../lib/git')>(
        '../../lib/git',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(slicer1b7498f6Shape),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const ideaId = await seedPrdReadyIdea()

    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(ideaId)
    expect(result.taskIds).toHaveLength(5)
    const [readmeId, parserId, storageId, aggregationId, dropId] = result.taskIds

    const queue = await import('../../queue')
    await queue.initQueue()
    const rows = await queue.getClient().execute({
      sql: `SELECT task_id, blocker_task_id FROM task_blockers
            WHERE task_id = ? ORDER BY blocker_task_id`,
      args: [dropId],
    })
    const blockerIds = rows.rows
      .map(
        (r) =>
          (r as unknown as { blocker_task_id: string }).blocker_task_id,
      )
      .sort()
    expect(blockerIds).toEqual(
      [readmeId, parserId, storageId, aggregationId].sort(),
    )

    // The drop task must be in 'blocked' status (it has blockers); the
    // consumer tasks must be in 'queued' (they have none). This is the
    // whole point — the drop cannot dispatch and burn retry budget on
    // verify:test until every consumer has landed.
    const dropRow = await queue.getClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [dropId],
    })
    expect(
      (dropRow.rows[0] as unknown as { status: string }).status,
    ).toBe('blocked')
    const parserRow = await queue.getClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [parserId],
    })
    expect(
      (parserRow.rows[0] as unknown as { status: string }).status,
    ).toBe('queued')
  })
})

describe('composeTaskPrompt: inlines the parent PRD so no DB lookup is needed', () => {
  // Dispatched coders run from .mars/worktrees/<id>/ where `mars` walks up
  // from CWD and binds to the worktree's own (empty) .mars/. A bare
  // `mars idea show <id>` therefore returns 'not found' and silently
  // strands the implementor. The slice prompt MUST inline the PRD body so
  // the implementor never has to look it up. Regression pin for the
  // mars-45d9abd8 too_hard arc.
  const sampleIdea = {
    id: 'idea-xyz',
    title: 'Inline the PRD into slice prompts',
    problem: 'Coders cannot read the PRD from a worktree.',
    solution: 'Inline title/solution/user stories/notes at build time.',
    outOfScope: 'Changing how the ideas DB lookup resolves repos.',
    notes: 'Observed in task mars-45d9abd8.',
    userStories: [
      'As a dispatched coder I have the PRD body in my brief.',
      'As an orchestrator author I do not plumb --repo through prompts.',
    ],
  }
  const sampleSlice = {
    title: 'Inline PRD body',
    type: 'AFK' as const,
    whatToBuild: 'Inline the PRD fields into the slice prompt.',
    acceptanceCriteria: ['prompt contains the PRD body'],
    blockedBy: [] as number[],
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,
    taskType: 'auto' as const,
  }

  it('inlines title, problem, solution, user stories, out-of-scope, and notes', () => {
    const prompt = composeTaskPrompt(sampleIdea, sampleSlice, 1, 1)
    expect(prompt).toContain(sampleIdea.title)
    expect(prompt).toContain(sampleIdea.problem)
    expect(prompt).toContain(sampleIdea.solution)
    expect(prompt).toContain(sampleIdea.outOfScope)
    expect(prompt).toContain(sampleIdea.notes)
    for (const story of sampleIdea.userStories) {
      expect(prompt).toContain(story)
    }
  })

  it('does NOT instruct the implementor to run `mars idea show` (worktree DB is empty)', () => {
    const prompt = composeTaskPrompt(sampleIdea, sampleSlice, 1, 1)
    // Either form would silently fail from a worktree CWD; both are banned.
    expect(prompt).not.toMatch(/mars idea show/i)
    expect(prompt).not.toMatch(/mars\s+--repo\s+\S+\s+idea\s+show/i)
  })

  it('renders an idea with empty optional fields without leaking `undefined`', () => {
    const minimal = {
      id: 'idea-min',
      title: 'Minimal PRD',
      problem: '',
      solution: '',
      outOfScope: '',
      notes: '',
      userStories: [] as string[],
    }
    const prompt = composeTaskPrompt(minimal, sampleSlice, 1, 1)
    expect(prompt).not.toContain('undefined')
    // Empty fields render as a clear placeholder rather than blank.
    expect(prompt).toContain('(not specified)')
    expect(prompt).toContain('(none)')
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

describe('Slice 1: TDD philosophy is a standing Session instruction, not per-Task text', () => {
  // The coder Worker used to re-absorb the ~150-line TDD brief at the top
  // of every per-Task prompt, and a retry replayed it verbatim — burning
  // the read-span budget on boilerplate. It now arrives once, as the
  // Worker's standing Session instructions, and never inside the per-Task
  // prompt.
  const idea = {
    id: 'idea-tdd',
    title: 'Move the TDD brief out of per-task prompts',
    problem: 'The brief is replayed verbatim on every retry.',
    solution: 'Carry it in the Session standing instructions instead.',
    outOfScope: 'Retuning the read budget.',
    notes: 'Slice 1 of the read-span PRD.',
    userStories: ['As a coder I do not re-absorb the brief each task.'],
  }
  const slice = {
    title: 'Drop the brief from the per-task prompt',
    type: 'AFK' as const,
    whatToBuild: 'Stop prepending the TDD brief to the slice prompt.',
    acceptanceCriteria: ['per-task prompt has zero copies of the brief'],
    blockedBy: [] as number[],
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,
    taskType: 'auto' as const,
  }
  const spec = {
    files: [] as string[],
    verifyCmd: null,
    doneCriteria: ['a'],
    taskType: 'auto' as const,
  }
  // A sentence that appears verbatim only in the TDD operating philosophy.
  const TDD_SIGNATURE =
    'using test-driven development with vertical tracer bullets'

  it('composes a coder per-Task prompt with zero copies of the TDD philosophy', () => {
    const prompt = composeTaskPrompt(idea, slice, 1, 1)
    expect(prompt).not.toContain(TDD_WORKER_BRIEF)
    expect(prompt).not.toContain(TDD_SIGNATURE)
    expect(prompt).not.toContain('Anti-pattern: horizontal slices')

    // It also stays out of the fully-composed dispatched prompt.
    const dispatched = composePrompt(prompt, null, 'coder', spec, 'mars-x')
    expect(dispatched).not.toContain(TDD_WORKER_BRIEF)
    expect(dispatched).not.toContain(TDD_SIGNATURE)
  })

  it('gives a dispatched coder Worker the TDD philosophy in its standing Session instructions', () => {
    expect(resolveWorkerSystemPrompt('coder')).toContain(TDD_WORKER_BRIEF)
    expect(CODER_SYSTEM_PROMPT).toContain(TDD_WORKER_BRIEF)
  })

  it('produces a byte-identical, brief-free per-Task prompt when a coder Task is retried', () => {
    const original = composeTaskPrompt(idea, slice, 1, 1)
    const retried = composeTaskPrompt(idea, slice, 1, 1)
    expect(retried).toBe(original)
    expect(retried).not.toContain(TDD_WORKER_BRIEF)

    // A re-dispatch wraps the stored prompt through composePrompt again;
    // that surface must also be stable and brief-free.
    const first = composePrompt(original, null, 'coder', spec, 'mars-x')
    const second = composePrompt(original, null, 'coder', spec, 'mars-x')
    expect(second).toBe(first)
    expect(second).not.toContain(TDD_WORKER_BRIEF)
  })

  it('leaves the Writer Worker untouched — same standing instructions, same per-Task surface', () => {
    // Writer standing instructions are unchanged and never carried the brief.
    expect(resolveWorkerSystemPrompt('writer')).toBe(WRITER_SYSTEM_PROMPT)
    expect(WRITER_SYSTEM_PROMPT).not.toContain(TDD_WORKER_BRIEF)

    // Writer per-Task prompt gains/loses nothing: no brief, stable across
    // a re-dispatch.
    const w1 = composePrompt('writer task body', null, 'writer', spec, 'mars-w')
    const w2 = composePrompt('writer task body', null, 'writer', spec, 'mars-w')
    expect(w2).toBe(w1)
    expect(w1).not.toContain(TDD_WORKER_BRIEF)
  })
})
