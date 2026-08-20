/**
 * Tests for the semaphore.ts wrapper around `~/.claude/bin/sem.mjs`.
 *
 * Two boundaries are covered:
 *  - The degrade-to-no-op path when the binary is absent (a fabricated
 *    nonexistent binPath — must not throw, must return a null token).
 *  - A real round trip against the actual sem.mjs binary, sandboxed to a
 *    temp SEM_ROOT so it never touches the operator's real
 *    ~/.claude/semaphores state. Skipped automatically when the binary
 *    is not installed on the host running the suite (e.g. CI).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { acquireSemaphore, releaseSemaphore } from '../semaphore'

const REAL_BIN_PATH = join(homedir(), '.claude', 'bin', 'sem.mjs')
const hasRealBinary = existsSync(REAL_BIN_PATH)

describe('acquireSemaphore — degrade to no-op when the binary is absent', () => {
  it('returns a null-token permit without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const permit = await acquireSemaphore('browser', {
        holder: 'test-holder',
        binPath: '/definitely/does/not/exist/sem.mjs',
      })
      expect(permit.token).toBeNull()
      expect(permit.resource).toBe('browser')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('releaseSemaphore on a degraded (null-token) permit is a no-op', async () => {
    const permit = await acquireSemaphore('browser', {
      holder: 'test-holder',
      binPath: '/definitely/does/not/exist/sem.mjs',
    })
    // Must resolve cleanly — nothing was ever held, nothing to release.
    await expect(releaseSemaphore(permit)).resolves.toBeUndefined()
  })
})

describe.skipIf(!hasRealBinary)('acquireSemaphore — real binary round trip', () => {
  let semRoot: string

  beforeEach(() => {
    semRoot = mkdtempSync(join(tmpdir(), 'mars-sem-test-'))
  })

  afterEach(() => {
    rmSync(semRoot, { recursive: true, force: true })
  })

  it('acquires a token, then a second acquire on the same (capacity-1) resource degrades', async () => {
    const first = await acquireSemaphore('test-resource', {
      holder: 'holder-one',
      env: { SEM_ROOT: semRoot },
    })
    expect(first.token).not.toBeNull()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // wait 0 (default) — the resource is already held, so this must
      // degrade rather than block or throw.
      const second = await acquireSemaphore('test-resource', {
        holder: 'holder-two',
        env: { SEM_ROOT: semRoot },
      })
      expect(second.token).toBeNull()
    } finally {
      warnSpy.mockRestore()
    }

    await releaseSemaphore(first)
  })

  it('release actually frees the slot for a subsequent acquire', async () => {
    const first = await acquireSemaphore('test-resource-2', {
      holder: 'holder-one',
      env: { SEM_ROOT: semRoot },
    })
    expect(first.token).not.toBeNull()

    await releaseSemaphore(first)

    const second = await acquireSemaphore('test-resource-2', {
      holder: 'holder-two',
      env: { SEM_ROOT: semRoot },
    })
    expect(second.token).not.toBeNull()

    await releaseSemaphore(second)
  })
})
