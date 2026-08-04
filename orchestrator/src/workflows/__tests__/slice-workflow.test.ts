import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  describeSliceFailure,
  buildSlicerPrompt,
  slicerOutputSchema,
  sliceFilesForPersistence,
  injectAutoLinkerBlockers,
  type DirectionVerdict,
  dropAlreadySatisfiedSlices,
  annotateUnresolvedReferences,
  composeTaskPrompt,
  subDeliverableSchema,
  detectActionAntiPattern,
  applyActionQualityGuard,
} from '../slice-workflow'
import * as sliceRefValidator from '../slice-reference-validator'
import {
  composePrompt,
  resolveWorkerSystemPrompt,
  CODER_SYSTEM_PROMPT,
} from '../primitives/shared'
import { TDD_WORKER_BRIEF } from '../tdd-brief'

describe('slicerOutputSchema: readFirst + prescriptiveAction', () => {
  // These two fields are required and non-empty for every slicer-produced
  // slice so under-briefed slices never reach the queue.

  it('accepts a slice with non-empty readFirst and prescriptiveAction', () => {
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 't',
          type: 'AFK',
          whatToBuild: 'x',
          acceptanceCriteria: ['a'],
          blockedBy: [],
          readFirst: [
            'orchestrator/src/core/workflows/slice-workflow.ts',
          ],
          prescriptiveAction:
            'In slicerOutputSchema (slice-workflow.ts ~line 23), add `readFirst: z.array(z.string()).min(1)` and `prescriptiveAction: z.string().min(1)` as required fields.',
        },
      ],
    })
    expect(parsed.slices[0].readFirst).toEqual([
      'orchestrator/src/core/workflows/slice-workflow.ts',
    ])
    expect(parsed.slices[0].prescriptiveAction).toContain('readFirst')
  })

  it('accepts more than twenty valid slices', () => {
    const parsed = slicerOutputSchema.parse({
      slices: Array.from({ length: 25 }, (_, index) => ({
        title: `slice ${index + 1}`,
        type: 'AFK',
        whatToBuild: 'Implement one thin vertical slice.',
        acceptanceCriteria: ['the slice is complete'],
        blockedBy: [],
        readFirst: ['orchestrator/src/workflows/slice-workflow.ts'],
        prescriptiveAction: 'Update the named behaviour and verify it.',
      })),
    })

    expect(parsed.slices).toHaveLength(25)
  })

  it('rejects an empty slices array', () => {
    expect(() => slicerOutputSchema.parse({ slices: [] })).toThrow()
  })

  it('rejects a slice with an empty readFirst array', () => {
    expect(() =>
      slicerOutputSchema.parse({
        slices: [
          {
            title: 't',
            whatToBuild: 'x',
            acceptanceCriteria: ['a'],
            blockedBy: [],
            readFirst: [],
            prescriptiveAction: 'do something',
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects a slice with an empty prescriptiveAction string', () => {
    expect(() =>
      slicerOutputSchema.parse({
        slices: [
          {
            title: 't',
            whatToBuild: 'x',
            acceptanceCriteria: ['a'],
            blockedBy: [],
            readFirst: ['src/foo.ts'],
            prescriptiveAction: '',
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects a slice with a missing readFirst field', () => {
    expect(() =>
      slicerOutputSchema.parse({
        slices: [
          {
            title: 't',
            whatToBuild: 'x',
            acceptanceCriteria: ['a'],
            blockedBy: [],
            prescriptiveAction: 'do something',
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects a slice with a missing prescriptiveAction field', () => {
    expect(() =>
      slicerOutputSchema.parse({
        slices: [
          {
            title: 't',
            whatToBuild: 'x',
            acceptanceCriteria: ['a'],
            blockedBy: [],
            readFirst: ['src/foo.ts'],
          },
        ],
      }),
    ).toThrow()
  })

  it('round-trips a representative slicer fixture: multiple files in readFirst and a concrete prescriptiveAction', () => {
    // Represents what the slicer would plausibly emit for a real task — the
    // fields carry actual file paths and identifier-level language. If this
    // parse succeeds, slices reaching the queue are always non-trivially briefed.
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 'Extend slicerOutputSchema with readFirst and prescriptiveAction',
          type: 'AFK',
          whatToBuild:
            'The slicer schema gains two required non-empty fields that the coder receives in their brief.',
          acceptanceCriteria: [
            'slicerOutputSchema rejects a slice whose readFirst is empty',
            'slicerOutputSchema rejects a slice whose prescriptiveAction is empty',
          ],
          blockedBy: [],
          readFirst: [
            'orchestrator/src/core/workflows/slice-workflow.ts',
            'orchestrator/src/core/workflows/__tests__/slice-workflow.test.ts',
          ],
          prescriptiveAction:
            'In `slicerOutputSchema` (slice-workflow.ts:23–49), add `readFirst: z.array(z.string()).min(1)` after `blockedBy` and `prescriptiveAction: z.string().min(1)` after `readFirst`. Update `buildSlicerPrompt` to document both fields in the "Output shape" section and include them in the example JSON object.',
          modifies: [
            'orchestrator/src/core/workflows/slice-workflow.ts',
            'orchestrator/src/core/workflows/__tests__/slice-workflow.test.ts',
          ],
          creates: [],
          verifyCmd: 'cd orchestrator && npx tsc --noEmit',          mergeMode: 'auto',
        },
      ],
    })
    expect(parsed.slices[0].readFirst).toHaveLength(2)
    // prescriptiveAction references at least one concrete identifier
    expect(parsed.slices[0].prescriptiveAction).toMatch(/slicerOutputSchema/)
    expect(parsed.slices[0].prescriptiveAction).toMatch(/readFirst/)
  })
})

describe('slicer prompt: readFirst and prescriptiveAction instructions', () => {
  const sampleProposal = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: '',
    solution: '',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it('documents readFirst as an ordered list of files to read before editing', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/readFirst\s+—/)
    expect(brief).toMatch(/ordered/i)
    // The brief must explain what readFirst is for (before editing)
    expect(brief).toMatch(/before\b.*(editing|writing|touching)/i)
  })

  it('documents prescriptiveAction as naming exact identifiers and target state', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/prescriptiveAction\s+—/)
    expect(brief).toMatch(/exact/i)
    // Must mention identifiers or file paths explicitly
    expect(brief).toMatch(/identifier|file path/i)
    // Must mention target state
    expect(brief).toMatch(/target state/i)
  })

  it('no longer forbids file paths or module names in the output shape', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    // The old prohibition was in the whatToBuild description — it is now gone.
    expect(brief).not.toMatch(/NO file paths/i)
    expect(brief).not.toMatch(/NO module names/i)
  })

  it('explicitly instructs the slicer to use code-shaped language in prescriptiveAction', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    // The prescriptiveAction guidance must explicitly say to use code vocabulary.
    expect(brief).toMatch(/code.shaped|identifier|exact.+function|exact.+type/i)
  })

  it('includes readFirst and prescriptiveAction in the example JSON', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/"readFirst":/)
    expect(brief).toMatch(/"prescriptiveAction":/)
  })
})

describe('slicer prompt: size-aware splitting', () => {
  const sampleProposal = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: '',
    solution: '',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it('includes the size-aware slicing section header', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toContain('Size-aware slicing')
  })

  it('names files touched and distinct steps as countable size proxies', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toContain('files touched')
    expect(brief).toContain('distinct steps')
  })

  it('instructs the model to split large slices and wire blockedBy for dependent pieces', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toContain('blockedBy')
    expect(brief).toMatch(/split/i)
  })

  it('states the size estimate is not emitted as a field and not a dispatch-time gate', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toContain('MUST NOT appear as a field')
    expect(brief).toContain('dispatch-time gate')
  })
})

describe('composeTaskPrompt: readFirst and prescriptiveAction sections', () => {
  const proposal = {
    id: 'idea-brief',
    title: 'Better coder brief',
    problem: 'coders re-orient instead of code',
    solution: 'hand them a read list and exact action',
    outOfScope: '',
    notes: '',
    userStories: [] as string[],
  }

  const baseSlice = {
    title: 'Add readFirst to schema',
    type: 'AFK' as const,
    kind: 'coder' as const,
    whatToBuild: 'Schema gains readFirst and prescriptiveAction.',
    acceptanceCriteria: ['schema rejects empty readFirst'],
    blockedBy: [] as number[],
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,    mergeMode: 'auto' as const,
    readFirst: ['orchestrator/src/core/workflows/slice-workflow.ts'],
    prescriptiveAction:
      'In `slicerOutputSchema` (slice-workflow.ts:23), add `readFirst: z.array(z.string()).min(1)` and `prescriptiveAction: z.string().min(1)`.',
  }

  it('renders a Read first section with files as a numbered list', () => {
    const slice = {
      ...baseSlice,
      readFirst: [
        'orchestrator/src/core/workflows/slice-workflow.ts',
        'orchestrator/src/core/workflows/__tests__/slice-workflow.test.ts',
      ],
    }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).toContain('## Read first')
    expect(prompt).toContain(
      '1. orchestrator/src/core/workflows/slice-workflow.ts',
    )
    expect(prompt).toContain(
      '2. orchestrator/src/core/workflows/__tests__/slice-workflow.test.ts',
    )
  })

  it('renders the prescriptiveAction verbatim in the prompt', () => {
    const action =
      'In `slicerOutputSchema` (slice-workflow.ts:23–49), add `readFirst: z.array(z.string()).min(1)` after `blockedBy`.'
    const slice = { ...baseSlice, prescriptiveAction: action }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).toContain(action)
  })

  it('places the Read first section before the Files section when both are present', () => {
    const slice = {
      ...baseSlice,
      readFirst: ['src/foo.ts'],
      modifies: ['src/bar.ts'],
      prescriptiveAction: 'Change doFoo() to doBar() in bar.ts.',
    }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    const readFirstIdx = prompt.indexOf('## Read first')
    const filesIdx = prompt.indexOf('## Files')
    expect(readFirstIdx).toBeGreaterThan(-1)
    expect(filesIdx).toBeGreaterThan(-1)
    expect(readFirstIdx).toBeLessThan(filesIdx)
  })
})

describe('slicing brief: structured-write constraint', () => {
  const sampleProposal = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: 'a problem',
    solution: 'a solution',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it('forbids a slice whose sole deliverable is a glossary or ADR change', () => {
    const brief = buildSlicerPrompt(sampleProposal)

    // The constraint is stated as explicit guidance to the slicer:
    // never emit a slice whose sole deliverable is a glossary/ADR change.
    expect(brief).toMatch(/glossary/i)
    expect(brief).toMatch(/ADR/)
    expect(brief).toMatch(/never\s+produce\s+a\s+slice/i)
    expect(brief).toMatch(/sole\s+deliverable/i)
  })

  it('frames such PRD content as an upstream process violation, not a branch to handle', () => {
    const brief = buildSlicerPrompt(sampleProposal)

    expect(brief).toMatch(/upstream\s+process\s+violation/i)
    // It is settled during grilling, before the PRD is promoted.
    expect(brief).toMatch(/grill/i)
    expect(brief).toMatch(/before[\s\S]*?promot/i)
  })

  it('names the codified "structured-write" concept so the constraint is keyed to settled vocabulary', () => {
    const brief = buildSlicerPrompt(sampleProposal)

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
  const sampleProposal = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: '',
    solution: '',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it('replaces a single `files` array with explicit modifies / creates instructions', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    // The new schema names: both must be documented as separate output fields.
    expect(brief).toMatch(/modifies\s+—/)
    expect(brief).toMatch(/creates\s+—/)
    // Anti-hallucination cue for modifies.
    expect(brief).toMatch(/ALREADY EXIST/)
    expect(brief).toMatch(/OMIT it/i)
  })

  it('documents the NEW: prefix convention for paths under directories that do not yet exist', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/NEW:/)
    // The worked example must show the prefix on a real-looking path.
    expect(brief).toContain("'NEW: orchestrator/src/manifest/load.ts'")
  })

  it('requires verifyCmd to cd into the project subdirectory when relevant', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/cd\s+orchestrator\s+&&\s+npx vitest/)
    expect(brief).toMatch(/subdirectory/i)
  })

  it('does not redundantly redescribe vertical slices (TDD_WORKER_BRIEF carries that)', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    // The old multi-line "Vertical-slice rules" section is gone; only the
    // condensed one-liner remains.
    expect(brief).not.toMatch(/Vertical-slice rules/)
    expect(brief).toMatch(/thin vertical tracer/)
  })

  it('shows the new modifies+creates+cd-prefixed verifyCmd in the example JSON', () => {
    const brief = buildSlicerPrompt(sampleProposal)
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
          readFirst: ['src/existing.ts'],
          prescriptiveAction: 'Edit fooFn in src/existing.ts to return number.',
          modifies: ['src/existing.ts'],
          creates: ['src/new.test.ts'],
          verifyCmd: 'cd src && npx vitest run new.test.ts',          mergeMode: 'auto',
        },
      ],
    })
    expect(parsed.slices[0].modifies).toEqual(['src/existing.ts'])
    expect(parsed.slices[0].creates).toEqual(['src/new.test.ts'])
  })

  it('defaults both modifies and creates to [] when the slicer omits them', () => {
    // readFirst and prescriptiveAction are required; only modifies/creates default.
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          title: 't',
          type: 'AFK',
          whatToBuild: 'x',
          acceptanceCriteria: ['a'],
          blockedBy: [],
          readFirst: ['src/foo.ts'],
          prescriptiveAction: 'Rename doFoo to doBar in src/foo.ts.',
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
          readFirst: ['orchestrator/src/core/context.ts'],
          prescriptiveAction:
            'Create orchestrator/src/manifest/load.ts with a loadManifest() export.',
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
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    const slice = {
      modifies: ['src/existing.ts'],
      creates: ['src/new.test.ts'],
    }
    const files = sliceFilesForPersistence(slice)
    const task = await queue.enqueueTask('p', undefined, {
      spec: {
        files,
        verifyCmd: 'cd src && npx vitest run new.test.ts',        doneCriteria: ['a'],
        mergeMode: 'auto',
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
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

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
          readFirst: ['orchestrator/src/core/queue.ts'],
          prescriptiveAction:
            'Create loadManifest() in NEW: orchestrator/src/manifest/load.ts.',
          modifies: ['orchestrator/src/core/queue.ts'],
          creates: ['NEW: orchestrator/src/manifest/load.ts'],
        },
      ],
    })
    const slice = parsed.slices[0]
    const files = sliceFilesForPersistence(slice)
    const task = await queue.enqueueTask('p', undefined, {
      spec: {
        files,
        verifyCmd: null,        doneCriteria: slice.acceptanceCriteria,
        mergeMode: slice.mergeMode,
      },
    })
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.spec?.files).toEqual([
      'orchestrator/src/core/queue.ts',
      'NEW: orchestrator/src/manifest/load.ts',
    ])
  })
})

