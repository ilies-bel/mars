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
