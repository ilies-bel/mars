import { describe, expect, it } from 'vitest'
import { makeFixture, replayGateAgainstFixtures } from '../gate-replay.js'
import type { GateReplayFixture } from '../gate-replay.js'

/** A trivial gate matcher: catches output containing the word "FAIL". */
const containsFail = (output: string): boolean => output.includes('FAIL')

describe('makeFixture', () => {
  it('derives family from signature', () => {
    const fixture = makeFixture({
      signature: 'code:commit-contract/uncommitted-changes',
      verifyOutput: 'FAIL: uncommitted changes',
      expected: 'catch',
      sourceTaskId: 'task-1',
    })

    expect(fixture).toEqual({
      signature: 'code:commit-contract/uncommitted-changes',
      family: 'code/uncommitted-changes',
      verifyOutput: 'FAIL: uncommitted changes',
      expected: 'catch',
      sourceTaskId: 'task-1',
    })
  })
})

describe('round-tripping a fixture through JSON', () => {
  it('preserves every field', () => {
    const fixture = makeFixture({
      signature: 'verify:has-diff/no-commits-ahead',
      verifyOutput: 'some raw verify output\nwith multiple lines',
      expected: 'pass',
      sourceTaskId: 'task-42',
    })

    const roundTripped = JSON.parse(JSON.stringify(fixture)) as GateReplayFixture

    expect(roundTripped).toEqual(fixture)
    expect(roundTripped.signature).toBe(fixture.signature)
    expect(roundTripped.family).toBe(fixture.family)
    expect(roundTripped.verifyOutput).toBe(fixture.verifyOutput)
    expect(roundTripped.expected).toBe(fixture.expected)
    expect(roundTripped.sourceTaskId).toBe(fixture.sourceTaskId)
  })
})

describe('replayGateAgainstFixtures', () => {
  const fixture = (
    overrides: Partial<GateReplayFixture> & { verifyOutput: string; expected: 'catch' | 'pass' },
  ): GateReplayFixture =>
    makeFixture({
      signature: 'code:commit-contract/uncommitted-changes',
      sourceTaskId: 'task-1',
      ...overrides,
    })

  it('reports all-caught when every fixture verdict agrees with expected', () => {
    const fixtures = [
      fixture({ verifyOutput: 'FAIL: thing one', expected: 'catch', sourceTaskId: 'task-1' }),
      fixture({ verifyOutput: 'all good, no issues', expected: 'pass', sourceTaskId: 'task-2' }),
      fixture({ verifyOutput: 'FAIL: thing two', expected: 'catch', sourceTaskId: 'task-3' }),
    ]

    const result = replayGateAgainstFixtures(containsFail, fixtures)

    expect(result).toEqual({ caught: 3, missed: 0, total: 3, misses: [] })
  })

  it('reports all-missed when every fixture verdict disagrees with expected', () => {
    const fixtures = [
      fixture({ verifyOutput: 'all good, no issues', expected: 'catch', sourceTaskId: 'task-1' }),
      fixture({ verifyOutput: 'FAIL: should have passed', expected: 'pass', sourceTaskId: 'task-2' }),
    ]

    const result = replayGateAgainstFixtures(containsFail, fixtures)

    expect(result.caught).toBe(0)
    expect(result.missed).toBe(2)
    expect(result.total).toBe(2)
    expect(result.misses).toEqual(fixtures)
  })

  it('reports a partial catch, collecting only the misses', () => {
    const caughtFixture = fixture({
      verifyOutput: 'FAIL: real failure',
      expected: 'catch',
      sourceTaskId: 'task-1',
    })
    const missedFixture = fixture({
      verifyOutput: 'all good, no issues',
      expected: 'catch',
      sourceTaskId: 'task-2',
    })
    const passingFixture = fixture({
      verifyOutput: 'all good, no issues',
      expected: 'pass',
      sourceTaskId: 'task-3',
    })

    const result = replayGateAgainstFixtures(containsFail, [
      caughtFixture,
      missedFixture,
      passingFixture,
    ])

    expect(result.total).toBe(3)
    expect(result.caught).toBe(2)
    expect(result.missed).toBe(1)
    expect(result.misses).toEqual([missedFixture])
  })

  it('returns all-zero on an empty fixture set with no DB or network access', () => {
    const result = replayGateAgainstFixtures(containsFail, [])

    expect(result).toEqual({ caught: 0, missed: 0, total: 0, misses: [] })
  })
})