describe('runSlice failure compensation: a failed slice must not strand the proposal', () => {
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
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../core/lib/git/claude')
    vi.doUnmock('../../core/queue')
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKER_PROVIDER
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
        readFirst: ['src/foo.ts'] as string[],
        prescriptiveAction: 'In fooFn (src/foo.ts:1), change return type to void.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
      },
    ],
  }

  // Seed a fresh proposal in 'prd-ready' status (the precondition `generateStep`
  // checks) and return its id.
  const seedPrdReadyProposal = async (
    { coordinated = false }: { coordinated?: boolean } = {},
  ): Promise<string> => {
    const proposals = await import('../../core/proposals')
    await proposals.initProposals()
    const proposal = await proposals.createProposal('t', {
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(proposal.id, 'as a user, I want X')
    const promoted = await proposals.promoteProposal(proposal.id, { coordinated })
    expect(promoted.status).toBe('prd-ready')
    return proposal.id
  }

  const countTasksForProposal = async (proposalId: string): Promise<number> => {
    const queue = await vi.importActual<typeof import('../../core/queue')>(
      '../../core/queue',
    )
    await queue.migrateQueueSchema()
    const rows = await queue.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE parent_proposal_id = ?`,
      args: [proposalId],
    })
    return Number((rows.rows[0] as unknown as { n: number | bigint }).n ?? 0)
  }

  it('leaves the proposal at prd-ready when slicer parse fails (zero-slice / invalid output)', async () => {
    // claude -p succeeds at the process level but emits something that is
    // NOT a valid slicerOutput JSON. parseSlicerOutput throws — that
    // throw lands BEFORE Phase 4 flips the proposal, so the proposal must still
    // be prd-ready and no tasks must have been inserted.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(proposalId)).rejects.toThrow()

    const proposals = await import('../../core/proposals')
    const after = await proposals.getProposal(proposalId)
    expect(after?.status).toBe('prd-ready')
    expect(await countTasksForProposal(proposalId)).toBe(0)
  })

  it('reverts the proposal back to prd-ready and deletes inserted tasks when a failure fires AFTER Phase 4', async () => {
    // Phase 4 is the LAST write that flips the proposal to 'sliced'. A
    // failure in Phase 5 (the proposal→task blocker transfer) used to
    // leave the proposal wedged at 'sliced' with zero surviving tasks
    // because the catch block only deleted the tasks and re-threw.
    // We simulate that exact shape by stubbing the slicer to emit a
    // valid one-slice output AND forcing transferProposalBlockerToTask
    // to throw — the catch must now revert the proposal AND clean tasks.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    vi.doMock('../../core/queue', async () => {
      const actual = await vi.importActual<typeof import('../../core/queue')>(
        '../../core/queue',
      )
      return {
        ...actual,
        transferProposalBlockerToTask: vi.fn(async () => {
          throw new Error('phase 5 injected failure')
        }),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(proposalId)).rejects.toThrow(
      /phase 5 injected failure/,
    )

    const proposals = await import('../../core/proposals')
    const after = await proposals.getProposal(proposalId)
    // The whole point of the compensating revert: a Phase 5 failure
    // must not strand the proposal at 'sliced'.
    expect(after?.status).toBe('prd-ready')
    // And no tasks must survive — the cleanup loop should have deleted
    // every row Phase 1 inserted.
    expect(await countTasksForProposal(proposalId)).toBe(0)
  })

  it('leaves the proposal at prd-ready when claude -p exits non-zero (slicer outage)', async () => {
    // A genuine slicer outage: claude exits non-zero before any DB
    // write fires. The proposal must remain prd-ready so the daemon's
    // auto-slice loop (which only picks up prd-ready proposals) can
    // retry once the slicer is healthy.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(proposalId)).rejects.toThrow()

    const proposals = await import('../../core/proposals')
    const after = await proposals.getProposal(proposalId)
    expect(after?.status).toBe('prd-ready')
    expect(await countTasksForProposal(proposalId)).toBe(0)

    const actionQueue = await import('../../core/lib/action-queue')
    const failures = await actionQueue.listActionQueueItems('open', { kind: 'slice-failed' })
    expect(failures.filter((item) => item.payload['proposalId'] === proposalId)).toHaveLength(1)
    expect(failures[0].body).toContain('slicer agent crashed')
  })

  it('lets an explicit re-slice clear a recorded failure and create tasks', async () => {
    const failedRun = {
      exitCode: 1,
      stdout: '',
      stderr: 'invalid slicer output',
      sessionId: 'stub-session',
      conversation: [],
    }
    const successfulRun = {
      exitCode: 0,
      stdout: envelope(validSlicerOutput),
      stderr: '',
      sessionId: 'stub-session',
      conversation: [],
    }
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn()
          .mockResolvedValueOnce(failedRun)
          .mockResolvedValueOnce(successfulRun),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()
    const slice = await import('../slice-workflow')

    await expect(slice.runSlice(proposalId)).rejects.toThrow(/invalid slicer output/)
    const proposals = await import('../../core/proposals')
    expect((await proposals.getProposal(proposalId))?.lastSliceError).toContain('invalid slicer output')

    await expect(slice.runSlice(proposalId)).resolves.toMatchObject({ proposalId, status: 'sliced' })
    const after = await proposals.getProposal(proposalId)
    expect(after?.lastSliceError).toBeNull()
    expect(after?.lastSliceFailedAt).toBeNull()
  })

  it('leaves the proposal at prd-ready when generate-slices times out (exit 124)', async () => {
    // Regression test for the original bug: `mars proposal slice 06e677fb`
    // failed when the slicer hit the 300s wall (claude -p exited 124),
    // yet the proposal's status was left as 'sliced' with zero tasks.
    //
    // The exitCode=124 throw fires OUTSIDE the try-catch block (before any
    // Phase 1-4 DB write), so `proposalFlipped` is never set and no compensation
    // is needed. This test pins that: a timeout must NOT set the proposal to
    // 'sliced', and `mars proposal slice` must be re-runnable without a manual
    // `mars proposal set <id> status prd-ready` poke.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    await expect(slice.runSlice(proposalId)).rejects.toThrow(/124/)

    const proposals = await import('../../core/proposals')
    const after = await proposals.getProposal(proposalId)
    // Must remain prd-ready — `mars proposal slice` must be directly re-runnable.
    expect(after?.status).toBe('prd-ready')
    // Zero tasks: no partial state was committed to the queue.
    expect(await countTasksForProposal(proposalId)).toBe(0)
  })

  it('on success: atomically flips proposal to sliced AND inserts the expected slice tasks', async () => {
    // The proposal→sliced status transition must be atomic with successful
    // slice-task creation. This test verifies the "happy path" invariant:
    // a successful runSlice must produce BOTH proposal.status='sliced' AND
    // the expected tasks in the queue — not one without the other.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(proposalId)

    // Status flip: the proposal must now be 'sliced'.
    const proposals = await import('../../core/proposals')
    const after = await proposals.getProposal(proposalId)
    expect(after?.status).toBe('sliced')

    // Task creation: the returned taskIds must match what was inserted.
    expect(result.taskIds).toHaveLength(1)
    expect(await countTasksForProposal(proposalId)).toBe(1)

    // The returned proposalId must match, and status must be the settled string.
    expect(result.proposalId).toBe(proposalId)
    expect(result.status).toBe('sliced')
  })

  it('coordinated proposal enqueues one coordinator task', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope({
            slices: [
              validSlicerOutput.slices[0],
              {
                ...validSlicerOutput.slices[0],
                title: 'dependent slice',
                blockedBy: [1],
              },
            ],
          }),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const queue = await import('../../core/queue')
    const enqueueTask = vi.spyOn(queue, 'enqueueTask')
    const proposalId = await seedPrdReadyProposal({ coordinated: true })

    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(proposalId)

    expect(result.taskIds).toHaveLength(1)
    expect(result.queuedTaskIds).toEqual(result.taskIds)
    expect(enqueueTask).toHaveBeenCalledTimes(1)
    expect(enqueueTask).toHaveBeenCalledWith(
      `Coordinator for PRD ${proposalId}: t`,
      undefined,
      expect.objectContaining({
        originId: proposalId,
        parentProposalId: proposalId,
        intent: 'Coordinator: t',
        spec: expect.objectContaining({
          executionMode: 'coordinated',
          slicePlan: expect.arrayContaining([
            expect.objectContaining({ title: 't' }),
            expect.objectContaining({ title: 'dependent slice', blockedBy: [1] }),
          ]),
        }),
      }),
    )

    const rows = await queue.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [result.taskIds[0]],
    })
    expect(Number((rows.rows[0] as { n: number | bigint }).n)).toBe(0)
  })

  it('restarts a promoted slice once and auto-approves the recovered tasks', async () => {
    // Crash-recovery deduplication: a process crash between Phase 1
    // (task inserts) and Phase 4 (status flip) leaves the proposal prd-ready
    // with orphaned tasks from the crashed run. Without a pre-flight
    // cleanup, a retry would INSERT a second set of tasks on top of the
    // orphans, duplicating the queue work. The pre-flight must delete any
    // tasks with parent_proposal_id = proposal.id before Phase 1 runs, so a
    // retry lands exactly N tasks — not N orphans + N fresh ones.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    // Simulate the crash: manually insert an orphaned task that claims
    // this proposal as its parent (as if Phase 1 ran but the process died
    // before Phase 4 could flip the status).
    const queue = await vi.importActual<typeof import('../../core/queue')>(
      '../../core/queue',
    )
    await queue.migrateQueueSchema()
    await queue.enqueueTask('orphaned task from crashed run', undefined, {
      parentProposalId: proposalId,
      sliceIndex: 1,
    })
    expect(await countTasksForProposal(proposalId)).toBe(1) // orphan is there

    // Reloading modules models a daemon restart before it retries the slice.
    vi.resetModules()
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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

    // Now re-run the slice — this is the retry after the crash.
    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(proposalId)

    // The retry must produce exactly the fresh slicer output (1 slice),
    // not 1 orphan + 1 new = 2. The orphan must have been cleaned up.
    expect(result.taskIds).toHaveLength(1)
    expect(await countTasksForProposal(proposalId)).toBe(1)

    // And the proposal must now be sliced (not prd-ready).
    const proposals = await import('../../core/proposals')
    const after = await proposals.getProposal(proposalId)
    expect(after?.status).toBe('sliced')
    expect(result.queuedTaskIds).toEqual(result.taskIds)
    expect(result.blockedTaskIds).toEqual([])
    const restartedQueue = await import('../../core/queue')
    expect((await restartedQueue.getTask(result.taskIds[0]))?.status).toBe('queued')
  })

  it('slice tasks inherit the priority passed to runSlice', async () => {
    // When runSlice is called with an explicit priority, every task it
    // creates must land in the queue with that priority — not the default 0.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(proposalId, undefined, { priority: 2 })

    expect(result.taskIds).toHaveLength(1)

    const queue = await vi.importActual<typeof import('../../core/queue')>(
      '../../core/queue',
    )
    const task = await queue.getTask(result.taskIds[0])
    expect(task?.priority).toBe(2)
  })
})

// Stub that throws if the direction judge is called — used to verify that
// certain pairs (e.g. schema-drop vs non-close pairs) never reach Stage 2.
const neverCalledJudge = async (): Promise<DirectionVerdict> => {
  throw new Error('judgeDirection should not be called for this pair')
}

// No-op judge: reports no dependency for any pair. Used when Stage 2 will
// be triggered (close pairs exist) but we want no extra edges injected.
const noopJudge = async (): Promise<DirectionVerdict> => ({ hasDependency: false })

describe('injectAutoLinkerBlockers: schema-drop ↔ consumer edges (Stage 1)', () => {
  // Mirrors the concrete failure from PRD
  // 1b7498f6-remove-all-usd-cost-usd-mentions-from-th: a "Drop
  // legacy_data_col column from queue.db schema (hard cut, no migration)"
  // slice was emitted with ZERO blocker edges even though three sibling
  // slices removed the read-side of the same column. The drop dispatched
  // first and burned its full retry budget on
  // `SQLITE_ERROR: no such column: s.legacy_data_col`. Six actionQueue items
  // later (final one 496b528e), the operator manually wired the edges.
  // This test pins the injection so the regression cannot recur silently.
  it('blocks a schema-drop slice on every consumer slice that mentions the dropped column (1b7498f6 shape)', async () => {
    const slices = [
      {
        title: 'Update README to drop mentions of legacy_data_col from cost docs',
        whatToBuild: 'Edit README to remove the legacy_data_col column from cost docs',
        blockedBy: [] as number[],
      },
      {
        title: 'Remove legacy_data_col from claude-usage parser',
        whatToBuild: 'Stop reading legacy_data_col from the parser output',
        blockedBy: [] as number[],
      },
      {
        title: 'Remove legacy_data_col from reflect-signals storage layer',
        whatToBuild: 'Stop writing legacy_data_col through the storage layer',
        blockedBy: [] as number[],
      },
      {
        title: 'Remove legacy_data_col from reflect-query aggregation',
        whatToBuild: 'Stop summing legacy_data_col in the aggregation query',
        blockedBy: [] as number[],
      },
      {
        title: 'Drop legacy_data_col column from queue.db schema (hard cut, no migration)',
        whatToBuild: 'Drop the legacy_data_col column from the tasks table',
        blockedBy: [] as number[],
      },
    ]

    // Consumer slices also share `legacy_data_col` with each other, so Stage 2
    // will be called for those pairs. Pass noopJudge so no extra edges are added.
    await injectAutoLinkerBlockers(slices, noopJudge)

    // Schema-drop (slice 5, 1-based) must wait on every consumer slice
    // (1..4) that mentions legacy_data_col.
    expect(slices[4].blockedBy).toEqual([1, 2, 3, 4])
    // Consumer slices must NOT acquire reverse edges — only the drop is
    // repaired.
    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([])
    expect(slices[2].blockedBy).toEqual([])
    expect(slices[3].blockedBy).toEqual([])
  })

  it('preserves consumer-slice upstream blockers — does not flatten the dependency tree', async () => {
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

    // Slices 0 and 1 share `foo_bar` → Stage 2 will run for that pair.
    // Pass noopJudge so it doesn't add extra edges beyond Stage 1's injection.
    await injectAutoLinkerBlockers(slices, noopJudge)

    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([1])
    expect(slices[2].blockedBy).toEqual([1, 2])
  })

  it('is a no-op when the PRD contains no schema-drop slice', async () => {
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

    // No schema-drop slice → Stage 1 is a no-op.
    // The pair IS close enough (both have no shared identifiers here,
    // so Stage 2 closeness check will also fail) — but we still pass
    // neverCalledJudge to confirm Stage 2 is skipped for non-close pairs.
    const noopJudge = async (): Promise<DirectionVerdict> => ({ hasDependency: false })
    await injectAutoLinkerBlockers(slices, noopJudge)

    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('avoids cycles when a consumer slice already declares the schema-drop as its upstream', async () => {
    const slices = [
      {
        // Inverted slicer ordering: consumer says it waits on the drop.
        // Adding the reverse edge would produce a 1↔2 cycle.
        title: 'Remove legacy_data_col from parser',
        whatToBuild: '',
        blockedBy: [2],
      },
      {
        title: 'Drop legacy_data_col column from schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    await injectAutoLinkerBlockers(slices, neverCalledJudge)

    expect(slices[0].blockedBy).toEqual([2])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('does not link slices that share no snake_case identifier with the drop', async () => {
    const slices = [
      {
        title: 'Tweak unrelated docs',
        whatToBuild: 'Update README front matter',
        blockedBy: [] as number[],
      },
      {
        title: 'Drop legacy_data_col column from queue.db schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    await injectAutoLinkerBlockers(slices, neverCalledJudge)

    expect(slices[1].blockedBy).toEqual([])
  })

  it('is idempotent — re-running over already-injected slices produces no duplicates', async () => {
    const slices = [
      {
        title: 'Remove legacy_data_col from parser',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
      {
        title: 'Drop legacy_data_col column from schema',
        whatToBuild: '',
        blockedBy: [] as number[],
      },
    ]

    await injectAutoLinkerBlockers(slices, neverCalledJudge)
    await injectAutoLinkerBlockers(slices, neverCalledJudge)

    expect(slices[1].blockedBy).toEqual([1])
  })
})

describe('injectAutoLinkerBlockers: general producer→consumer edges (Stage 2)', () => {
  it('infers a producer→consumer edge when the LLM judges aBlocksB: true', async () => {
    const slices = [
      {
        title: 'Add getUserProfile API endpoint',
        whatToBuild: 'Expose getUserProfile in api/users.ts',
        prescriptiveAction: 'Add `getUserProfile` handler to src/api/users.ts.',
        blockedBy: [] as number[],
      },
      {
        title: 'Wire the UI to getUserProfile',
        whatToBuild: 'Call getUserProfile from the profile page',
        prescriptiveAction: 'Import `getUserProfile` from src/api/users.ts in ProfilePage.',
        blockedBy: [] as number[],
      },
    ]

    // Judge confirms: slice A (add API) blocks slice B (wire UI)
    const judge = async (): Promise<DirectionVerdict> => ({
      hasDependency: true,
      aBlocksB: true,
    })
    await injectAutoLinkerBlockers(slices, judge)

    // Slice B (index 1) must wait on slice A (index 0) → 1-based index = 1
    expect(slices[1].blockedBy).toEqual([1])
    expect(slices[0].blockedBy).toEqual([])
  })

  it('infers a consumer→producer edge when the LLM judges aBlocksB: false', async () => {
    const slices = [
      {
        title: 'Wire UI to fetchUserData',
        whatToBuild: 'Call fetchUserData from dashboard component',
        prescriptiveAction: 'Import `fetchUserData` from src/api/data.ts in Dashboard.',
        blockedBy: [] as number[],
      },
      {
        title: 'Add fetchUserData endpoint',
        whatToBuild: 'Expose fetchUserData in api/data.ts',
        prescriptiveAction: 'Add `fetchUserData` handler to src/api/data.ts.',
        blockedBy: [] as number[],
      },
    ]

    // Judge says: B (add endpoint) must complete before A (wire UI) — aBlocksB: false
    const judge = async (): Promise<DirectionVerdict> => ({
      hasDependency: true,
      aBlocksB: false,
    })
    await injectAutoLinkerBlockers(slices, judge)

    // Slice A (index 0) must wait on slice B (index 1) → 1-based index = 2
    expect(slices[0].blockedBy).toEqual([2])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('adds no edge when the LLM judges hasDependency: false', async () => {
    const slices = [
      {
        title: 'Add getUserProfile endpoint',
        whatToBuild: 'Expose getUserProfile in api/users.ts',
        prescriptiveAction: 'Add `getUserProfile` to src/api/users.ts.',
        blockedBy: [] as number[],
      },
      {
        title: 'Refactor getUserProfile logging',
        whatToBuild: 'Improve getUserProfile logging in api/users.ts',
        prescriptiveAction: 'Update log calls in `getUserProfile` in src/api/users.ts.',
        blockedBy: [] as number[],
      },
    ]

    const judge = async (): Promise<DirectionVerdict> => ({ hasDependency: false })
    await injectAutoLinkerBlockers(slices, judge)

    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('cycle guard refuses an edge that would close a cycle', async () => {
    // The slicer already wired: slice 2 (index 1) depends on slice 1 (index 0).
    // The judge now says slice 1 also depends on slice 2 — that would be a cycle.
    const slices = [
      {
        title: 'Add processOrder handler',
        whatToBuild: 'Add processOrder in orders/handler.ts',
        prescriptiveAction: 'Add `processOrder` to src/orders/handler.ts.',
        blockedBy: [2], // already declared: slice 1 waits on slice 2
      },
      {
        title: 'Wire processOrder to the checkout flow',
        whatToBuild: 'Call processOrder from checkout',
        prescriptiveAction: 'Import `processOrder` in src/checkout/flow.ts.',
        blockedBy: [] as number[],
      },
    ]

    // Judge says: A (index 0) also needs to complete before B (index 1).
    // But B is already a blocker of A — adding A→B creates a cycle.
    const judge = async (): Promise<DirectionVerdict> => ({
      hasDependency: true,
      aBlocksB: true,
    })
    await injectAutoLinkerBlockers(slices, judge)

    // Edge must NOT be added — graph stays acyclic.
    expect(slices[0].blockedBy).toEqual([2])
    expect(slices[1].blockedBy).toEqual([])
  })

  it('is idempotent — re-running with the same judge produces no duplicates', async () => {
    const slices = [
      {
        title: 'Add getUserProfile endpoint',
        whatToBuild: 'Expose getUserProfile in api/users.ts',
        prescriptiveAction: 'Add `getUserProfile` to src/api/users.ts.',
        blockedBy: [] as number[],
      },
      {
        title: 'Wire the UI to getUserProfile',
        whatToBuild: 'Call getUserProfile from the profile page',
        prescriptiveAction: 'Import `getUserProfile` from src/api/users.ts in ProfilePage.',
        blockedBy: [] as number[],
      },
    ]

    const judge = async (): Promise<DirectionVerdict> => ({
      hasDependency: true,
      aBlocksB: true,
    })
    await injectAutoLinkerBlockers(slices, judge)
    await injectAutoLinkerBlockers(slices, judge)

    expect(slices[1].blockedBy).toEqual([1])
    expect(slices[0].blockedBy).toEqual([])
  })

  it('does not call the judge for pairs that are not close enough', async () => {
    const slices = [
      {
        title: 'Update documentation',
        whatToBuild: 'Edit README',
        blockedBy: [] as number[],
      },
      {
        title: 'Refactor database schema',
        whatToBuild: 'Change table structure',
        blockedBy: [] as number[],
      },
    ]

    let judgeCallCount = 0
    const judge = async (): Promise<DirectionVerdict> => {
      judgeCallCount++
      return { hasDependency: false }
    }
    await injectAutoLinkerBlockers(slices, judge)

    // No shared identifiers or file paths → closeness check fails → judge never called
    expect(judgeCallCount).toBe(0)
    expect(slices[0].blockedBy).toEqual([])
    expect(slices[1].blockedBy).toEqual([])
  })
})

describe('injectAutoLinkerBlockers: file-overlap mechanical edges (Stage 1.5)', () => {
  it('forces a sequential edge for two slices sharing a declared file, with earlier blocking later', async () => {
    const slices = [
      {
        title: 'Add auth middleware',
        whatToBuild: 'Add JWT middleware to src/middleware/auth.ts',
        modifies: [] as string[],
        creates: ['src/middleware/auth.ts'],
        blockedBy: [] as number[],
      },
      {
        title: 'Wire auth middleware into routes',
        whatToBuild: 'Import auth middleware in src/routes/api.ts and src/middleware/auth.ts',
        modifies: ['src/middleware/auth.ts'] as string[],
        creates: [] as string[],
        blockedBy: [] as number[],
      },
    ]

    let judgeCallCount = 0
    const judge = async (): Promise<DirectionVerdict> => {
      judgeCallCount++
      return { hasDependency: false }
    }

    const result = await injectAutoLinkerBlockers(slices, judge)

    // File-overlap detected: both slices declare src/middleware/auth.ts
    // Direction: slice 0 (earlier) blocks slice 1 (later)
    expect(slices[1].blockedBy).toEqual([1])
    expect(slices[0].blockedBy).toEqual([])
    // The judge must NOT be called for the overlapping pair — mechanical wins
    expect(judgeCallCount).toBe(0)
    // The injected edge should be tagged 'file-overlap'
    expect(result.injected).toEqual([
      { dependerIdx: 1, blockerOneBased: 1, provenance: 'file-overlap' },
    ])
  })

  it('does not call the judge for file-overlap pairs (mechanical wins over inferred)', async () => {
    // Two slices share a file → mechanical edge is forced.
    // If the judge were called, it might propose an edge in EITHER direction.
    // We verify the judge is never called for overlapping pairs.
    const slices = [
      {
        title: 'Create database schema',
        whatToBuild: 'Write migrations in db/schema.ts',
        modifies: [] as string[],
        creates: ['db/schema.ts'],
        blockedBy: [] as number[],
      },
      {
        title: 'Seed database with initial data',
        whatToBuild: 'Add seed data in db/schema.ts',
        modifies: ['db/schema.ts'] as string[],
        creates: [] as string[],
        blockedBy: [] as number[],
      },
    ]

    let judgeCallCount = 0
    // Judge would propose the OPPOSITE direction if called — but mechanical wins
    const judge = async (): Promise<DirectionVerdict> => {
      judgeCallCount++
      return { hasDependency: true, aBlocksB: false } // would say: slice 1 blocks slice 0
    }

    await injectAutoLinkerBlockers(slices, judge)

    // Mechanical edge (slice 0 blocks slice 1) must be in place
    expect(slices[1].blockedBy).toEqual([1])
    expect(slices[0].blockedBy).toEqual([])
    // LLM was never consulted — mechanical edge takes priority
    expect(judgeCallCount).toBe(0)
  })

  it('breaks cycles by dropping inferred edges, never mechanical ones', async () => {
    // Chain of file-overlap mechanical edges: 0 blocks 1, 1 blocks 2.
    // The LLM then proposes (for the non-overlapping pair 0↔2): 2 blocks 0.
    // That would close the cycle 0→1→2→0. The cycle guard must drop the
    // inferred edge (2 blocks 0) and keep both mechanical edges.
    const slices = [
      {
        title: 'Define processOrder schema',
        whatToBuild: 'Write processOrder types in src/orders/schema.ts',
        prescriptiveAction: 'Export `OrderSchema` from src/orders/schema.ts.',
        modifies: [] as string[],
        creates: ['src/orders/schema.ts'],
        blockedBy: [] as number[],
      },
      {
        title: 'Implement processOrder handler',
        whatToBuild: 'Add processOrder handler using the schema',
        prescriptiveAction: 'Import `OrderSchema` in src/orders/handler.ts.',
        modifies: ['src/orders/schema.ts'] as string[], // shares file with slice 0 → mechanical: 0 blocks 1
        creates: ['src/orders/handler.ts'],
        blockedBy: [] as number[],
      },
      {
        title: 'Wire processOrder into routes',
        whatToBuild: 'Register processOrder in the router',
        prescriptiveAction: 'Import `processOrder` from src/orders/handler.ts in src/router.ts.',
        modifies: ['src/orders/handler.ts'] as string[], // shares file with slice 1 → mechanical: 1 blocks 2
        creates: [] as string[],
        blockedBy: [] as number[],
      },
    ]

    // After Stage 1.5:
    //   slices[1].blockedBy = [1]  (mechanical: 0 blocks 1)
    //   slices[2].blockedBy = [2]  (mechanical: 1 blocks 2)
    //
    // LLM for pair (0, 2) — no shared files, but shares 'processOrder' identifier:
    //   aBlocksB: false → B (index 2) blocks A (index 0) → dependerIdx=0, blockerOneBased=3
    //   This would close cycle: 0 waits for 2 (new edge), 2 waits for 1, 1 waits for 0.
    //   wouldCreateCycle must detect it and drop the edge.
    const judge = async (
      _a: { title: string },
      b: { title: string },
    ): Promise<DirectionVerdict> => {
      // Pair (0, 2): 'routes' slice should block the 'schema' slice — cycle!
      if (b.title.includes('routes')) {
        return { hasDependency: true, aBlocksB: false } // B (routes=2) blocks A (schema=0)
      }
      return { hasDependency: false }
    }

    const result = await injectAutoLinkerBlockers(slices, judge)

    // Both mechanical edges must survive
    expect(slices[1].blockedBy).toContain(1) // 0 blocks 1
    expect(slices[2].blockedBy).toContain(2) // 1 blocks 2
    // The inferred edge (2 blocks 0) must have been DROPPED — it would close the cycle
    expect(slices[0].blockedBy).not.toContain(3)
    // The dropped cycle must be reported in the result
    expect(result.droppedCycles.length).toBeGreaterThan(0)
    // Both mechanical edges must appear in injected with 'file-overlap' provenance
    expect(result.injected).toContainEqual(
      expect.objectContaining({ dependerIdx: 1, blockerOneBased: 1, provenance: 'file-overlap' }),
    )
    expect(result.injected).toContainEqual(
      expect.objectContaining({ dependerIdx: 2, blockerOneBased: 2, provenance: 'file-overlap' }),
    )
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
    // These tests stub the CLAUDE provider entry point (runClaudeCode). The
    // worker provider defaults to codex, so without this pin the stub is never
    // consulted and the Slicer shells out to a real `codex exec` that hangs
    // until the 30s test timeout.
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../core/lib/git/claude')
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKER_PROVIDER
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const seedPrdReadyProposal = async (): Promise<string> => {
    const proposals = await import('../../core/proposals')
    await proposals.initProposals()
    const proposal = await proposals.createProposal('Remove legacy_data_col', {
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(proposal.id, 'as a user, I want X')
    const promoted = await proposals.promoteProposal(proposal.id)
    expect(promoted.status).toBe('prd-ready')
    return proposal.id
  }

  // Mirrors the 8-slice / no-blockers shape that PRD
  // 1b7498f6-remove-all-usd-cost-usd-mentions-from-th emitted: a
  // schema-drop slice plus four consumer slices that mention
  // legacy_data_col, every slice's `blockedBy` empty. After runSlice
  // lands, the schema-drop task must have task_blocker rows pointing
  // at each consumer.
  const slicer1b7498f6Shape = {
    slices: [
      {
        title: 'Update README to drop mentions of legacy_data_col from cost docs',
        type: 'AFK' as const,
        whatToBuild: 'Edit the README to drop mentions of legacy_data_col',
        acceptanceCriteria: ['README updated'],
        blockedBy: [] as number[],
        readFirst: ['README.md'] as string[],
        prescriptiveAction: 'Remove the legacy_data_col column from the cost-tracking table in README.md.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
      },
      {
        title: 'Remove legacy_data_col from claude-usage parser',
        type: 'AFK' as const,
        whatToBuild: 'Stop reading legacy_data_col from the parser output',
        acceptanceCriteria: ['parser no longer references legacy_data_col'],
        blockedBy: [] as number[],
        readFirst: ['orchestrator/src/core/lib/claude-usage.ts'] as string[],
        prescriptiveAction: 'Delete the legacy_data_col field from the ClaudeUsage type and its parser in claude-usage.ts.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
      },
      {
        title: 'Remove legacy_data_col from reflect-signals storage layer',
        type: 'AFK' as const,
        whatToBuild: 'Stop writing legacy_data_col through the storage layer',
        acceptanceCriteria: ['storage layer no longer writes legacy_data_col'],
        blockedBy: [] as number[],
        readFirst: ['orchestrator/src/core/reflect-signals.ts'] as string[],
        prescriptiveAction: 'Remove legacy_data_col from the INSERT statement and the ReflectSignal type in reflect-signals.ts.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
      },
      {
        title: 'Remove legacy_data_col from reflect-query aggregation',
        type: 'AFK' as const,
        whatToBuild: 'Stop summing legacy_data_col in the aggregation query',
        acceptanceCriteria: ['aggregation no longer references legacy_data_col'],
        blockedBy: [] as number[],
        readFirst: ['orchestrator/src/core/reflect-query.ts'] as string[],
        prescriptiveAction: 'Remove `SUM(s.legacy_data_col)` from the SELECT in the aggregation query in reflect-query.ts.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
      },
      {
        title:
          'Drop legacy_data_col column from queue.db schema (hard cut, no migration)',
        type: 'AFK' as const,
        whatToBuild: 'Drop the legacy_data_col column from the tasks table',
        acceptanceCriteria: ['legacy_data_col column dropped'],
        blockedBy: [] as number[],
        readFirst: ['orchestrator/src/core/queue.ts'] as string[],
        prescriptiveAction: 'In queue.ts, remove the `legacy_data_col REAL` column definition from the CREATE TABLE tasks DDL and drop it from all INSERT/SELECT statements.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
      },
    ],
  }

  it('persists blocker edges from the schema-drop slice onto every consumer slice', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
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
    const proposalId = await seedPrdReadyProposal()

    const slice = await import('../slice-workflow')
    const result = await slice.runSlice(proposalId)
    expect(result.taskIds).toHaveLength(5)
    const [readmeId, parserId, storageId, aggregationId, dropId] = result.taskIds

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const rows = await queue.resolveQueueClient().execute({
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
    const dropRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [dropId],
    })
    expect(
      (dropRow.rows[0] as unknown as { status: string }).status,
    ).toBe('blocked')
    const parserRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [parserId],
    })
    expect(
      (parserRow.rows[0] as unknown as { status: string }).status,
    ).toBe('queued')
  })
})

describe('composeTaskPrompt: parent digest replaces full PRD dump', () => {
  // Dispatched coders run from .mars/worktrees/<id>/ where `mars` walks up
  // from CWD and binds to the worktree's own (empty) .mars/. Instead of
  // inlining the full PRD verbatim (which bloats every slice prompt with the
  // same multi-KB body), the prompt now carries a short, bounded digest:
  // parent goal in 1-2 sentences, this slice's blockers, and the PRD's
  // non-goals. The worker can act on the slice without any preparatory read.
  const sampleProposal = {
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
    kind: 'coder' as const,
    whatToBuild: 'Inline the PRD fields into the slice prompt.',
    acceptanceCriteria: ['prompt contains the PRD body'],
    blockedBy: [] as number[],
    readFirst: [
      'orchestrator/src/core/workflows/slice-workflow.ts',
    ] as string[],
    prescriptiveAction:
      'In composeTaskPrompt (slice-workflow.ts), inline proposal.title, proposal.solution, and proposal.outOfScope into the returned template string.',
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,    mergeMode: 'auto' as const,
  }

  it('contains a parent digest section with goal, blockers, and non-goals labels', () => {
    const prompt = composeTaskPrompt(sampleProposal, sampleSlice, 1, 1)
    expect(prompt).toContain('## Parent digest')
    expect(prompt).toContain('**Goal:**')
    expect(prompt).toContain('**Blockers:**')
    expect(prompt).toContain('**Non-goals:**')
  })

  it('digest goal derives from the PRD solution', () => {
    const prompt = composeTaskPrompt(sampleProposal, sampleSlice, 1, 1)
    // The solution is short — it fits inside the goal limit verbatim.
    expect(prompt).toContain(sampleProposal.solution)
  })

  it('digest goal falls back to title when solution is empty', () => {
    const noSolution = { ...sampleProposal, solution: '' }
    const prompt = composeTaskPrompt(noSolution, sampleSlice, 1, 1)
    expect(prompt).toContain(sampleProposal.title)
  })

  it('digest shows (none) for blockers when the slice has no dependencies', () => {
    const prompt = composeTaskPrompt(sampleProposal, sampleSlice, 1, 1)
    // blockedBy is [] — the digest must say "(none)", not a blank line.
    expect(prompt).toMatch(/\*\*Blockers:\*\* \(none\)/)
  })

  it('digest shows slice indices when the slice has blockers', () => {
    const blockedSlice = { ...sampleSlice, blockedBy: [1, 3] }
    const prompt = composeTaskPrompt(sampleProposal, blockedSlice, 2, 3)
    expect(prompt).toMatch(/\*\*Blockers:\*\*.*1.*3/)
  })

  it('digest non-goals derives from the PRD out-of-scope', () => {
    const prompt = composeTaskPrompt(sampleProposal, sampleSlice, 1, 1)
    // The outOfScope is short — it fits inside the non-goals limit verbatim.
    expect(prompt).toContain(sampleProposal.outOfScope)
  })

  it('digest shows (none) for non-goals when out-of-scope is empty', () => {
    const noScope = { ...sampleProposal, outOfScope: '' }
    const prompt = composeTaskPrompt(noScope, sampleSlice, 1, 1)
    expect(prompt).toMatch(/\*\*Non-goals:\*\* \(none\)/)
  })

  it('digest goal is truncated when solution exceeds the character limit', () => {
    const long = 'A '.repeat(200).trim() // 400 chars — well above DIGEST_GOAL_CHARS
    const longIdea = { ...sampleProposal, solution: long }
    const prompt = composeTaskPrompt(longIdea, sampleSlice, 1, 1)
    // The full solution must NOT appear verbatim.
    expect(prompt).not.toContain(long)
    // But the goal line must still have content.
    expect(prompt).toMatch(/\*\*Goal:\*\* .+/)
  })

  it('digest non-goals is truncated when out-of-scope exceeds the character limit', () => {
    const long = 'B '.repeat(200).trim() // 400 chars — well above DIGEST_NON_GOALS_CHARS
    const longIdea = { ...sampleProposal, outOfScope: long }
    const prompt = composeTaskPrompt(longIdea, sampleSlice, 1, 1)
    expect(prompt).not.toContain(long)
    expect(prompt).toMatch(/\*\*Non-goals:\*\* .+/)
  })

  it('does NOT include full PRD body fields (notes, user stories) in the prompt', () => {
    const prompt = composeTaskPrompt(sampleProposal, sampleSlice, 1, 1)
    // Notes and user stories are NOT part of the digest.
    expect(prompt).not.toContain(sampleProposal.notes)
    for (const story of sampleProposal.userStories) {
      expect(prompt).not.toContain(story)
    }
  })

  it('does NOT instruct the implementor to run `mars proposal show` (worktree DB is empty)', () => {
    const prompt = composeTaskPrompt(sampleProposal, sampleSlice, 1, 1)
    // Either form would silently fail from a worktree CWD; both are banned.
    expect(prompt).not.toMatch(/mars proposal show/i)
    expect(prompt).not.toMatch(/mars\s+--repo\s+\S+\s+proposal\s+show/i)
  })

  it('a slice with no blockers and no out-of-scope produces a coherent digest', () => {
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
    expect(prompt).toContain('## Parent digest')
    // Both empty fields fall back to a clear placeholder.
    expect(prompt).toMatch(/\*\*Non-goals:\*\* \(none\)/)
    expect(prompt).toMatch(/\*\*Blockers:\*\* \(none\)/)
    // Goal falls back to the title when solution is empty.
    expect(prompt).toMatch(/\*\*Goal:\*\* .+/)
  })
})

describe('describeSliceFailure', () => {
  it('includes the thrown error text, not just the status word', () => {
    const result = {
      status: 'failed',
      error: new Error('slicer agent returned invalid JSON: unexpected token'),
    }

    const msg = describeSliceFailure(result)

    expect(msg).toContain('slice workflow failed')
    expect(msg).toContain('slicer agent returned invalid JSON: unexpected token')
    // The whole point: the cause is present, not discarded.
    expect(msg).not.toBe('slice workflow failed')
  })

  it('handles a serialized (storage-rehydrated) error object', () => {
    const result = {
      status: 'failed',
      error: {
        name: 'TimeoutError',
        message: 'claude -p exceeded deadline after 600000ms',
        stack: 'TimeoutError: ...',
      },
    }

    const msg = describeSliceFailure(result)

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
    const msg = describeSliceFailure({ status: 'failed' })

    expect(msg).toBe('slice workflow failed')
  })

  it('bounds the message length so it stays log-friendly', () => {
    const huge = 'x'.repeat(5000)
    const msg = describeSliceFailure({
      status: 'failed',
      error: new Error(huge),
    })

    expect(msg.length).toBeLessThanOrEqual(1001) // 1000 + ellipsis
    expect(msg.endsWith('…')).toBe(true)
  })
})

describe('composeTaskPrompt: Files section', () => {
  const proposal = {
    id: 'idea-files',
    title: 'Render Files Section',
    problem: 'Coders must discover paths the slicer already named.',
    solution: 'Surface them in a Files section of the Coder prompt.',
    outOfScope: 'Parsing imports to infer missing files.',
    notes: '',
    userStories: [],
  }

  it('contains a Files section listing each modifies entry as a bullet', () => {
    const slice = {
      title: 'Add Files section',
      type: 'AFK' as const,
      kind: 'coder' as const,
      whatToBuild: 'Render modifies paths as bullets.',
      acceptanceCriteria: ['Files section present'],
      blockedBy: [] as number[],
      readFirst: ['src/foo.ts', 'src/bar.ts'] as string[],
      prescriptiveAction: 'In fooFn (src/foo.ts:1), add logging.',
      modifies: ['src/foo.ts', 'src/bar.ts'],
      creates: [] as string[],
      verifyCmd: null,      mergeMode: 'auto' as const,
    }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).toContain('## Files')
    expect(prompt).toContain('- src/foo.ts')
    expect(prompt).toContain('- src/bar.ts')
  })

  it('contains a Files section listing each creates entry as a bullet', () => {
    const slice = {
      title: 'Add Files section',
      type: 'AFK' as const,
      kind: 'coder' as const,
      whatToBuild: 'Render creates paths as bullets.',
      acceptanceCriteria: ['Files section present'],
      blockedBy: [] as number[],
      readFirst: ['src/bar.ts'] as string[],
      prescriptiveAction: 'Create src/new.test.ts with a test for barFn.',
      modifies: [] as string[],
      creates: ['src/new.test.ts'],
      verifyCmd: null,      mergeMode: 'auto' as const,
    }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).toContain('## Files')
    expect(prompt).toContain('- src/new.test.ts')
  })

  it("preserves the 'NEW: ' prefix verbatim in the rendered creates entries", () => {
    const slice = {
      title: 'Add Files section',
      type: 'AFK' as const,
      kind: 'coder' as const,
      whatToBuild: 'Render creates with NEW: prefix.',
      acceptanceCriteria: ['NEW: prefix preserved'],
      blockedBy: [] as number[],
      readFirst: ['orchestrator/src/core/context.ts'] as string[],
      prescriptiveAction:
        'Create loadManifest() in NEW: orchestrator/src/manifest/load.ts.',
      modifies: [] as string[],
      creates: ['NEW: orchestrator/src/manifest/load.ts'],
      verifyCmd: null,      mergeMode: 'auto' as const,
    }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).toContain('## Files')
    expect(prompt).toContain('- NEW: orchestrator/src/manifest/load.ts')
  })

  it('does not emit a Files section when both modifies and creates are empty', () => {
    const slice = {
      title: 'Add Files section',
      type: 'AFK' as const,
      kind: 'coder' as const,
      whatToBuild: 'No files named.',
      acceptanceCriteria: ['no crash'],
      blockedBy: [] as number[],
      readFirst: ['src/index.ts'] as string[],
      prescriptiveAction: 'Review src/index.ts and decide if changes needed.',
      modifies: [] as string[],
      creates: [] as string[],
      verifyCmd: null,      mergeMode: 'auto' as const,
    }
    // Must not throw and must not emit the section at all (HITL / empty-files case).
    expect(() => composeTaskPrompt(proposal, slice, 1, 1)).not.toThrow()
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).not.toContain('## Files')
  })

  it('lists modifies before creates, both arrays together under one section', () => {
    const slice = {
      title: 'Add Files section',
      type: 'AFK' as const,
      kind: 'coder' as const,
      whatToBuild: 'Render all paths.',
      acceptanceCriteria: ['all paths present'],
      blockedBy: [] as number[],
      readFirst: ['src/existing.ts'] as string[],
      prescriptiveAction:
        'Extend existingFn in src/existing.ts and create src/brand-new/load.ts.',
      modifies: ['src/existing.ts'],
      creates: ['NEW: src/brand-new/load.ts', 'src/another.test.ts'],
      verifyCmd: null,      mergeMode: 'auto' as const,
    }
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
    expect(prompt).toContain('## Files')
    expect(prompt).toContain('- src/existing.ts')
    expect(prompt).toContain('- NEW: src/brand-new/load.ts')
    expect(prompt).toContain('- src/another.test.ts')
    // Modifies before creates: existing.ts should appear before brand-new/load.ts
    const modIdx = prompt.indexOf('- src/existing.ts')
    const creIdx = prompt.indexOf('- NEW: src/brand-new/load.ts')
    expect(modIdx).toBeLessThan(creIdx)
  })
})

describe('runSlice → queue: explicit blockedBy edges for sequential PRDs', () => {
  // Acceptance criterion: a 3-slice PRD whose slices declare consecutive
  // blockedBy edges (2←1, 3←2) must produce exactly two task_blockers rows
  // — one per consecutive pair — so dispatch gates on prerequisite-task
  // success, not just enqueue order.
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-dag-'))
    execFileSync('git', ['init', '-q'], { cwd: r })
    mkdirSync(resolve(r, '.mars'), { recursive: true })
    return r
  }

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    // These tests stub the CLAUDE provider entry point (runClaudeCode). The
    // worker provider defaults to codex, so without this pin the stub is never
    // consulted and the Slicer shells out to a real `codex exec` that hangs
    // until the 30s test timeout.
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../core/lib/git/claude')
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKER_PROVIDER
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const seedPrdReadyProposal = async (): Promise<string> => {
    const proposals = await import('../../core/proposals')
    await proposals.initProposals()
    const proposal = await proposals.createProposal('3-slice sequential PRD', {
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(proposal.id, 'as a user, I want X')
    const promoted = await proposals.promoteProposal(proposal.id)
    expect(promoted.status).toBe('prd-ready')
    return proposal.id
  }

  it('persists a task_blockers row for each consecutive pair when slices declare sequential blockedBy', async () => {
    // 3-slice chain: slice 2 blocked by slice 1, slice 3 blocked by slice 2.
    // The slicer emits no schema-drop patterns, so injectSchemaDropBlockers
    // is a no-op — only the explicit blockedBy declarations produce edges.
    const threeSliceSequential = {
      slices: [
        {
          title: 'Foundation: set up the data model',
          type: 'AFK' as const,
          whatToBuild: 'Create the core data model',
          acceptanceCriteria: ['data model is in place'],
          blockedBy: [] as number[],
          readFirst: ['src/models/index.ts'] as string[],
          prescriptiveAction: 'Create the DataModel interface in src/models/index.ts with id and name fields.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
        {
          title: 'Service layer: expose the data model via an API',
          type: 'AFK' as const,
          whatToBuild: 'Wrap the data model in a service',
          acceptanceCriteria: ['service layer works'],
          blockedBy: [1] as number[],
          readFirst: ['src/services/data.ts'] as string[],
          prescriptiveAction: 'Create getDataModel() in src/services/data.ts returning DataModel from src/models/index.ts.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
        {
          title: 'UI layer: render the API response',
          type: 'AFK' as const,
          whatToBuild: 'Display the service output in the UI',
          acceptanceCriteria: ['UI renders correctly end-to-end'],
          blockedBy: [2] as number[],
          readFirst: ['src/components/DataView.tsx'] as string[],
          prescriptiveAction: 'In DataView.tsx, call getDataModel() from src/services/data.ts and render model.name in an <h1>.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
      ],
    }

    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(threeSliceSequential),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    expect(result.taskIds).toHaveLength(3)

    const [task1Id, task2Id, task3Id] = result.taskIds

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // Consecutive pair 1→2: task 2 must be blocked by task 1
    const blockers2 = await queue.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ? ORDER BY blocker_task_id`,
      args: [task2Id],
    })
    expect(
      blockers2.rows.map(
        (r) => (r as unknown as { blocker_task_id: string }).blocker_task_id,
      ),
    ).toEqual([task1Id])

    // Consecutive pair 2→3: task 3 must be blocked by task 2
    const blockers3 = await queue.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ? ORDER BY blocker_task_id`,
      args: [task3Id],
    })
    expect(
      blockers3.rows.map(
        (r) => (r as unknown as { blocker_task_id: string }).blocker_task_id,
      ),
    ).toEqual([task2Id])

    // Task 1 is the root: it must have no blocker rows
    const blockers1 = await queue.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [task1Id],
    })
    expect(blockers1.rows).toHaveLength(0)

    // Status reflects the DAG: task 1 is ready to dispatch; 2 and 3 wait
    for (const [id, expectedStatus] of [
      [task1Id, 'queued'],
      [task2Id, 'blocked'],
      [task3Id, 'blocked'],
    ] as const) {
      const row = await queue.resolveQueueClient().execute({
        sql: `SELECT status FROM tasks WHERE id = ?`,
        args: [id],
      })
      expect(
        (row.rows[0] as unknown as { status: string }).status,
      ).toBe(expectedStatus)
    }
  })

  it('produces no task_blockers rows when no slice declares blockedBy (pure parallel PRD)', async () => {
    // Slices with empty blockedBy must generate no task_blockers rows —
    // no spurious edges even when there are multiple slices.
    const parallelSlices = {
      slices: [
        {
          title: 'Parallel slice A',
          type: 'AFK' as const,
          whatToBuild: 'Independent work A',
          acceptanceCriteria: ['A done'],
          blockedBy: [] as number[],
          readFirst: ['src/a.ts'] as string[],
          prescriptiveAction: 'Add doA() export to src/a.ts.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
        {
          title: 'Parallel slice B',
          type: 'AFK' as const,
          whatToBuild: 'Independent work B',
          acceptanceCriteria: ['B done'],
          blockedBy: [] as number[],
          readFirst: ['src/b.ts'] as string[],
          prescriptiveAction: 'Add doB() export to src/b.ts.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
        {
          title: 'Parallel slice C',
          type: 'AFK' as const,
          whatToBuild: 'Independent work C',
          acceptanceCriteria: ['C done'],
          blockedBy: [] as number[],
          readFirst: ['src/c.ts'] as string[],
          prescriptiveAction: 'Add doC() export to src/c.ts.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
      ],
    }

    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(parallelSlices),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    expect(result.taskIds).toHaveLength(3)

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // Zero task_blockers rows across all 3 tasks
    const blockerCount = await queue.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id IN (?, ?, ?)`,
      args: result.taskIds,
    })
    expect(
      Number(
        (blockerCount.rows[0] as unknown as { n: number | bigint }).n ?? 0,
      ),
    ).toBe(0)

    // All 3 tasks must be immediately dispatchable (queued)
    for (const id of result.taskIds) {
      const row = await queue.resolveQueueClient().execute({
        sql: `SELECT status FROM tasks WHERE id = ?`,
        args: [id],
      })
      expect(
        (row.rows[0] as unknown as { status: string }).status,
      ).toBe('queued')
    }
  })
})

