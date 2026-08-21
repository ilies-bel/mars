import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evalFixtureSchema, type EvalFixture } from '../fixture'
import { replayFixture, type ReplayTranscript } from '../replay'
import { scoreRecovery, scoreSlicing, scoreVerify } from '../scorers'

const __dirname = dirname(fileURLToPath(import.meta.url))

const loadFixture = (name: string): EvalFixture => {
  const raw = readFileSync(join(__dirname, '..', 'fixtures', `${name}.json`), 'utf8')
  return evalFixtureSchema.parse(JSON.parse(raw))
}

describe('scoreSlicing()', () => {
  it('scores 1.0 when every changed file was surfaced by the code-index slice', async () => {
    const fixture = loadFixture('basic-slice')
    const transcript = await replayFixture(fixture)

    const result = scoreSlicing(transcript)

    expect(result.dimension).toBe('slicing')
    expect(result.score).toBe(1)
    expect(result.rubric).toMatch(/code-index/)
  })

  it('scores 0.0 when the code-index slice missed every changed file', async () => {
    const fixture = loadFixture('basic-slice')
    const missedSlice: EvalFixture = {
      ...fixture,
      name: 'basic-slice-missed',
      stubs: {
        ...fixture.stubs,
        codeIndex: { ...fixture.stubs.codeIndex, search: [] },
      },
    }
    const transcript = await replayFixture(missedSlice)

    const result = scoreSlicing(transcript)

    expect(result.score).toBe(0)
  })

  it('scores 1.0 vacuously when the executor changed no files', async () => {
    const fixture = loadFixture('basic-slice')
    const noChanges: EvalFixture = {
      ...fixture,
      name: 'basic-slice-no-changes',
      stubs: {
        ...fixture.stubs,
        executor: { ...fixture.stubs.executor, filesChanged: [] },
      },
    }
    const transcript = await replayFixture(noChanges)

    const result = scoreSlicing(transcript)

    expect(result.score).toBe(1)
  })
})

describe('scoreVerify()', () => {
  it('scores 1.0 when the verify decision is self-consistent and matches expected', async () => {
    const fixture = loadFixture('basic-slice')
    const transcript = await replayFixture(fixture)

    const result = scoreVerify(transcript)

    expect(result.dimension).toBe('verify')
    expect(result.score).toBe(1)
  })

  it('scores 0.5 when internally consistent but diverging from the expected decision', async () => {
    const fixture = loadFixture('basic-slice')
    const skewed: EvalFixture = {
      ...fixture,
      name: 'basic-slice-verify-skewed',
      stubs: {
        ...fixture.stubs,
        verifier: {
          ...fixture.stubs.verifier,
          passed: false,
          verdict: 'FAIL',
          steps: fixture.stubs.verifier.steps.map((s) => ({ ...s, passed: false })),
        },
      },
      expectedDecisions: { ...fixture.expectedDecisions, verifierPassed: true },
    }
    const transcript = await replayFixture(skewed)

    const result = scoreVerify(transcript)

    expect(result.score).toBe(0.5)
  })

  it('scores 0.0 when internally inconsistent and diverging from expected', async () => {
    const fixture = loadFixture('basic-slice')
    const inconsistent: EvalFixture = {
      ...fixture,
      name: 'basic-slice-verify-inconsistent',
      stubs: {
        ...fixture.stubs,
        // passed=true but every step failed: internally inconsistent.
        verifier: { ...fixture.stubs.verifier, passed: true, verdict: 'PASS' },
      },
      expectedDecisions: { ...fixture.expectedDecisions, verifierPassed: false },
    }
    // Force step-level failure so `passed` disagrees with the steps.
    inconsistent.stubs.verifier.steps = inconsistent.stubs.verifier.steps.map((s) => ({
      ...s,
      passed: false,
    }))
    const transcript = await replayFixture(inconsistent)

    const result = scoreVerify(transcript)

    expect(result.score).toBe(0)
  })
})

describe('scoreRecovery()', () => {
  it('scores 1.0 when finalVerdict correctly composes executor/verifier outcomes and matches expected', async () => {
    const fixture = loadFixture('basic-slice')
    const transcript = await replayFixture(fixture)

    const result = scoreRecovery(transcript)

    expect(result.dimension).toBe('recovery')
    expect(result.score).toBe(1)
  })

  it('scores 0.5 when composition is correct but the fixture expected a different outcome', async () => {
    const fixture = loadFixture('basic-slice')
    const wrongExpectation: EvalFixture = {
      ...fixture,
      name: 'basic-slice-recovery-wrong-expectation',
      expectedDecisions: { ...fixture.expectedDecisions, finalVerdict: 'failed' },
    }
    const transcript = await replayFixture(wrongExpectation)

    const result = scoreRecovery(transcript)

    expect(result.score).toBe(0.5)
  })

  it('scores 0.5 when the verifier fails and the fixture expected the opposite verdict', async () => {
    // finalVerdict is derived in-pipeline as executorSuccess && verifierPassed, so a
    // real replay is always internally consistent with its own inputs — only the
    // "matches expected" half of the rubric can move here.
    const fixture = loadFixture('basic-slice')
    const failingVerify: EvalFixture = {
      ...fixture,
      name: 'basic-slice-recovery-verify-fail',
      stubs: {
        ...fixture.stubs,
        verifier: { ...fixture.stubs.verifier, passed: false, verdict: 'FAIL' },
      },
      expectedDecisions: { ...fixture.expectedDecisions, verifierPassed: true, finalVerdict: 'done' },
    }
    const transcript = await replayFixture(failingVerify)

    const result = scoreRecovery(transcript)

    expect(result.score).toBe(0.5)
  })

  it('scores 0.0 when finalVerdict does not correctly compose executorSuccess/verifierPassed', () => {
    // Hand-built transcript (bypassing replayFixture, which always composes
    // correctly by construction) to exercise the composition-consistency half
    // of the rubric independently.
    const transcript: ReplayTranscript = {
      fixtureName: 'synthetic-inconsistent',
      steps: [],
      decisions: { executorSuccess: true, verifierPassed: true, finalVerdict: 'failed' },
      matchesExpected: false,
      mismatches: ['finalVerdict'],
    }

    const result = scoreRecovery(transcript)

    expect(result.score).toBe(0)
  })
})

describe('determinism', () => {
  it('produces byte-identical scores across repeated runs of the same fixture', async () => {
    const fixture = loadFixture('basic-slice')

    const first = await replayFixture(fixture)
    const second = await replayFixture(fixture)

    expect(scoreSlicing(second)).toEqual(scoreSlicing(first))
    expect(scoreVerify(second)).toEqual(scoreVerify(first))
    expect(scoreRecovery(second)).toEqual(scoreRecovery(first))
  })
})
