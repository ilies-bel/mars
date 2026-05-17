import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  STALE_DAEMON_HINT,
  assertProposalsSourceFresh,
  captureProposalsStamp,
  isProposalsSourceNewerThan,
  mapDaemonError,
} from '../stale-detection'

describe('mapDaemonError', () => {
  // Pre-rename daemon vs migrated DB: the daemon code still issues
  // `SELECT … FROM ideas`, the table has been renamed to `proposals`. The
  // operator-facing message must include a daemon-restart instruction so
  // they aren't left staring at a raw libsql error.
  it('rewrites `no such table: ideas` into the restart hint', () => {
    const raw = 'SQLITE_ERROR: no such table: ideas'
    const mapped = mapDaemonError(raw)
    expect(mapped).not.toBe(raw)
    expect(mapped).toContain('mars daemon stop')
    expect(mapped).toContain('mars daemon start')
    // Original underlying error is preserved for debugging.
    expect(mapped).toContain(raw)
    // The string the operator looks for: a restart instruction, not a raw
    // SQLite line on its own.
    expect(mapped).not.toMatch(/^SQLITE_ERROR/)
  })

  // Symmetric case: a fresh daemon talking to a yet-to-migrate DB.
  it('rewrites `no such table: proposals` into the restart hint', () => {
    const raw = 'SqliteError: no such table: proposals'
    const mapped = mapDaemonError(raw)
    expect(mapped).toContain('Restart the daemon')
    expect(mapped).toContain(raw)
  })

  it('matches case-insensitively and with arbitrary surrounding context', () => {
    const raw =
      'libsql_client: query failed: SQLITE_ERROR: NO SUCH TABLE: Ideas (statement: SELECT …)'
    expect(mapDaemonError(raw)).toContain('mars daemon stop')
  })

  it('passes unrelated errors through unchanged', () => {
    const raw = 'ENOENT: no such file or directory, open /tmp/foo'
    expect(mapDaemonError(raw)).toBe(raw)
  })

  it('does not match unrelated `no such table: <other>` errors', () => {
    const raw = 'SQLITE_ERROR: no such table: tasks'
    expect(mapDaemonError(raw)).toBe(raw)
  })

  it('handles empty strings without throwing', () => {
    expect(mapDaemonError('')).toBe('')
  })
})

describe('source-stamp guard', () => {
  const setup = (): { path: string; cleanup: () => void } => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-stale-detect-'))
    const path = resolve(dir, 'proposals.ts')
    writeFileSync(path, '// fake proposals.ts\n', 'utf8')
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('captures a stamp with a finite mtime when the source exists', () => {
    const { path, cleanup } = setup()
    try {
      const stamp = captureProposalsStamp(path)
      expect(stamp.path).toBe(path)
      expect(stamp.mtimeMs).not.toBeNull()
      expect(Number.isFinite(stamp.mtimeMs as number)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('returns mtimeMs=null and is a no-op when the source is missing', () => {
    const stamp = captureProposalsStamp('/definitely/not/a/path/proposals.ts')
    expect(stamp.mtimeMs).toBeNull()
    expect(isProposalsSourceNewerThan(stamp)).toBe(false)
    // assertProposalsSourceFresh must not throw — compiled-binary
    // distributions have no source on disk and should fall back to the
    // error-rewrite path silently.
    expect(() => assertProposalsSourceFresh(stamp)).not.toThrow()
  })

  it('detects a newer mtime and the assertion throws with the restart hint', () => {
    const { path, cleanup } = setup()
    try {
      const stamp = captureProposalsStamp(path)
      // Roll the file's mtime forward by 1 minute to simulate the on-disk
      // source being updated after the daemon started.
      const future = ((stamp.mtimeMs as number) + 60_000) / 1000
      utimesSync(path, future, future)

      expect(isProposalsSourceNewerThan(stamp)).toBe(true)
      expect(() => assertProposalsSourceFresh(stamp)).toThrow(STALE_DAEMON_HINT)
    } finally {
      cleanup()
    }
  })

  it('does not trip when the source is unchanged', () => {
    const { path, cleanup } = setup()
    try {
      const stamp = captureProposalsStamp(path)
      expect(isProposalsSourceNewerThan(stamp)).toBe(false)
      expect(() => assertProposalsSourceFresh(stamp)).not.toThrow()
    } finally {
      cleanup()
    }
  })
})