describe('dropAlreadySatisfiedSlices: pre-flight drop of already-shipped slices', () => {
  // Helper to build a minimal SliceSpec fixture
  const makeSlice = (
    overrides: Partial<{
      title: string
      creates: string[]
      prescriptiveAction: string
      blockedBy: number[]
      modifies: string[]
    }> = {},
  ) => ({
    title: 'Test slice',
    type: 'AFK' as const,
    kind: 'coder' as const,
    whatToBuild: 'test',
    acceptanceCriteria: ['works'],
    blockedBy: [] as number[],
    readFirst: ['some/file.ts'],
    prescriptiveAction: 'Add `mySymbol` to the module.',
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,    mergeMode: 'auto' as const,
    ...overrides,
  })

  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-preflight-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('drops a slice when all creates files exist and export all declared symbols', () => {
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, 'src/myModule.ts'),
      'export const mySymbol = 42\n',
    )

    const slices = [makeSlice({ creates: ['src/myModule.ts'] })]
    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    expect(result).toHaveLength(0)
  })

  it('does NOT drop a slice when the creates file does not exist', () => {
    const slices = [makeSlice({ creates: ['src/nonexistent.ts'] })]
    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    expect(result).toHaveLength(1)
  })

  it('does NOT drop a slice when a declared symbol is missing from the file', () => {
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, 'src/myModule.ts'),
      // file exists but exports a DIFFERENT symbol
      'export const otherSymbol = 99\n',
    )

    const slices = [
      makeSlice({
        creates: ['src/myModule.ts'],
        prescriptiveAction: 'Add `mySymbol` to the module.',
      }),
    ]
    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    expect(result).toHaveLength(1)
  })

  it('does NOT drop a slice with no backtick identifiers in prescriptiveAction', () => {
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, 'src/myModule.ts'),
      'export const mySymbol = 42\n',
    )

    const slices = [
      makeSlice({
        creates: ['src/myModule.ts'],
        // No backtick-delimited symbol declared
        prescriptiveAction: 'Add the mySymbol constant without backticks.',
      }),
    ]
    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    expect(result).toHaveLength(1)
  })

  it('does NOT drop a slice with no creates files (modifies-only)', () => {
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, 'src/existing.ts'),
      'export const mySymbol = 42\n',
    )

    const slices = [
      makeSlice({
        creates: [],
        modifies: ['src/existing.ts'],
        prescriptiveAction: 'Add `mySymbol` to the module.',
      }),
    ]
    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    expect(result).toHaveLength(1)
  })

  it('PRD scenario: dropped slice blocker edge is removed from downstream slice', () => {
    // This is the acceptance-criterion scenario:
    // Slice 1 creates a file + symbol already on disk → dropped.
    // Slice 2 is blocked by slice 1 → its blockedBy must be emptied so it
    // can dispatch immediately.
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, 'src/alreadyShipped.ts'),
      'export function alreadyShipped() {}\n',
    )

    const slices = [
      makeSlice({
        title: 'Slice 1 — already on main',
        creates: ['src/alreadyShipped.ts'],
        prescriptiveAction:
          'Add `alreadyShipped` function to src/alreadyShipped.ts.',
        blockedBy: [],
      }),
      makeSlice({
        title: 'Slice 2 — depends on slice 1',
        creates: [],
        prescriptiveAction: 'Use `alreadyShipped` in downstream code.',
        blockedBy: [1],
      }),
    ]

    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    // Slice 1 should be gone
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Slice 2 — depends on slice 1')
    // Its blockedBy must no longer reference the dropped slice
    expect(result[0].blockedBy).toEqual([])
  })

  it('re-numbers surviving slice blockedBy indices after a drop', () => {
    // Slices: [A (dropped), B (blocked by A), C (blocked by A and original 3),
    //          D (blocked by original 3)]
    // After dropping A: B → [], C → [1] (was 3→now 2=C, but wait...)
    // Let's use a cleaner setup:
    // Slices: [A, B, C] where A is dropped, C is blocked by B (idx 2).
    // After dropping A: B is now idx 1; C's blockedBy [2] → remap to [1].
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, 'src/alreadyShipped.ts'),
      'export const alreadyShipped = true\n',
    )

    const sliceA = makeSlice({
      title: 'A — dropped',
      creates: ['src/alreadyShipped.ts'],
      prescriptiveAction: 'Add `alreadyShipped` constant.',
      blockedBy: [],
    })
    const sliceB = makeSlice({
      title: 'B — not dropped, no deps',
      creates: [],
      prescriptiveAction: 'Some other work.',
      blockedBy: [],
    })
    const sliceC = makeSlice({
      title: 'C — blocked by B (original index 2)',
      creates: [],
      prescriptiveAction: 'Follow-up work.',
      blockedBy: [2], // 1-based: slice B
    })

    const result = dropAlreadySatisfiedSlices([sliceA, sliceB, sliceC], tmpDir)

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('B — not dropped, no deps')
    expect(result[1].title).toBe('C — blocked by B (original index 2)')
    // C was blocked by original index 2 (B). After dropping A,
    // B is now new index 1.
    expect(result[1].blockedBy).toEqual([1])
  })

  it('is a no-op when no slice is satisfied on disk', () => {
    const slices = [
      makeSlice({ creates: ['src/missing.ts'] }),
      makeSlice({ creates: ['src/alsoMissing.ts'], blockedBy: [1] }),
    ]

    const result = dropAlreadySatisfiedSlices(slices, tmpDir)

    expect(result).toHaveLength(2)
    expect(result[0].blockedBy).toEqual([])
    expect(result[1].blockedBy).toEqual([1])
  })
})

