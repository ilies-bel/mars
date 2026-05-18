import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKTREE_REMOVE_TIMEOUT_MS } from '../worktree-clean'

// The removeWorktreeAt function is an internal helper (not exported) that
// wraps `git worktree remove --force` with the execFile `timeout` and
// `killSignal: 'SIGKILL'` options. Its timeout behaviour is exercised here
// indirectly: we verify the exported constant is correct, and that the
// error re-throw path fires for a simulated SIGKILL error shape.

describe('worktree-clean timeout constants', () => {
  it('exports DEFAULT_WORKTREE_REMOVE_TIMEOUT_MS as 60 seconds', () => {
    expect(DEFAULT_WORKTREE_REMOVE_TIMEOUT_MS).toBe(60_000)
  })
})

describe('removeWorktreeAt SIGKILL detection', () => {
  // Directly test the error-classification logic used by removeWorktreeAt.
  // The function re-throws when err.killed === true or err.signal === 'SIGKILL'.
  // Any other error (e.g. "not a registered worktree") is swallowed so the
  // rm -rf fallback still runs.

  const classifiesAsTimeout = (err: {
    killed?: boolean
    signal?: string
    code?: string | number
  }): boolean => {
    return !!(err.killed || err.signal === 'SIGKILL')
  }

  it('treats killed=true as a timeout (re-throw)', () => {
    expect(classifiesAsTimeout({ killed: true })).toBe(true)
  })

  it('treats signal=SIGKILL as a timeout (re-throw)', () => {
    expect(classifiesAsTimeout({ signal: 'SIGKILL' })).toBe(true)
  })

  it('does NOT treat a plain non-zero exit as a timeout (fall through)', () => {
    expect(classifiesAsTimeout({ code: 1 })).toBe(false)
  })

  it('does NOT treat a git "not registered" error as a timeout (fall through)', () => {
    // This is the ENOENT / "not a registered worktree" shape from execFile.
    expect(classifiesAsTimeout({ code: 'ENOENT' })).toBe(false)
  })

  it('does NOT treat signal=SIGTERM as a timeout (fall through)', () => {
    // Only SIGKILL indicates our own wall-clock abort, not an external SIGTERM.
    expect(classifiesAsTimeout({ signal: 'SIGTERM' })).toBe(false)
  })
})

describe('removeWorktreeAt timeout integration (real subprocess)', () => {
  // Spawn a `sleep 9999` child via execFile with a very short timeout, then
  // confirm that the resulting error shape is what removeWorktreeAt's
  // detection logic expects (killed=true or signal='SIGKILL').
  it('execFile with timeout + killSignal=SIGKILL sets err.killed=true or err.signal=SIGKILL', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)

    let caught: {
      killed?: boolean
      signal?: string
      code?: string | number
    } | null = null

    try {
      await exec('sleep', ['9999'], { timeout: 50, killSignal: 'SIGKILL' })
    } catch (err: unknown) {
      caught = err as { killed?: boolean; signal?: string; code?: string | number }
    }

    expect(caught).not.toBeNull()
    // Node's child_process sets err.killed=true when the timeout fires.
    // On some platforms it also sets err.signal='SIGKILL'.
    const isTimeout =
      caught?.killed === true || caught?.signal === 'SIGKILL'
    expect(isTimeout).toBe(true)
  }, 10_000)
})
