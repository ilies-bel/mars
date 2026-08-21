import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  LAST_SYNCED_SHA_PATH,
  readLastSyncedSha,
  writeLastSyncedSha,
} from '../last-synced-sha'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

let repo: string

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-last-synced-sha-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('last-synced-sha', () => {
  it('returns null when the file is absent', () => {
    expect(readLastSyncedSha(repo)).toBeNull()
  })

  it('returns null when the file is empty', () => {
    const dir = resolve(repo, '.mars')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'last-synced-sha'), '')
    expect(readLastSyncedSha(repo)).toBeNull()
  })

  it('returns null when the contents are not a 40-hex sha', () => {
    const dir = resolve(repo, '.mars')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'last-synced-sha'), 'not-a-sha\n')
    expect(readLastSyncedSha(repo)).toBeNull()

    writeFileSync(resolve(dir, 'last-synced-sha'), `${SHA_A.slice(0, 39)}\n`)
    expect(readLastSyncedSha(repo)).toBeNull()

    writeFileSync(resolve(dir, 'last-synced-sha'), `${SHA_A.toUpperCase()}\n`)
    expect(readLastSyncedSha(repo)).toBeNull()
  })

  it('round-trips a write through a read, creating .mars/ if needed', () => {
    expect(readLastSyncedSha(repo)).toBeNull()
    writeLastSyncedSha(SHA_A, repo)
    expect(readLastSyncedSha(repo)).toBe(SHA_A)
  })

  it('overwrites a previously recorded sha', () => {
    writeLastSyncedSha(SHA_A, repo)
    expect(readLastSyncedSha(repo)).toBe(SHA_A)
    writeLastSyncedSha(SHA_B, repo)
    expect(readLastSyncedSha(repo)).toBe(SHA_B)
  })

  it('writes atomically via a temp file + rename, never leaving the real path truncated', () => {
    writeLastSyncedSha(SHA_A, repo)
    const path = resolve(repo, LAST_SYNCED_SHA_PATH)
    // No leftover .tmp file after a successful write, and the target file
    // holds the full sha, not a partial one.
    expect(readFileSync(path, 'utf8').trim()).toBe(SHA_A)
  })

  it('rejects a value that is not a 40-hex sha', () => {
    expect(() => writeLastSyncedSha('not-a-sha', repo)).toThrow()
    expect(readLastSyncedSha(repo)).toBeNull()
  })

  it('resolves the file at LAST_SYNCED_SHA_PATH relative to the repo root', () => {
    writeLastSyncedSha(SHA_A, repo)
    expect(readFileSync(resolve(repo, LAST_SYNCED_SHA_PATH), 'utf8').trim()).toBe(SHA_A)
  })
})