describe('slicerOutputSchema: kind and subDeliverable', () => {
  // Minimal valid base slice (without kind and subDeliverable) to reuse across tests.
  const baseSliceInput = {
    title: 'Some work',
    type: 'AFK' as const,
    whatToBuild: 'Do something useful.',
    acceptanceCriteria: ['it works'],
    blockedBy: [] as number[],
    readFirst: ['src/foo.ts'] as string[],
    prescriptiveAction: 'In fooFn (src/foo.ts:1), change x to y.',
  }

  const validSubDeliverable = {
    title: 'Build a verify script',
    whatToBuild: 'Write a shell script that the operator runs to confirm the release.',
    acceptanceCriteria: ['script exits 0 when release page shows correct artifact'],
    files: ['scripts/verify-release.sh'],
  }

  it('defaults kind to coder when the field is omitted', () => {
    const parsed = slicerOutputSchema.parse({ slices: [baseSliceInput] })
    expect(parsed.slices[0].kind).toBe('coder')
  })

  it('accepts kind=coder with no subDeliverable', () => {
    const parsed = slicerOutputSchema.parse({
      slices: [{ ...baseSliceInput, kind: 'coder' }],
    })
    expect(parsed.slices[0].kind).toBe('coder')
    expect(parsed.slices[0].subDeliverable).toBeUndefined()
  })

  it('accepts kind=hitl with a complete subDeliverable spec', () => {
    const parsed = slicerOutputSchema.parse({
      slices: [
        {
          ...baseSliceInput,
          kind: 'hitl',
          subDeliverable: validSubDeliverable,
        },
      ],
    })
    expect(parsed.slices[0].kind).toBe('hitl')
    expect(parsed.slices[0].subDeliverable).toMatchObject({
      title: 'Build a verify script',
      whatToBuild: expect.stringContaining('operator runs'),
      acceptanceCriteria: expect.arrayContaining(['script exits 0 when release page shows correct artifact']),
      files: ['scripts/verify-release.sh'],
    })
  })

  it('rejects kind=hitl when subDeliverable is missing', () => {
    expect(() =>
      slicerOutputSchema.parse({
        slices: [{ ...baseSliceInput, kind: 'hitl' }],
      }),
    ).toThrow(/hitl slices must include a subDeliverable/)
  })

  it('rejects kind=coder when a subDeliverable is attached', () => {
    expect(() =>
      slicerOutputSchema.parse({
        slices: [
          {
            ...baseSliceInput,
            kind: 'coder',
            subDeliverable: validSubDeliverable,
          },
        ],
      }),
    ).toThrow(/coder slices must not include a subDeliverable/)
  })

  it('rejects a subDeliverable with an empty title', () => {
    expect(() =>
      subDeliverableSchema.parse({
        title: '',
        whatToBuild: 'something',
        acceptanceCriteria: ['a criterion'],
      }),
    ).toThrow()
  })

  it('rejects a subDeliverable with no acceptanceCriteria', () => {
    expect(() =>
      subDeliverableSchema.parse({
        title: 'A title',
        whatToBuild: 'something',
        acceptanceCriteria: [],
      }),
    ).toThrow()
  })

  it('accepts a subDeliverable with optional files omitted', () => {
    const parsed = subDeliverableSchema.parse({
      title: 'A title',
      whatToBuild: 'something',
      acceptanceCriteria: ['criterion'],
    })
    expect(parsed.files).toBeUndefined()
  })

  it('an all-coder PRD produces zero hitl slices — every slice defaults to kind=coder', () => {
    // Simulates a standard all-coder PRD: no kind field supplied anywhere.
    // Every parsed slice must default to kind='coder'.
    const parsed = slicerOutputSchema.parse({
      slices: [
        { ...baseSliceInput, title: 'A' },
        { ...baseSliceInput, title: 'B', blockedBy: [1] },
      ],
    })
    for (const s of parsed.slices) {
      expect(s.kind).toBe('coder')
      expect(s.subDeliverable).toBeUndefined()
    }
  })
})

