import { mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeDuckDBLock } from '../duckdb-lock'

const tmpFile = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-duckdb-lock-'))
  const path = join(dir, name)
  writeFileSync(path, '')
  return path
}

describe('probeDuckDBLock', () => {
  it('reports free when no process holds the file', () => {
    const path = tmpFile('observability.duckdb')
    expect(probeDuckDBLock(path)).toEqual({ status: 'free', holderPid: null })
  })

  it('reports free for a non-existent path', () => {
    const probe = probeDuckDBLock('/nonexistent/observability.duckdb')
    expect(probe).toEqual({ status: 'free', holderPid: null })
  })

  it('ignores the current process as a holder', () => {
    const path = tmpFile('observability.duckdb')
    const fd = openSync(path, 'r+')
    try {
      expect(probeDuckDBLock(path).status).toBe('free')
    } finally {
      closeSync(fd)
    }
  })
})
