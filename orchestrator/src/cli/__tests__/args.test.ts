/**
 * Unit tests for `parseArgs` greedy-consumption of REPEATABLE_FLAGS.
 *
 * Before the fix, `--files a b c` would capture only `a` into
 * `multiFlags['--files']` and push `b` and `c` into `positional`, which then
 * collided with other prompt sources and produced a misleading
 * "multiple prompt sources supplied" error. After the fix, ALL space-separated
 * non-flag tokens following a REPEATABLE_FLAG are greedily consumed.
 */

import { describe, it, expect } from 'vitest'
import { hasFlag, parseArgs } from '../args'

describe('boolean flags', () => {
  it('reports a supplied boolean flag even though it is not positional', () => {
    const args = parseArgs(['--lean'])

    expect(hasFlag(args, '--lean')).toBe(true)
    expect(args.positional).toEqual([])
  })

  it('normalizes the -y alias to --yes', () => {
    expect(hasFlag(parseArgs(['-y']), '--yes')).toBe(true)
  })

  it('parses --verify-gates-json as a value-bearing init override', () => {
    const value = '[{"scope":".","name":"test","cmd":"npm","args":["test"],"required":true,"tier":"task"}]'

    expect(parseArgs(['--verify-gates-json', value]).flags['--verify-gates-json']).toBe(value)
  })
})

describe('parseArgs — REPEATABLE_FLAGS greedy consumption', () => {
  it('--files a b c captures all three paths and leaves positional empty', () => {
    const result = parseArgs(['--files', 'a', 'b', 'c'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b', 'c'])
    expect(result.positional).toEqual([])
  })

  it('--files a --files b still yields [a, b] (repeated-flag form)', () => {
    const result = parseArgs(['--files', 'a', '--files', 'b'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.positional).toEqual([])
  })

  it('a following --flag stops greedy consumption', () => {
    const result = parseArgs(['--files', 'a', 'b', '--verify', 'cmd'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.flags['--verify']).toBe('cmd')
    expect(result.positional).toEqual([])
  })

  it('a lone - (stdin sentinel) stops greedy consumption', () => {
    const result = parseArgs(['--files', 'a', 'b', '-'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.positional).toEqual(['-'])
  })

  it('inline prompt before flags does not bleed into greedy consumption', () => {
    const result = parseArgs(['do X', '--files', 'a', 'b'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.positional).toEqual(['do X'])
  })

  it('--files=a (inline form) binds exactly one value; trailing tokens are positional', () => {
    const result = parseArgs(['--files=a', 'b'])
    expect(result.multiFlags['--files']).toEqual(['a'])
    expect(result.positional).toEqual(['b'])
  })

  it('--done a b c captures all done-criteria', () => {
    const result = parseArgs(['--done', 'criterion one', 'criterion two', 'criterion three'])
    expect(result.multiFlags['--done']).toEqual(['criterion one', 'criterion two', 'criterion three'])
    expect(result.positional).toEqual([])
  })

  it('--blocked-by id1 id2 captures both ids', () => {
    const result = parseArgs(['--blocked-by', 'id1', 'id2'])
    expect(result.multiFlags['--blocked-by']).toEqual(['id1', 'id2'])
    expect(result.positional).toEqual([])
  })

  it('--tag a b c captures all tags', () => {
    const result = parseArgs(['--tag', 'a', 'b', 'c'])
    expect(result.multiFlags['--tag']).toEqual(['a', 'b', 'c'])
    expect(result.positional).toEqual([])
  })

  it('interleaved flags and greedy repeatable flags both parse correctly', () => {
    const result = parseArgs(['--priority', '2', '--files', 'x', 'y', '--verify', 'npm test'])
    expect(result.flags['--priority']).toBe('2')
    expect(result.multiFlags['--files']).toEqual(['x', 'y'])
    expect(result.flags['--verify']).toBe('npm test')
    expect(result.positional).toEqual([])
  })

  it('single value for a repeatable flag still works', () => {
    const result = parseArgs(['--files', 'only-one.ts'])
    expect(result.multiFlags['--files']).toEqual(['only-one.ts'])
    expect(result.positional).toEqual([])
  })

  it('two greedy repeatable flags in sequence each consume their own non-flag tokens', () => {
    // --files a b --blocked-by id1 id2: `--blocked-by` starts with `-` so it
    // terminates --files greedy consumption; then --blocked-by's own greedy
    // loop picks up id1 and id2.
    const result = parseArgs(['--files', 'a', 'b', '--blocked-by', 'id1', 'id2'])
    expect(result.multiFlags['--files']).toEqual(['a', 'b'])
    expect(result.multiFlags['--blocked-by']).toEqual(['id1', 'id2'])
    expect(result.positional).toEqual([])
  })
})