describe('slicer prompt: kind and human-only verbs', () => {
  const sampleProposal = {
    id: 'idea-1',
    title: 'Some PRD',
    problem: '',
    solution: '',
    outOfScope: '',
    notes: '',
    userStories: [],
  }

  it("enumerates at least four human-only verbs that trigger kind='hitl'", () => {
    const brief = buildSlicerPrompt(sampleProposal)
    // The brief must name human-only actions explicitly — at least these four.
    expect(brief).toMatch(/push|deploy/i)
    expect(brief).toMatch(/observe|monitor/i)
    expect(brief).toMatch(/download/i)
    expect(brief).toMatch(/third.party UI|third-party UI/i)
  })

  it("instructs the slicer to attach a subDeliverable when kind='hitl'", () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/subDeliverable/)
    // The requirement must be stated: hitl without subDeliverable is an error.
    expect(brief).toMatch(/MUST also emit a subDeliverable|MUST.*also.*emit.*subDeliverable/i)
  })

  it("forbids subDeliverable on coder slices", () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/coder slice MUST NOT|coder slices.*MUST NOT/i)
  })

  it('documents kind in the Output shape section', () => {
    const brief = buildSlicerPrompt(sampleProposal)
    // kind is listed as a named output field
    expect(brief).toMatch(/- kind\s+—/)
  })

  it("includes kind='coder' in the example JSON", () => {
    const brief = buildSlicerPrompt(sampleProposal)
    expect(brief).toMatch(/"kind":"coder"/)
  })
})

