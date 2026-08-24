/**
 * Tests for the semaphore.ts wrapper around `~/.claude/bin/sem.mjs`.
 *
 * Three boundaries are covered:
 *  - The degrade-to-no-op path when the binary is absent (a fabricated
 *    nonexistent binPath — must not throw, must return a null token).
 *  - The MARS_TEST_SEMAPHORE=inproc mock (what test/setup-env.ts sets for the
 *    whole vitest suite) and its opt-out via an explicit binPath/env — the
 *    seam that keeps every *other* suite off the real machine-global lock.
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

describe('acquireSemaphore — in-process mock (MARS_TEST_SEMAPHORE=inproc)', () => {
  const ORIGINAL = process.env.MARS_TEST_SEMAPHORE

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MARS_TEST_SEMAPHORE
    else process.env.MARS_TEST_SEMAPHORE = ORIGINAL
  })

  it('grants a permit immediately without touching the binary when no binPath/env override is passed', async () => {
    process.env.MARS_TEST_SEMAPHORE = 'inproc'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const permit = await acquireSemaphore('inproc-resource', { holder: 'test-holder' })
      expect(permit.resource).toBe('inproc-resource')
      expect(permit.token).not.toBeNull()
      // Never touched sem.mjs, so none of its warn paths (missing binary,
      // wait-elapsed holder line) were reached.
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('releaseSemaphore on an in-process mock permit is a no-op', async () => {
    process.env.MARS_TEST_SEMAPHORE = 'inproc'
    const permit = await acquireSemaphore('inproc-resource', { holder: 'test-holder' })
    await expect(releaseSemaphore(permit)).resolves.toBeUndefined()
  })

  it('opts out of the mock when the caller explicitly passes binPath, even with the flag set', async () => {
    process.env.MARS_TEST_SEMAPHORE = 'inproc'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const permit = await acquireSemaphore('browser', {
        holder: 'test-holder',
        binPath: '/definitely/does/not/exist/sem.mjs',
      })
      // Fell through to the real (missing-binary degrade) path, not the
      // mock: the mock always grants a non-null token, this must be null.
      expect(permit.token).toBeNull()
      expect(permit.binPath).toBe('/definitely/does/not/exist/sem.mjs')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not apply when MARS_TEST_SEMAPHORE is unset', async () => {
    delete process.env.MARS_TEST_SEMAPHORE
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const permit = await acquireSemaphore('browser', {
        holder: 'test-holder',
        binPath: '/definitely/does/not/exist/sem.mjs',
      })
      expect(permit.token).toBeNull()
      expect(permit.binPath).toBe('/definitely/does/not/exist/sem.mjs')
    } finally {
      warnSpy.mockRestore()
    }
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
