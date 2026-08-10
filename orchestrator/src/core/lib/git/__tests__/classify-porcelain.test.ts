/**
 * Unit tests for classifyPorcelainLines.
 *
 * classifyPorcelainLines is a pure function — no side effects, no mocks needed.
 * Tests verify behaviour from the public interface only.
 */
import { describe, expect, it } from 'vitest'
import { classifyPorcelainLines } from '../classify-porcelain'

describe('classifyPorcelainLines', () => {
  it('classifies a .mars/ path as orchestrator-owned', () => {
    const result = classifyPorcelainLines(['M  .mars/pg/data/PG_VERSION'])
    expect(result.orchestratorOwned).toEqual(['.mars/pg/data/PG_VERSION'])
    expect(result.userOwned).toEqual([])
  })

  it('classifies a non-.mars/ path as user-owned', () => {
    const result = classifyPorcelainLines(['M  src/index.ts'])
    expect(result.orchestratorOwned).toEqual([])
    expect(result.userOwned).toEqual(['src/index.ts'])
  })

  it('handles a mix of orchestrator-owned and user-owned paths', () => {
    const lines = [
      'M  .mars/daemon.json',
      ' M src/cli.ts',
      '?? .mars/pg/data/pg.conf',
      'A  README.md',
    ]
    const result = classifyPorcelainLines(lines)
    expect(result.orchestratorOwned).toEqual(['.mars/daemon.json', '.mars/pg/data/pg.conf'])
    expect(result.userOwned).toEqual(['src/cli.ts', 'README.md'])
  })

  it('returns empty arrays for empty input', () => {
    const result = classifyPorcelainLines([])
    expect(result.orchestratorOwned).toEqual([])
    expect(result.userOwned).toEqual([])
  })

  it('skips blank lines', () => {
    const result = classifyPorcelainLines(['', 'M  .mars/http.port', ''])
    expect(result.orchestratorOwned).toEqual(['.mars/http.port'])
    expect(result.userOwned).toEqual([])
  })

  it('uses the destination path for renamed files (-> syntax)', () => {
    // Rename: old.txt -> .mars/new.txt — destination is orchestrator-owned
    const result = classifyPorcelainLines(['R  old.txt -> .mars/new.txt'])
    expect(result.orchestratorOwned).toEqual(['.mars/new.txt'])
    expect(result.userOwned).toEqual([])
  })

  it('uses the destination path when rename target is user-owned', () => {
    const result = classifyPorcelainLines(['R  .mars/old.txt -> src/new.ts'])
    expect(result.orchestratorOwned).toEqual([])
    expect(result.userOwned).toEqual(['src/new.ts'])
  })

  it('strips surrounding quotes from quoted paths', () => {
    const result = classifyPorcelainLines(['M  ".mars/path with spaces/file"'])
    expect(result.orchestratorOwned).toEqual(['.mars/path with spaces/file'])
    expect(result.userOwned).toEqual([])
  })

  it('returns only orchestrator-owned when all paths start with .mars/', () => {
    const lines = ['M  .mars/pg.dsn', 'M  .mars/http.port', '?? .mars/pg/data/']
    const result = classifyPorcelainLines(lines)
    expect(result.userOwned).toHaveLength(0)
    expect(result.orchestratorOwned).toHaveLength(3)
  })
})