describe('enqueueTask round-trip: hitl slice kind and subDeliverable land on task row', () => {
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-hitl-'))
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

  it('round-trips kind and subDeliverable from an hitl slice spec through enqueueTask', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // Parse a slicer output that contains one hitl slice with a subDeliverable.
    const hitlSlicerOutput = slicerOutputSchema.parse({
      slices: [
        {
          title: 'Publish release to GitHub',
          type: 'HITL' as const,
          kind: 'hitl',
          whatToBuild: 'Operator downloads the artifact and pushes a tag.',
          acceptanceCriteria: [
            'release page shows the correct artifact',
            'tag is pushed to remote',
          ],
          blockedBy: [],
          readFirst: ['scripts/release.sh'],
          prescriptiveAction:
            'In scripts/release.sh, add a step that pushes the release tag.',
          subDeliverable: {
            title: 'Release verification script',
            whatToBuild:
              'Write scripts/verify-release.sh that checks the release page and exits 0 if the correct artifact is present.',
            acceptanceCriteria: [
              'script exits 0 when artifact is present on the release page',
              'script exits 1 when artifact is missing',
            ],
            files: ['scripts/verify-release.sh'],
          },
        },
      ],
    })

    const slice = hitlSlicerOutput.slices[0]
    const task = await queue.enqueueTask('p', undefined, {
      spec: {
        files: sliceFilesForPersistence(slice),
        verifyCmd: slice.verifyCmd,
               doneCriteria: slice.acceptanceCriteria,
        mergeMode: slice.mergeMode,
        sliceKind: slice.kind,
        subDeliverable: slice.subDeliverable,
      },
    })

    const reloaded = await queue.getTask(task.id)
    // Both fields must survive the DB round-trip.
    expect(reloaded?.spec?.sliceKind).toBe('hitl')
    expect(reloaded?.spec?.subDeliverable).toMatchObject({
      title: 'Release verification script',
      whatToBuild: expect.stringContaining('verify-release.sh'),
      acceptanceCriteria: expect.arrayContaining([
        'script exits 0 when artifact is present on the release page',
      ]),
      files: ['scripts/verify-release.sh'],
    })
  })

  it('coder slices without subDeliverable land with sliceKind=coder and no subDeliverable', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    const task = await queue.enqueueTask('p', undefined, {
      spec: {
        files: [],
        verifyCmd: null,        doneCriteria: ['done'],
        mergeMode: 'auto',
        sliceKind: 'coder',
      },
    })

    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.spec?.sliceKind).toBe('coder')
    expect(reloaded?.spec?.subDeliverable).toBeUndefined()
  })
})

describe('enqueueTask round-trip: slicer intent lands on emitted task row', () => {
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-intent-'))
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

  it('persists the slice title as intent, distinct from the full prompt', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    const sliceTitle = 'Add intent field to slicer emit path'
    const fullPrompt =
      '# ' +
      sliceTitle +
      '\n\nSlice 1 of 3 for PRD abc: Redesign the failed-arc Alert.\n\n' +
      '## What to build\n\nWire intent through enqueueTask so Alerts display a slicer-authored one-liner.\n\n' +
      '## Acceptance criteria\n\n- [ ] intent is non-empty on every emitted task\n'

    const task = await queue.enqueueTask(fullPrompt, undefined, {
      intent: sliceTitle.slice(0, 200),
      spec: {
        files: ['orchestrator/src/workflows/slice-workflow.ts'],
        verifyCmd: null,        doneCriteria: ['intent is non-empty on every emitted task'],
        mergeMode: 'auto',
      },
    })

    const reloaded = await queue.getTask(task.id)
    // intent must be non-empty
    expect(reloaded?.intent).toBeTruthy()
    // intent must differ from the full prompt (it is a short one-liner, not the whole body)
    expect(reloaded?.intent).not.toBe(fullPrompt)
    // intent must match the slice title verbatim
    expect(reloaded?.intent).toBe(sliceTitle)
  })

  it('caps intent at 200 characters', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    const longTitle = 'A'.repeat(300)
    const task = await queue.enqueueTask('prompt body', undefined, {
      intent: longTitle.slice(0, 200),
      spec: {
        files: [],
        verifyCmd: null,        doneCriteria: ['done'],
        mergeMode: 'auto',
      },
    })

    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.intent.length).toBeLessThanOrEqual(200)
    expect(reloaded?.intent).toBe('A'.repeat(200))
  })
})

describe('Slice 1: TDD philosophy is a standing Session instruction, not per-Task text', () => {
  // The coder Worker used to re-absorb the ~150-line TDD brief at the top
  // of every per-Task prompt, and a retry replayed it verbatim — burning
  // token budget on boilerplate. It now arrives once, as the
  // Worker's standing Session instructions, and never inside the per-Task
  // prompt.
  const proposal = {
    id: 'idea-tdd',
    title: 'Move the TDD brief out of per-task prompts',
    problem: 'The brief is replayed verbatim on every retry.',
    solution: 'Carry it in the Session standing instructions instead.',
    outOfScope: 'Retuning the read budget.',
    notes: 'Slice 1 of the TDD brief refactor.',
    userStories: ['As a coder I do not re-absorb the brief each task.'],
  }
  const slice = {
    title: 'Drop the brief from the per-task prompt',
    type: 'AFK' as const,
    kind: 'coder' as const,
    whatToBuild: 'Stop prepending the TDD brief to the slice prompt.',
    acceptanceCriteria: ['per-task prompt has zero copies of the brief'],
    blockedBy: [] as number[],
    readFirst: [
      'orchestrator/src/core/workflows/slice-workflow.ts',
    ] as string[],
    prescriptiveAction:
      'In composeTaskPrompt (slice-workflow.ts), remove any reference to TDD_WORKER_BRIEF from the returned template string.',
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,    mergeMode: 'auto' as const,
  }
  const spec = {
    files: [] as string[],
    verifyCmd: null,    doneCriteria: ['a'],
    mergeMode: 'auto' as const,
  }
  // A sentence that appears verbatim only in the TDD operating philosophy.
  const TDD_SIGNATURE =
    'using test-driven development with vertical tracer bullets'

  it('composes a coder per-Task prompt with zero copies of the TDD philosophy', () => {
    const prompt = composeTaskPrompt(proposal, slice, 1, 1)
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
    const original = composeTaskPrompt(proposal, slice, 1, 1)
    const retried = composeTaskPrompt(proposal, slice, 1, 1)
    expect(retried).toBe(original)
    expect(retried).not.toContain(TDD_WORKER_BRIEF)

    // A re-dispatch wraps the stored prompt through composePrompt again;
    // that surface must also be stable and brief-free.
    const first = composePrompt(original, null, 'coder', spec, 'mars-x')
    const second = composePrompt(original, null, 'coder', spec, 'mars-x')
    expect(second).toBe(first)
    expect(second).not.toContain(TDD_WORKER_BRIEF)
  })

  it('standing instructions do not vary between dispatches — same prompt, no brief in per-Task body', () => {
    // After ADR 0019 every tag resolves to the Coder standing instructions.
    // The TDD brief is in the standing instructions (system prompt), not the
    // per-Task prompt body — composePrompt must not embed it.
    const p1 = composePrompt('task body', null, 'coder', spec, 'mars-t')
    const p2 = composePrompt('task body', null, 'coder', spec, 'mars-t')
    expect(p2).toBe(p1)
    expect(p1).not.toContain(TDD_WORKER_BRIEF)
  })
})

describe('runSlice: actionQueue summary for pre-flight dropped slices', () => {
  // When the slicer pre-flight drops one or more already-satisfied slices,
  // exactly one actionQueue item must be created (before tasks are queued) so the
  // operator can verify the drop before survivors begin dispatch. When zero
  // slices are dropped, no item is created from this code path.
  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-dropped-'))
    execFileSync('git', ['init', '-q'], { cwd: r })
    mkdirSync(resolve(r, '.mars'), { recursive: true })
    return r
  }

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    // These tests stub the CLAUDE provider entry point (runClaudeCode). The
    // worker provider defaults to codex, so without this pin the stub is never
    // consulted and the Slicer shells out to a real `codex exec` that hangs
    // until the 30s test timeout.
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../core/lib/git/claude')
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKER_PROVIDER
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const seedPrdReadyProposal = async (): Promise<string> => {
    const proposals = await import('../../core/proposals')
    await proposals.initProposals()
    const proposal = await proposals.createProposal('Action queue drop test PRD', {
      problem: 'p',
      solution: 's',
    })
    await proposals.addProposalUserStory(proposal.id, 'as a user, I want X')
    const promoted = await proposals.promoteProposal(proposal.id)
    expect(promoted.status).toBe('prd-ready')
    return proposal.id
  }

  it('creates exactly one actionQueue item naming the PRD id and dropped count when drops > 0', async () => {
    // Slice 1 declares creates: ['src/alreadyShipped.ts'] with symbol
    // `alreadyShipped`; that file and export already exist on disk, so the
    // pre-flight drops it. Slice 2 survives and dispatches normally.
    mkdirSync(resolve(repo, 'src'), { recursive: true })
    writeFileSync(
      resolve(repo, 'src/alreadyShipped.ts'),
      'export function alreadyShipped() {}\n',
    )

    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope({
            slices: [
              {
                title: 'Already shipped slice',
                type: 'AFK',
                whatToBuild: 'Create alreadyShipped function',
                acceptanceCriteria: ['alreadyShipped exists'],
                blockedBy: [],
                readFirst: ['src/alreadyShipped.ts'],
                prescriptiveAction:
                  'Add `alreadyShipped` function to src/alreadyShipped.ts.',
                creates: ['src/alreadyShipped.ts'],
                modifies: [],
                verifyCmd: null,                mergeMode: 'auto',
              },
              {
                title: 'Surviving slice',
                type: 'AFK',
                whatToBuild: 'Some other work',
                acceptanceCriteria: ['done'],
                blockedBy: [],
                readFirst: ['src/other.ts'],
                prescriptiveAction: 'Add `otherFn` to src/other.ts.',
                creates: [],
                modifies: [],
                verifyCmd: null,                mergeMode: 'auto',
              },
            ],
          }),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)

    // Slice 2 is the only survivor — one task queued.
    expect(result.taskIds).toHaveLength(1)

    // One actionQueue item must have been created for the dropped slice.
    const actionQueue = await import('../../core/lib/action-queue')
    await actionQueue.initActionQueue()
    const items = await actionQueue.listActionQueueItems('open', { kind: 'slices-dropped' })

    expect(items).toHaveLength(1)
    // Body must identify the PRD id and the count of dropped slices.
    expect(items[0].body).toContain(proposalId)
    expect(items[0].body).toContain('1')
  })

  it('creates no actionQueue item when the slicer run drops zero slices', async () => {
    // No files pre-created → nothing satisfies the pre-flight check.
    // The slicer emits one slice that creates a file that does not yet
    // exist on disk — it must be dispatched normally with no actionQueue item.
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope({
            slices: [
              {
                title: 'Regular slice',
                type: 'AFK',
                whatToBuild: 'Something new',
                acceptanceCriteria: ['done'],
                blockedBy: [],
                readFirst: ['src/missing.ts'],
                prescriptiveAction: 'Add `missingFn` to src/missing.ts.',
                creates: ['src/missing.ts'],
                modifies: [],
                verifyCmd: null,                mergeMode: 'auto',
              },
            ],
          }),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    await sliceModule.runSlice(proposalId)

    const actionQueue = await import('../../core/lib/action-queue')
    await actionQueue.initActionQueue()
    const items = await actionQueue.listActionQueueItems('open', { kind: 'slices-dropped' })

    expect(items).toHaveLength(0)
  })
})

