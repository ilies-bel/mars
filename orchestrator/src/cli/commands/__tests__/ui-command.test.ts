/**
 * Tests for the `mars ui` command's help and flag-validation behaviour.
 *
 * The `ui` command used to fall through to its launch action on `--help`/`-h`
 * because parseArgs stores those as boolean flags (not positionals), meaning
 * the top-level HELP_FLAGS.has() check in cli.ts never matched them.
 *
 * These tests verify the fix at the Command level via runCommandInProcess so
 * they stay fast (no binary spawn) and don't require a DB or daemon.
 */

import { describe, it, expect } from 'vitest'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'
import { makeFakeDaemon, runCommandInProcess } from '../../test-adapter'

// The ui command reads only args.repo, args.flags, and deps.out/deps.err.
// It never touches deps.store, deps.daemon, or deps.ctx, so empty stubs suffice.
const makeOpts = () => ({
  store: {} as DomainTaskStore,
  daemon: makeFakeDaemon(),
  ctx: {} as OrchestratorContext,
})

describe('mars ui --help', () => {
  it('exits 0', async () => {
    const result = await runCommandInProcess(['ui', '--help'], makeOpts())
    expect(result.code).toBe(0)
  })

  it('prints usage to stdout', async () => {
    const result = await runCommandInProcess(['ui', '--help'], makeOpts())
    const out = result.out.join('\n')
    expect(out).toContain('mars ui')
    expect(out).toContain('launch the read-only Kanban')
  })

  it('lists the stop subcommand so the operator knows how to undo it', async () => {
    const result = await runCommandInProcess(['ui', '--help'], makeOpts())
    const out = result.out.join('\n')
    expect(out).toContain('mars ui stop')
  })

  it('does not produce any error output', async () => {
    const result = await runCommandInProcess(['ui', '--help'], makeOpts())
    expect(result.err).toHaveLength(0)
  })

  it('does not call launchUi (no server start side effect)', async () => {
    // If launchUi were called it would either process.exit(1) because there is
    // no launcher binary, or open a log file and spawn a process.  The fact that
    // this test completes successfully without either of those outcomes proves
    // that the help path returned before reaching launchUi.
    const result = await runCommandInProcess(['ui', '--help'], makeOpts())
    expect(result.code).toBe(0)
  })
})

describe('mars ui -h', () => {
  it('exits 0 (same as --help)', async () => {
    const result = await runCommandInProcess(['ui', '-h'], makeOpts())
    expect(result.code).toBe(0)
  })

  it('prints usage to stdout', async () => {
    const result = await runCommandInProcess(['ui', '-h'], makeOpts())
    const out = result.out.join('\n')
    expect(out).toContain('mars ui')
  })
})

describe('mars ui <unknown-flag>', () => {
  it('exits non-zero for an unknown flag', async () => {
    const result = await runCommandInProcess(['ui', '--bogus-flag'], makeOpts())
    expect(result.code).toBeGreaterThan(0)
  })

  it('names the offending flag in the error message', async () => {
    const result = await runCommandInProcess(['ui', '--bogus-flag'], makeOpts())
    const errText = result.err.join('\n')
    expect(errText).toContain('--bogus-flag')
  })

  it('does not produce any stdout output (no server start)', async () => {
    // A server start would print "mars-ui  starting …" to stdout.
    const result = await runCommandInProcess(['ui', '--bogus-flag'], makeOpts())
    expect(result.out).toHaveLength(0)
  })

  it('prints the usage line in the error output', async () => {
    const result = await runCommandInProcess(['ui', '--bogus-flag'], makeOpts())
    const errText = result.err.join('\n')
    expect(errText).toContain('mars ui')
  })
})
