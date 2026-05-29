/**
 * Regression tests for runTool's ENOENT disambiguation:
 *   - spawn with a missing cwd directory should surface "working directory no
 *     longer exists: <path>" rather than the opaque "spawn git ENOENT".
 *   - spawn with a missing binary (but existing cwd) should surface the original
 *     ENOENT message, NOT the cwd-missing message.
 *
 * Background: Node.js emits the same ENOENT + 'spawn <binary> ENOENT' syscall
 * for both causes. The fix in run-tool.ts checks existsSync(cwd) to tell them
 * apart so a post-mortem can immediately distinguish "deleted worktree" from
 * "git missing from PATH".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runTool, nullTraceStore } from '../run-tool'

describe('runTool — ENOENT source disambiguation', () => {
  // Cross-boundary test: exercises the real spawn + the real existsSync check
  // so the split logic is verified against the actual Node.js spawn behaviour,
  // not just the error-wrapping path.

  it('surfaces "working directory no longer exists" when cwd is absent', async () => {
    // Create then immediately remove a temp dir so we have a path that is
    // structurally valid but does not exist on disk.
    const missingDir = mkdtempSync(resolve(tmpdir(), 'mars-rt-cwd-'))
    rmdirSync(missingDir)

    await expect(
      runTool(
        {
          tool: 'git',
          argv: ['--version'],
          cwd: missingDir,
          taskId: null,
          originId: null,
          phase: null,
        },
        nullTraceStore,
      ),
    ).rejects.toThrow(`working directory no longer exists: ${missingDir}`)
  })

  it('does NOT say "working directory no longer exists" when cwd exists but binary is missing', async () => {
    const existingDir = mkdtempSync(resolve(tmpdir(), 'mars-rt-cwd-'))
    try {
      await expect(
        runTool(
          {
            tool: '/this/binary/does-not-exist-anywhere-on-disk',
            argv: [],
            cwd: existingDir,
            taskId: null,
            originId: null,
            phase: null,
          },
          nullTraceStore,
        ),
      ).rejects.toThrow('ENOENT')

      // Ensure the cwd-missing message was NOT produced — the error is about
      // the binary, not the directory.
      await runTool(
        {
          tool: '/this/binary/does-not-exist-anywhere-on-disk',
          argv: [],
          cwd: existingDir,
          taskId: null,
          originId: null,
          phase: null,
        },
        nullTraceStore,
      ).catch((e: Error) => {
        expect(e.message).not.toContain('working directory no longer exists')
      })
    } finally {
      rmdirSync(existingDir)
    }
  })
})