describe('runSlice: hitl slice routing → actionQueue item + Coder sub-task + blocked parent', () => {
  // Acceptance criteria for this slice:
  // - Slicing a PRD with one hitl slice creates exactly one actionQueue item of kind
  //   'hitl-slice-needs-operator'
  // - The actionQueue item body contains the slice title and acceptance criteria
  //   rendered as a manual checklist
  // - Exactly one Coder sub-task is enqueued from the subDeliverable spec
  // - The sub-task is dispatchable (status='queued')
  // - The hitl slice task row is in status='blocked'
  // - All-coder PRDs produce no hitl actionQueue items and no sub-tasks

  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-slice-hitl-routing-'))
    execFileSync('git', ['init', '-q'], { cwd: r })
    mkdirSync(resolve(r, '.mars'), { recursive: true })
    return r
  }

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    // These tests stub the CLAUDE provider entry point (runClaudeCode). The
    // worker provider defaults to codex, so without this pin the stub is never
    // consulted and the Slicer shells out to a real `codex exec` that hangs
    // until the 30s test timeout.
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../core/lib/git/claude')
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKER_PROVIDER
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const seedPrdReadyProposal = async (): Promise<string> => {
    const proposals = await import('../../core/proposals')
    await proposals.initProposals()
    const proposal = await proposals.createProposal('HITL routing test PRD', {
      problem: 'operator must release manually',
      solution: 'route hitl slices to operator actionQueue',
    })
    await proposals.addProposalUserStory(proposal.id, 'as an operator, I see what to do')
    const promoted = await proposals.promoteProposal(proposal.id)
    expect(promoted.status).toBe('prd-ready')
    return proposal.id
  }

  const hitlSlicerOutput = {
    slices: [
      {
        title: 'Publish release to GitHub',
        type: 'HITL' as const,
        kind: 'hitl' as const,
        whatToBuild:
          'Operator downloads the artifact and pushes a tag to the remote.',
        acceptanceCriteria: [
          'release page shows the correct artifact',
          'tag is pushed to remote',
        ],
        blockedBy: [] as number[],
        readFirst: ['scripts/release.sh'] as string[],
        prescriptiveAction:
          'In scripts/release.sh, add a step that pushes the release tag.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
        subDeliverable: {
          title: 'Release verification script',
          whatToBuild:
            'Write scripts/verify-release.sh that checks the release page and exits 0 if the correct artifact is present.',
          acceptanceCriteria: [
            'script exits 0 when artifact is present on the release page',
            'script exits 1 when artifact is missing',
          ],
          files: ['scripts/verify-release.sh'],
        },
      },
    ],
  }

  it('creates exactly one actionQueue item of kind hitl-slice-needs-operator when an hitl slice is present', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    await sliceModule.runSlice(proposalId)

    const actionQueue = await import('../../core/lib/action-queue')
    await actionQueue.initActionQueue()
    const items = await actionQueue.listActionQueueItems('open', {
      kind: 'hitl-slice-needs-operator',
    })

    expect(items).toHaveLength(1)
  })

  it('actionQueue item body contains the hitl slice title and acceptance criteria as a manual checklist', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    await sliceModule.runSlice(proposalId)

    const actionQueue = await import('../../core/lib/action-queue')
    await actionQueue.initActionQueue()
    const items = await actionQueue.listActionQueueItems('open', {
      kind: 'hitl-slice-needs-operator',
    })

    const body = items[0].body
    // Must contain the slice title
    expect(body).toContain('Publish release to GitHub')
    // Must contain the acceptance criteria rendered as manual checkboxes
    expect(body).toContain('- [ ] release page shows the correct artifact')
    expect(body).toContain('- [ ] tag is pushed to remote')
  })

  it('enqueues exactly one Coder sub-task built from the subDeliverable spec, dispatchable as queued', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)

    // result.taskIds contains only the slice task ids (1 hitl slice → 1 id)
    expect(result.taskIds).toHaveLength(1)

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // hitl slice task + Coder sub-task = 2 tasks for this proposal
    const allTasks = await queue.resolveQueueClient().execute({
      sql: `SELECT id, status, prompt FROM tasks WHERE parent_proposal_id = ? ORDER BY created_at ASC`,
      args: [proposalId],
    })
    expect(allTasks.rows).toHaveLength(2)

    // Identify the sub-task (not in result.taskIds)
    type TaskRow = { id: string; status: string; prompt: string }
    const subTaskRow = allTasks.rows.find(
      (r) =>
        !(result.taskIds as string[]).includes(
          (r as unknown as TaskRow).id,
        ),
    ) as unknown as TaskRow | undefined
    expect(subTaskRow).toBeDefined()

    // Sub-task must be Coder-dispatchable (status='queued')
    expect(subTaskRow!.status).toBe('queued')

    // Sub-task prompt must derive from the subDeliverable spec
    expect(subTaskRow!.prompt).toContain('Release verification script')
    expect(subTaskRow!.prompt).toContain('verify-release.sh')
  })

  it('leaves the hitl slice task in status=blocked immediately after slicing', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // The hitl slice task itself must be blocked — never queued for Coder dispatch
    const hitlRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [result.taskIds[0]],
    })
    expect(
      (hitlRow.rows[0] as unknown as { status: string }).status,
    ).toBe('blocked')
  })

  it('all-coder PRDs produce no hitl-slice-needs-operator actionQueue items and no Coder sub-tasks', async () => {
    const coderOnlyOutput = {
      slices: [
        {
          title: 'Refactor the parser',
          type: 'AFK' as const,
          kind: 'coder' as const,
          whatToBuild: 'Improve parser performance.',
          acceptanceCriteria: ['parser is faster'],
          blockedBy: [] as number[],
          readFirst: ['src/parser.ts'] as string[],
          prescriptiveAction: 'Optimise parseToken() in src/parser.ts.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
      ],
    }

    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(coderOnlyOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)

    // One task only (the coder slice) — no sub-tasks created
    expect(result.taskIds).toHaveLength(1)

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const totalTasks = await queue.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks WHERE parent_proposal_id = ?`,
      args: [proposalId],
    })
    expect(
      Number(
        (totalTasks.rows[0] as unknown as { n: number | bigint }).n ?? 0,
      ),
    ).toBe(1)

    // No hitl-slice-needs-operator actionQueue items
    const actionQueue = await import('../../core/lib/action-queue')
    await actionQueue.initActionQueue()
    const items = await actionQueue.listActionQueueItems('open', {
      kind: 'hitl-slice-needs-operator',
    })
    expect(items).toHaveLength(0)
  })
})

describe('hitl slice completion: both actionQueue resolved and sub-task done required', () => {
  // Acceptance criteria:
  // - Resolving the actionQueue item while the sub-task is still in-flight leaves the
  //   hitl slice's task in 'blocked'.
  // - The sub-task reaching 'done' while the actionQueue item is still open leaves the
  //   hitl slice's task in 'blocked'.
  // - Once both the actionQueue item is resolved (or dismissed) AND the sub-task is
  //   'done', the hitl slice's task row flips to 'done'.
  // - Coder-only PRDs continue to reach full completion exactly as today.
  //
  // All three orderings are exercised: actionQueue first, sub-task first, simultaneous.

  let repo: string

  const setupRepo = (): string => {
    const r = mkdtempSync(resolve(tmpdir(), 'mars-hitl-completion-'))
    execFileSync('git', ['init', '-q'], { cwd: r })
    mkdirSync(resolve(r, '.mars'), { recursive: true })
    return r
  }

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    // These tests stub the CLAUDE provider entry point (runClaudeCode). The
    // worker provider defaults to codex, so without this pin the stub is never
    // consulted and the Slicer shells out to a real `codex exec` that hangs
    // until the 30s test timeout.
    process.env.MARS_WORKER_PROVIDER = 'claude'
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../core/lib/git/claude')
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKER_PROVIDER
    rmSync(repo, { recursive: true, force: true })
  })

  const envelope = (jsonResult: unknown): string =>
    JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

  const seedPrdReadyProposal = async (): Promise<string> => {
    const proposals = await import('../../core/proposals')
    await proposals.initProposals()
    const proposal = await proposals.createProposal('HITL completion test PRD', {
      problem: 'operator must confirm manually',
      solution: 'route hitl slices to operator and complete when both conditions met',
    })
    await proposals.addProposalUserStory(proposal.id, 'as an operator, I confirm the step')
    const promoted = await proposals.promoteProposal(proposal.id)
    expect(promoted.status).toBe('prd-ready')
    return proposal.id
  }

  // Single HITL slice fixture reused across all tests in this describe block.
  const hitlSlicerOutput = {
    slices: [
      {
        title: 'Publish release to GitHub',
        type: 'HITL' as const,
        kind: 'hitl' as const,
        whatToBuild:
          'Operator downloads the artifact and pushes a tag to the remote.',
        acceptanceCriteria: [
          'release page shows the correct artifact',
          'tag is pushed to remote',
        ],
        blockedBy: [] as number[],
        readFirst: ['scripts/release.sh'] as string[],
        prescriptiveAction:
          'In scripts/release.sh, add a step that pushes the release tag.',
        modifies: [] as string[],
        creates: [] as string[],
        verifyCmd: null,        mergeMode: 'auto' as const,
        subDeliverable: {
          title: 'Release verification script',
          whatToBuild:
            'Write scripts/verify-release.sh that checks the release page.',
          acceptanceCriteria: [
            'script exits 0 when artifact is present',
            'script exits 1 when artifact is missing',
          ],
          files: ['scripts/verify-release.sh'],
        },
      },
    ],
  }

  // Helper: find the Coder sub-task id for a given hitl slice task.
  // Self-imports the queue module so callers don't need to pass a reference.
  const findSubTaskId = async (hitlSliceTaskId: string): Promise<string> => {
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const r = await queue.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [hitlSliceTaskId],
    })
    expect(r.rows).toHaveLength(1)
    return (r.rows[0] as unknown as { blocker_task_id: string }).blocker_task_id
  }

  // Helper: find and return the actionQueue item id for the hitl slice.
  const findHitlActionQueueItemId = async (): Promise<string> => {
    const actionQueue = await import('../../core/lib/action-queue')
    await actionQueue.initActionQueue()
    const items = await actionQueue.listActionQueueItems('all', {
      kind: 'hitl-slice-needs-operator',
    })
    expect(items).toHaveLength(1)
    return items[0].id
  }

  // Helper: mark a task as 'done' directly in the DB (simulates daemon behaviour
  // after a Coder worktree successfully merges).
  const markTaskDone = async (taskId: string): Promise<void> => {
    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = now() WHERE id = ?`,
      args: [taskId],
    })
  }

  it('resolving the actionQueue item while the sub-task is still in-flight leaves the hitl slice blocked', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    expect(result.taskIds).toHaveLength(1)
    const hitlSliceTaskId = result.taskIds[0]

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const actionQueue = await import('../../core/lib/action-queue')

    // Resolve the actionQueue item — but sub-task is still 'queued' (in-flight).
    const actionQueueItemId = await findHitlActionQueueItemId()
    await actionQueue.setActionQueueState(actionQueueItemId, 'resolved')

    // Sub-task is still in-flight: tryCompleteHitlSlice must return false.
    const completed = await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)
    expect(completed).toBe(false)

    // The hitl slice must remain 'blocked'.
    const hitlRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect(
      (hitlRow.rows[0] as unknown as { status: string }).status,
    ).toBe('blocked')
  })

  it('the sub-task reaching done while the actionQueue item is still open leaves the hitl slice blocked', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    expect(result.taskIds).toHaveLength(1)
    const hitlSliceTaskId = result.taskIds[0]

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // Mark the Coder sub-task as 'done' — actionQueue item is still open.
    const subTaskId = await findSubTaskId(hitlSliceTaskId)
    await markTaskDone(subTaskId)

    // Action queue item is still open: tryCompleteHitlSlice must return false.
    const completed = await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)
    expect(completed).toBe(false)

    // The hitl slice must remain 'blocked'.
    const hitlRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect(
      (hitlRow.rows[0] as unknown as { status: string }).status,
    ).toBe('blocked')
  })

  it('action-queue-first ordering: hitl slice flips to done once both conditions are met', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    const hitlSliceTaskId = result.taskIds[0]

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const actionQueue = await import('../../core/lib/action-queue')

    // Step 1: operator resolves actionQueue item first.
    const actionQueueItemId = await findHitlActionQueueItemId()
    await actionQueue.setActionQueueState(actionQueueItemId, 'resolved')

    // Sub-task not yet done → still blocked.
    expect(await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)).toBe(false)
    const afterStep1 = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect((afterStep1.rows[0] as unknown as { status: string }).status).toBe('blocked')

    // Step 2: sub-task reaches done.
    const subTaskId = await findSubTaskId(hitlSliceTaskId)
    await markTaskDone(subTaskId)

    // Both conditions now met → hitl slice must flip to done.
    expect(await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)).toBe(true)
    const afterStep2 = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect((afterStep2.rows[0] as unknown as { status: string }).status).toBe('done')
  })

  it('sub-task-first ordering: hitl slice flips to done once both conditions are met', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    const hitlSliceTaskId = result.taskIds[0]

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const actionQueue = await import('../../core/lib/action-queue')

    // Step 1: sub-task reaches done first.
    const subTaskId = await findSubTaskId(hitlSliceTaskId)
    await markTaskDone(subTaskId)

    // Action queue item not yet resolved → still blocked.
    expect(await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)).toBe(false)
    const afterStep1 = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect((afterStep1.rows[0] as unknown as { status: string }).status).toBe('blocked')

    // Step 2: operator resolves actionQueue item.
    const actionQueueItemId = await findHitlActionQueueItemId()
    await actionQueue.setActionQueueState(actionQueueItemId, 'resolved')

    // Both conditions now met → hitl slice must flip to done.
    expect(await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)).toBe(true)
    const afterStep2 = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect((afterStep2.rows[0] as unknown as { status: string }).status).toBe('done')
  })

  it('simultaneous ordering: hitl slice flips to done when both conditions are met at once', async () => {
    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(hitlSlicerOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    const hitlSliceTaskId = result.taskIds[0]

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()
    const actionQueue = await import('../../core/lib/action-queue')

    // Both conditions fulfilled back-to-back (simultaneous from the function's
    // perspective — no intermediate tryCompleteHitlSlice call).
    const subTaskId = await findSubTaskId(hitlSliceTaskId)
    await markTaskDone(subTaskId)
    const actionQueueItemId = await findHitlActionQueueItemId()
    await actionQueue.setActionQueueState(actionQueueItemId, 'resolved')

    // Single call completes the slice.
    expect(await sliceModule.tryCompleteHitlSlice(hitlSliceTaskId)).toBe(true)
    const hitlRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [hitlSliceTaskId],
    })
    expect((hitlRow.rows[0] as unknown as { status: string }).status).toBe('done')
    // The hitl slice must never have been 'in-progress' — it jumps directly
    // from 'blocked' to 'done', bypassing the Coder dispatch queue.
    // (No dispatch would ever flip it to 'running'; the history here confirms
    // the only transition we made was blocked→done via tryCompleteHitlSlice.)
  })

  it('coder-only PRDs are unaffected: tryCompleteHitlSlice returns false for a coder task', async () => {
    const coderOnlyOutput = {
      slices: [
        {
          title: 'Refactor the parser',
          type: 'AFK' as const,
          kind: 'coder' as const,
          whatToBuild: 'Improve parser performance.',
          acceptanceCriteria: ['parser is faster'],
          blockedBy: [] as number[],
          readFirst: ['src/parser.ts'] as string[],
          prescriptiveAction: 'Optimise parseToken() in src/parser.ts.',
          modifies: [] as string[],
          creates: [] as string[],
          verifyCmd: null,          mergeMode: 'auto' as const,
        },
      ],
    }

    vi.doMock('../../core/lib/git/claude', async () => {
      const actual = await vi.importActual<typeof import('../../core/lib/git/claude')>(
        '../../core/lib/git/claude',
      )
      return {
        ...actual,
        runClaudeCode: vi.fn(async () => ({
          exitCode: 0,
          stdout: envelope(coderOnlyOutput),
          stderr: '',
          sessionId: 'stub-session',
          conversation: [],
        })),
      }
    })
    vi.resetModules()
    const proposalId = await seedPrdReadyProposal()

    const sliceModule = await import('../slice-workflow')
    const result = await sliceModule.runSlice(proposalId)
    expect(result.taskIds).toHaveLength(1)
    const coderTaskId = result.taskIds[0]

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // Coder task starts 'queued' (dispatchable), not 'blocked'.
    const coderRow = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [coderTaskId],
    })
    expect((coderRow.rows[0] as unknown as { status: string }).status).toBe('queued')

    // tryCompleteHitlSlice must be a no-op on non-hitl tasks.
    const completed = await sliceModule.tryCompleteHitlSlice(coderTaskId)
    expect(completed).toBe(false)

    // Coder task status must be unchanged.
    const coderRowAfter = await queue.resolveQueueClient().execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [coderTaskId],
    })
    expect((coderRowAfter.rows[0] as unknown as { status: string }).status).toBe('queued')
  })

  it('updateTask throws IllegalTransitionError when a done slice task is re-transitioned (lifecycle gate)', async () => {
    // Contrived scenario: a slice task is seeded as 'done' (simulating a race
    // or corruption) before the final-done write in tryCompleteHitlSlice
    // would run. Routing writes through updateTask means any attempt to change
    // the status of a task that is already in a terminal state surfaces as an
    // IllegalTransitionError rather than silently succeeding as a raw SQL UPDATE
    // would have.
    vi.resetModules()

    const queue = await import('../../core/queue')
    await queue.migrateQueueSchema()

    // Seed a task directly, then flip it to 'done' via direct SQL (mimicking
    // the state the daemon would write after a successful Coder run).
    const task = await queue.enqueueTask('contrived done-slice task', undefined, {
      skipTriage: true,
    })
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = now() WHERE id = ?`,
      args: [task.id],
    })

    // Any further status transition on a 'done' task must throw — the lifecycle
    // gate that updateTask enforces but raw SQL bypassed.
    await expect(
      queue.updateTask(task.id, { status: 'queued' }),
    ).rejects.toThrow(queue.IllegalTransitionError)
  })
})

// ---------------------------------------------------------------------------
// detectActionAntiPattern — pure unit tests, no LLM calls
// ---------------------------------------------------------------------------

describe('detectActionAntiPattern: vague-prose detection', () => {
  it('flags a too-short action (word count below minimum)', () => {
    // "implement the feature" = 3 words
    expect(detectActionAntiPattern('implement the feature')).not.toBeNull()
  })

  it('flags a long action that contains the fluff word "implement"', () => {
    const action =
      'implement the feature in a reasonable way to support user requests and handle edge cases'
    const result = detectActionAntiPattern(action)
    expect(result).not.toBeNull()
    expect(result).toContain('implement')
  })

  it('flags a long action that contains the fluff word "ensure"', () => {
    // Has file path (passes that check) but "ensure" is a fluff word
    const action =
      'In src/foo/bar.ts ensure the function validates input before returning the result'
    const result = detectActionAntiPattern(action)
    expect(result).not.toBeNull()
    expect(result).toContain('ensure')
  })

  it('flags an action that lacks both a file path and a backtick-quoted identifier', () => {
    const action =
      'Add the new validation logic to the module and update the configuration to reflect the change'
    expect(detectActionAntiPattern(action)).not.toBeNull()
  })

  it('passes a concrete action with a file path and sufficient word count', () => {
    const action =
      'In orchestrator/src/workflows/slice-workflow.ts, add `detectActionAntiPattern` after the SCHEMA_DROP_PATTERNS constant and export it.'
    expect(detectActionAntiPattern(action)).toBeNull()
  })

  it('passes a concrete action with a backtick-quoted identifier and sufficient word count', () => {
    const action =
      'In `slicerOutputSchema` (slice-workflow.ts line 44), add `prescriptiveAction: z.string().min(1)` after `readFirst` and update the tests accordingly.'
    expect(detectActionAntiPattern(action)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyActionQualityGuard — behaviour tests with injected mock reprompt
// ---------------------------------------------------------------------------

describe('applyActionQualityGuard: re-prompt on vague actions', () => {
  it('does not call reprompt when action is already concrete', async () => {
    const slices = [
      {
        title: 'Add detectActionAntiPattern',
        prescriptiveAction:
          'In orchestrator/src/workflows/slice-workflow.ts, add `detectActionAntiPattern` after the SCHEMA_DROP_PATTERNS block and export it.',
      },
    ]
    const reprompt = vi.fn().mockResolvedValue(null)
    await applyActionQualityGuard(slices, reprompt)
    expect(reprompt).not.toHaveBeenCalled()
    // Original action is unchanged
    expect(slices[0].prescriptiveAction).toContain('detectActionAntiPattern')
  })

  it('calls reprompt exactly once naming the anti-pattern, and uses the concrete rewrite', async () => {
    const vagueAction =
      'implement the feature in a reasonable way to support user requests and handle edge cases'
    const slices = [{ title: 'Feature slice', prescriptiveAction: vagueAction }]
    const concreteAction =
      'In `applyActionQualityGuard` (orchestrator/src/workflows/slice-workflow.ts), add a for-loop that calls `detectActionAntiPattern` on each slice.prescriptiveAction and invokes reprompt once per flagged entry.'
    const reprompt = vi.fn().mockResolvedValue(concreteAction)

    await applyActionQualityGuard(slices, reprompt)

    expect(reprompt).toHaveBeenCalledTimes(1)
    // The anti-pattern description passed to reprompt must name the offending phrase
    expect(reprompt).toHaveBeenCalledWith(
      expect.objectContaining({ prescriptiveAction: vagueAction }),
      expect.stringContaining('implement'),
    )
    // Slice is updated with the concrete rewrite
    expect(slices[0].prescriptiveAction).toBe(concreteAction)
  })

  it('keeps original action when reprompt returns still-vague prose', async () => {
    const original =
      'implement the feature in a reasonable way to support user requests and handle edge cases'
    const slices = [{ title: 'Feature slice', prescriptiveAction: original }]
    // Reprompt returns something that also has fluff words and no concrete anchor
    const reprompt = vi.fn().mockResolvedValue(
      'ensure it is done properly and correctly aligned with the requirements',
    )

    await applyActionQualityGuard(slices, reprompt)

    expect(reprompt).toHaveBeenCalledTimes(1)
    // Original action must be preserved — the still-vague rewrite is discarded
    expect(slices[0].prescriptiveAction).toBe(original)
  })

  it('keeps original action when reprompt returns null (error or failure)', async () => {
    const original =
      'implement the feature in a reasonable way to support user requests and handle edge cases'
    const slices = [{ title: 'Feature slice', prescriptiveAction: original }]
    const reprompt = vi.fn().mockResolvedValue(null)

    await applyActionQualityGuard(slices, reprompt)

    expect(reprompt).toHaveBeenCalledTimes(1)
    expect(slices[0].prescriptiveAction).toBe(original)
  })

  it('processes only vague slices; leaves concrete slice untouched', async () => {
    const concreteAction =
      'In orchestrator/src/workflows/slice-workflow.ts, add `detectActionAntiPattern` after the SCHEMA_DROP_PATTERNS block.'
    const vagueAction =
      'implement the feature in a reasonable way to support user requests and handle edge cases'
    const concreteRewrite =
      'In `applyActionQualityGuard` (orchestrator/src/workflows/slice-workflow.ts), add a for-loop iterating over slices.'
    const slices = [
      { title: 'Concrete slice', prescriptiveAction: concreteAction },
      { title: 'Vague slice', prescriptiveAction: vagueAction },
    ]
    const reprompt = vi.fn().mockResolvedValue(concreteRewrite)

    await applyActionQualityGuard(slices, reprompt)

    // Only the vague slice triggers a reprompt
    expect(reprompt).toHaveBeenCalledTimes(1)
    expect(slices[0].prescriptiveAction).toBe(concreteAction)
    expect(slices[1].prescriptiveAction).toBe(concreteRewrite)
  })
})

describe('annotateUnresolvedReferences', () => {
  // Minimal SliceSpec fixture reused across tests.
  const makeSlice = (
    overrides: Partial<{
      title: string
      prescriptiveAction: string
      readFirst: string[]
      creates: string[]
      modifies: string[]
      blockedBy: number[]
    }> = {},
  ) => ({
    title: 'Test slice',
    type: 'AFK' as const,
    kind: 'coder' as const,
    whatToBuild: 'test',
    acceptanceCriteria: ['works'],
    blockedBy: [] as number[],
    readFirst: ['src/real-path.ts'] as string[],
    prescriptiveAction: 'Add `loadWorkflowForKind` to the module.',
    modifies: [] as string[],
    creates: [] as string[],
    verifyCmd: null,
       mergeMode: 'auto' as const,
    ...overrides,
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('annotates slices whose references do not resolve', () => {
    vi.spyOn(sliceRefValidator, 'validateSliceReferences').mockReturnValue({
      missingSymbols: ['loadWorkflowForKind'],
      missingReadFirstPaths: ['src/fake-path.ts'],
    })

    const slice = makeSlice({
      prescriptiveAction: 'Add `loadWorkflowForKind` call.',
      readFirst: ['src/real-path.ts', 'src/fake-path.ts'],
    })
    const onAnnotated = vi.fn()

    annotateUnresolvedReferences([slice], '/some/root', onAnnotated)

    expect(slice.prescriptiveAction).toContain(
      'Spec-vs-reality caveat: the following references could not be resolved in the current tree at slicing time — verify or replace before implementing.',
    )
    expect(slice.prescriptiveAction).toContain('Unresolved symbols: loadWorkflowForKind')
    expect(slice.prescriptiveAction).toContain('Missing read-first paths: src/fake-path.ts')
    // Fake path stripped; real path kept
    expect(slice.readFirst).toEqual(['src/real-path.ts'])
    expect(onAnnotated).toHaveBeenCalledTimes(1)
    expect(onAnnotated).toHaveBeenCalledWith({
      sliceTitle: 'Test slice',
      missingSymbols: ['loadWorkflowForKind'],
      missingReadFirstPaths: ['src/fake-path.ts'],
    })
  })

  it('retains last missing path when removal would leave readFirst empty', () => {
    vi.spyOn(sliceRefValidator, 'validateSliceReferences').mockReturnValue({
      missingSymbols: [],
      missingReadFirstPaths: ['src/only-path.ts'],
    })

    const slice = makeSlice({
      readFirst: ['src/only-path.ts'],
    })
    const onAnnotated = vi.fn()

    annotateUnresolvedReferences([slice], '/some/root', onAnnotated)

    // The path is retained (fallback) — readFirst must not be empty.
    expect(slice.readFirst).toEqual(['src/only-path.ts'])
    // Caveat records the retention
    expect(slice.prescriptiveAction).toContain('retained as fallback')
    expect(onAnnotated).toHaveBeenCalledTimes(1)
  })

  it('fires onAnnotated exactly once per annotated slice', () => {
    vi.spyOn(sliceRefValidator, 'validateSliceReferences').mockReturnValue({
      missingSymbols: ['sym'],
      missingReadFirstPaths: [],
    })

    const slices = [makeSlice({ title: 'A' }), makeSlice({ title: 'B' })]
    const onAnnotated = vi.fn()

    annotateUnresolvedReferences(slices, '/some/root', onAnnotated)

    expect(onAnnotated).toHaveBeenCalledTimes(2)
    expect(onAnnotated.mock.calls[0][0].sliceTitle).toBe('A')
    expect(onAnnotated.mock.calls[1][0].sliceTitle).toBe('B')
  })

  it('leaves slices with no missing references untouched and does not fire callback', () => {
    vi.spyOn(sliceRefValidator, 'validateSliceReferences').mockReturnValue({
      missingSymbols: [],
      missingReadFirstPaths: [],
    })

    const originalAction = 'Add `myFunc` to the module.'
    const originalReadFirst = ['src/real-path.ts']
    const slice = makeSlice({
      prescriptiveAction: originalAction,
      readFirst: [...originalReadFirst],
    })
    const onAnnotated = vi.fn()

    annotateUnresolvedReferences([slice], '/some/root', onAnnotated)

    expect(slice.prescriptiveAction).toBe(originalAction)
    expect(slice.readFirst).toEqual(originalReadFirst)
    expect(onAnnotated).not.toHaveBeenCalled()
  })
})
