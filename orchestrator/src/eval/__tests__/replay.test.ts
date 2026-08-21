import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evalFixtureSchema } from '../fixture'
import { replayFixture } from '../replay'

const __dirname = dirname(fileURLToPath(import.meta.url))

const loadFixture = (name: string) => {
  const raw = readFileSync(join(__dirname, '..', 'fixtures', `${name}.json`), 'utf8')
  return evalFixtureSchema.parse(JSON.parse(raw))
}

describe('evalFixtureSchema', () => {
  it('accepts the committed basic-slice fixture', () => {
    expect(() => loadFixture('basic-slice')).not.toThrow()
  })

  it('rejects a fixture missing a required field', () => {
    expect(() => evalFixtureSchema.parse({ name: 'broken' })).toThrow()
  })
})

describe('replayFixture()', () => {
  it('runs the pipeline against fixture-backed stubs and matches the recorded expected decisions', async () => {
    const fixture = loadFixture('basic-slice')
    const transcript = await replayFixture(fixture)

    expect(transcript.matchesExpected).toBe(true)
    expect(transcript.mismatches).toEqual([])
    expect(transcript.decisions).toEqual(fixture.expectedDecisions)
  })

  it('records one step per port interaction, each fed by the fixture data (no live git/network)', async () => {
    const fixture = loadFixture('basic-slice')
    const transcript = await replayFixture(fixture)

    expect(transcript.steps.map((s) => s.name)).toEqual(['code-index', 'executor', 'verifier'])
    expect(transcript.steps[0].output).toEqual(fixture.stubs.codeIndex.search)
    expect(transcript.steps[1].output).toMatchObject({
      success: fixture.stubs.executor.success,
      filesChanged: fixture.stubs.executor.filesChanged,
    })
    expect(transcript.steps[2].output).toMatchObject({
      passed: fixture.stubs.verifier.passed,
      verdict: fixture.stubs.verifier.verdict,
    })
  })

  it('is deterministic: replaying the same fixture twice produces identical output', async () => {
    const fixture = loadFixture('basic-slice')

    const first = await replayFixture(fixture)
    const second = await replayFixture(fixture)

    expect(second).toEqual(first)
  })

  it('flags a divergence when the pipeline decisions disagree with expectedDecisions', async () => {
    const fixture = loadFixture('basic-slice')
    const skewed = {
      ...fixture,
      name: 'basic-slice-skewed',
      expectedDecisions: { ...fixture.expectedDecisions, finalVerdict: 'failed' as const },
    }

    const transcript = await replayFixture(skewed)

    expect(transcript.matchesExpected).toBe(false)
    expect(transcript.mismatches).toEqual(['finalVerdict'])
  })

  it('reflects a failing verifier stub in the final verdict', async () => {
    const fixture = loadFixture('basic-slice')
    const failing = {
      ...fixture,
      name: 'basic-slice-verify-fail',
      stubs: {
        ...fixture.stubs,
        verifier: { ...fixture.stubs.verifier, passed: false, verdict: 'FAIL' as const },
      },
      expectedDecisions: { ...fixture.expectedDecisions, verifierPassed: false, finalVerdict: 'failed' as const },
    }

    const transcript = await replayFixture(failing)

    expect(transcript.decisions.finalVerdict).toBe('failed')
    expect(transcript.matchesExpected).toBe(true)
  })
})
