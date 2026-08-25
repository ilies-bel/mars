import { describe, expect, it } from 'vitest'
import { extractFailingTestFiles } from '../vitest-output-parser'

describe('extractFailingTestFiles', () => {
  it('returns the file path from a single FAIL marker line', () => {
    const output = [
      '',
      ' FAIL  src/core/lib/__tests__/queue-fix-tasks.test.ts > handleTaskFailure > spawns fix task',
      '  AssertionError: expected 1 to equal 2',
      '    at Object.<anonymous> (queue-fix-tasks.test.ts:42:30)',
      '',
      ' FAIL Files  1 failed (1)',
      ' FAIL Tests  1 failed (1)',
      '',
    ].join('\n')

    expect(extractFailingTestFiles(output)).toEqual([
      'src/core/lib/__tests__/queue-fix-tasks.test.ts',
    ])
  })

  it('returns all unique file paths from multiple FAIL marker lines', () => {
    const output = [
      ' FAIL  src/core/lib/__tests__/foo.test.ts > suite A > assertion failed',
      ' FAIL  src/core/lib/__tests__/bar.test.ts > suite B > different failure',
      '',
      ' FAIL Files  2 failed (2)',
      ' FAIL Tests  2 failed (2)',
    ].join('\n')

    const result = extractFailingTestFiles(output)
    expect(result).toHaveLength(2)
    expect(result).toContain('src/core/lib/__tests__/foo.test.ts')
    expect(result).toContain('src/core/lib/__tests__/bar.test.ts')
  })

  it('deduplicates when the same file appears in multiple FAIL lines', () => {
    const output = [
      ' FAIL  src/core/lib/__tests__/foo.test.ts > suite > test 1',
      ' FAIL  src/core/lib/__tests__/foo.test.ts > suite > test 2',
      '',
      ' FAIL Files  1 failed (2)',
    ].join('\n')

    expect(extractFailingTestFiles(output)).toEqual([
      'src/core/lib/__tests__/foo.test.ts',
    ])
  })

  it('returns an empty array when there are no FAIL lines', () => {
    const output = [
      'Error: Command failed: npx tsc --noEmit',
      'src/core/lib/thing.ts:42:5 - error TS2345: Argument of type string is not assignable to number',
      '',
      'Found 1 error.',
    ].join('\n')

    expect(extractFailingTestFiles(output)).toEqual([])
  })

  it('extracts file paths from ❯ arrow-prefixed file summary lines', () => {
    const output = [
      '❯ src/core/lib/__tests__/foo.test.ts (2ms)',
      '  ❯ describe block (1ms)',
      '    × failing test (1ms)',
      '      AssertionError: expected 2 to equal 1',
    ].join('\n')

    expect(extractFailingTestFiles(output)).toEqual([
      'src/core/lib/__tests__/foo.test.ts',
    ])
  })

  it('ignores FAIL summary lines that do not name a test file', () => {
    const output = [
      ' FAIL Files  3 failed (5)',
      ' FAIL Tests  3 failed | 2 passed (5)',
    ].join('\n')

    expect(extractFailingTestFiles(output)).toEqual([])
  })

  it('strips ANSI escape codes before parsing', () => {
    // Simulates vitest output with colour codes wrapping FAIL and the file path
    const output =
      '\x1B[31m FAIL \x1B[0m src/core/lib/__tests__/foo.test.ts > suite > test'

    expect(extractFailingTestFiles(output)).toEqual([
      'src/core/lib/__tests__/foo.test.ts',
    ])
  })

  it('handles .test.tsx files', () => {
    const output = ' FAIL  src/components/__tests__/Button.test.tsx > renders correctly'

    expect(extractFailingTestFiles(output)).toEqual([
      'src/components/__tests__/Button.test.tsx',
    ])
  })

  it('returns an empty array for empty string input', () => {
    expect(extractFailingTestFiles('')).toEqual([])
  })
})
