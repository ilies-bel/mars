/**
 * Tests for daemonPaths() socket-path fallback.
 *
 * Contract:
 *   - A short repo root yields the unchanged natural .mars/watch.sock path
 *     (regression guard for every normal install).
 *   - A repo root long enough to push the natural path past the 103-byte OS
 *     limit yields a deterministic fallback path under os.tmpdir().
 *   - The fallback path is itself within the 103-byte limit.
 *   - The fallback is deterministic — two independent calls for the same long
 *     repo root return the same socket path.
 *   - Two different long repo roots yield distinct fallback paths.
 *   - Path length is measured in bytes (Buffer.byteLength), not characters —
 *     a repo root with multi-byte characters that is under the limit in
 *     character count but over it in byte count triggers the fallback.
 *
 * No daemon needs to start for any of these tests.
 *
 * NOTE: tests pass the repo path explicitly to daemonPaths(repo) rather than
 * via the MARS_REPO env var so each call bypasses resolveContext's global
 * cache (the cache is skipped when the `override` argument is provided).
 *
 * NOTE: vitest sets os.tmpdir() to an isolation subdirectory (e.g.
 * /var/.../T/vt-mars-XXXXXX) which is ~63 bytes on this system. Adding
 * 'mars-sock-test-XXXXXX/repo/.mars/watch.sock' (+44 bytes) therefore pushes
 * the natural socket path to ~107 bytes — over the 103-byte limit. To obtain
 * a "short" repo path, tests use tmpBase directly as the repo root (not a
 * subdirectory), giving a natural socket of ~102 bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { daemonPaths } from '../paths'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpBase: string

beforeEach(() => {
  tmpBase = mkdtempSync(resolve(tmpdir(), 'mars-sock-test-'))
})

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true })
})

/** Create a minimal git repo with a .mars directory at `repoPath`. */
const makeGitRepo = (repoPath: string): void => {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repoPath })
  mkdirSync(resolve(repoPath, '.mars'), { recursive: true })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemonPaths — socket path fallback', () => {
  it('short repo root: socket equals the natural .mars/watch.sock path', () => {
    // Use tmpBase itself as the repo root (no extra subdirectory) to stay
    // within the 103-byte limit even inside vitest's isolation tmpdir.
    // naturalSocket ≈ tmpBase (85 B) + '/.mars/watch.sock' (17 B) = 102 B.
    const repo = tmpBase
    makeGitRepo(repo)

    const naturalSocket = resolve(repo, '.mars', 'watch.sock')
    if (Buffer.byteLength(naturalSocket, 'utf8') > 103) {
      // System tmpdir is unusually long — the fallback tests still exercise
      // the fallback path; skip this one gracefully.
      return
    }

    const paths = daemonPaths(repo)
    expect(paths.socket).toBe(naturalSocket)
  })

  it('long repo root: socket falls back to a path under os.tmpdir()', () => {
    // 120 'a' chars guarantee the natural path is well over the 103-byte limit
    // regardless of the vitest isolation prefix in os.tmpdir().
    const repo = resolve(tmpBase, 'a'.repeat(120))
    makeGitRepo(repo)

    const paths = daemonPaths(repo)

    // Must NOT be the natural path.
    const naturalPath = resolve(repo, '.mars', 'watch.sock')
    expect(paths.socket).not.toBe(naturalPath)
    // Must live under the system temp directory.
    expect(paths.socket.startsWith(tmpdir())).toBe(true)
    // Must itself be within the OS limit.
    expect(Buffer.byteLength(paths.socket, 'utf8')).toBeLessThanOrEqual(103)
  })

  it('fallback is deterministic: two calls for the same long repo root return the same socket path', () => {
    const repo = resolve(tmpBase, 'b'.repeat(120))
    makeGitRepo(repo)

    const first = daemonPaths(repo)
    const second = daemonPaths(repo)
    expect(first.socket).toBe(second.socket)
  })

  it('two different long repo roots yield different fallback socket paths', () => {
    const repoA = resolve(tmpBase, 'a'.repeat(120))
    const repoB = resolve(tmpBase, 'b'.repeat(120))
    makeGitRepo(repoA)
    makeGitRepo(repoB)

    const { socket: socketA } = daemonPaths(repoA)
    const { socket: socketB } = daemonPaths(repoB)

    expect(socketA).not.toBe(socketB)
  })

  it('multi-byte characters: length is measured in bytes, not characters', () => {
    // '€' is 3 bytes in UTF-8 but 1 character. We construct a path where
    // charLen(naturalSocket) ≤ 103 but byteLen(naturalSocket) > 103, proving
    // that Buffer.byteLength (not String.length) gates the check.
    //
    // Place the euro-named dir directly under os.tmpdir() (bypassing the
    // mars-sock-test-XXXXXX subdir) to keep charLen in budget:
    //
    //   naturalSocket = tmpdir() + '/' + n_euros + '/.mars/watch.sock'
    //   charLen       = T  + 1 + n + 17
    //   byteLen       = T  + 1 + 3n + 17   (T bytes, assuming ASCII-only tmpdir)
    //
    // Constraints:
    //   byteLen > 103  →  n > (85 - T) / 3
    //   charLen ≤ 103  →  n ≤ 85 - T
    //
    // This has a solution whenever T < 85 (i.e. tmpdir < 85 bytes).

    const td = tmpdir()
    const T = Buffer.byteLength(td, 'utf8')

    if (T >= 85) {
      // tmpdir itself is so long that no euro path can satisfy both
      // constraints — skip gracefully.
      return
    }

    // Smallest n such that byteLen > 103.
    const n = Math.floor((85 - T) / 3) + 1
    if (n > 85 - T) {
      // No integer satisfies both constraints in this environment.
      return
    }

    const euroSuffix = '€'.repeat(n)
    const repo = resolve(td, euroSuffix)
    let repoCreated = false
    try {
      makeGitRepo(repo)
      repoCreated = true

      const paths = daemonPaths(repo)
      const naturalSocket = resolve(repo, '.mars', 'watch.sock')

      // Confirm our construction: byte count exceeds the limit…
      expect(Buffer.byteLength(naturalSocket, 'utf8')).toBeGreaterThan(103)
      // …but character count does not.
      expect(naturalSocket.length).toBeLessThanOrEqual(103)

      // The fallback must have triggered.
      expect(paths.socket).not.toBe(naturalSocket)
      expect(paths.socket.startsWith(td)).toBe(true)
    } finally {
      if (repoCreated) rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fallback writes watch.sock.path into the .mars directory', () => {
    const repo = resolve(tmpBase, 'c'.repeat(120))
    makeGitRepo(repo)

    const paths = daemonPaths(repo)

    // The pointer file must have been written.
    expect(existsSync(paths.socketPathFile)).toBe(true)
    // Its content must name the actual socket path (plus a trailing newline).
    const content = readFileSync(paths.socketPathFile, 'utf8')
    expect(content.trim()).toBe(paths.socket)
  })

  it('short repo root: socketPathFile is set in the interface but the file is not written', () => {
    // Same as the first test — use tmpBase directly as the repo root so the
    // natural socket path is within the 103-byte limit.
    const repo = tmpBase
    makeGitRepo(repo)

    const naturalSocket = resolve(repo, '.mars', 'watch.sock')
    if (Buffer.byteLength(naturalSocket, 'utf8') > 103) {
      // System tmpdir is unusually long — skip.
      return
    }

    const paths = daemonPaths(repo)

    // socketPathFile is always present in the returned object…
    expect(paths.socketPathFile).toBeTruthy()
    expect(paths.socketPathFile).toMatch(/watch\.sock\.path$/)
    // …but the indirection file must NOT be written when the natural path fits.
    expect(existsSync(paths.socketPathFile)).toBe(false)
  })
})

