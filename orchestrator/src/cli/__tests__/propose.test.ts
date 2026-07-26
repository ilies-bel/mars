/**
 * Tests for `mars propose <verb> [args...]`.
 *
 * The command is a pure stdout emitter — no DB, no daemon, no worktree writes.
 * Tests spawn the real CLI entry point to exercise the end-to-end path
 * (routing → command → output → exit code).
 */

import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (
  args: readonly string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

// ── Happy path ─────────────────────────────────────────────────────────────

describe('mars propose <valid-verb>', () => {
  it('exits 0 and prints a single-line JSON envelope for "purge"', () => {
    const result = runCli(['propose', 'purge', 'mars-abc1'])
    expect(result.status).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0]!)
    expect(envelope.kind).toBe('mars-propose')
    expect(envelope.verb).toBe('purge')
    expect(envelope.args).toEqual(['mars-abc1'])
    expect(typeof envelope.proposalId).toBe('string')
    expect(envelope.proposalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('includes all positional args after the verb', () => {
    const result = runCli(['propose', 'dismiss', 'score-1', 'score-2'])
    expect(result.status).toBe(0)
    const envelope = JSON.parse(result.stdout.trim())
    expect(envelope.verb).toBe('dismiss')
    expect(envelope.args).toEqual(['score-1', 'score-2'])
  })

  it('args is an empty array when no extra positionals are given', () => {
    const result = runCli(['propose', 'reject', 'prop-99'])
    expect(result.status).toBe(0)
    const envelope = JSON.parse(result.stdout.trim())
    expect(envelope.verb).toBe('reject')
    expect(envelope.args).toEqual(['prop-99'])
  })

  it('generates a distinct proposalId on each invocation', () => {
    const a = JSON.parse(runCli(['propose', 'purge']).stdout.trim())
    const b = JSON.parse(runCli(['propose', 'purge']).stdout.trim())
    expect(a.proposalId).not.toBe(b.proposalId)
  })

  it('accepts prune-worktree as a valid verb', () => {
    const result = runCli(['propose', 'prune-worktree'])
    expect(result.status).toBe(0)
    const envelope = JSON.parse(result.stdout.trim())
    expect(envelope.verb).toBe('prune-worktree')
  })
})

// ── Invalid verb ───────────────────────────────────────────────────────────

describe('mars propose <invalid-verb>', () => {
  it('exits 2 and prints an error to stderr for an unknown verb', () => {
    const result = runCli(['propose', 'delete-everything'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/unknown verb|delete-everything/i)
    expect(result.stdout.trim()).toBe('')
  })

  it('exits 2 for a safe verb (not in DESTRUCTIVE_MARS_VERBS)', () => {
    // 'restart' is SAFE, not destructive — propose should reject it
    const result = runCli(['propose', 'restart', 'mars-123'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/unknown verb|restart/i)
  })

  it('exits 2 when no verb is given', () => {
    const result = runCli(['propose'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/usage|verb/i)
  })
})

// ── Help ───────────────────────────────────────────────────────────────────

describe('mars propose --help', () => {
  it('exits 0 and documents the command', () => {
    const result = runCli(['propose', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/mars propose/i)
  })

  it('--help output lists acceptable verbs', () => {
    const result = runCli(['propose', '--help'])
    expect(result.status).toBe(0)
    // At minimum, 'purge' must appear (it's a canonical destructive verb)
    expect(result.stdout).toMatch(/purge/i)
    expect(result.stdout).toMatch(/dismiss/i)
  })
})

// ── No side effects ────────────────────────────────────────────────────────

describe('mars propose — no side effects', () => {
  it('writes nothing to stderr for a valid verb', () => {
    const result = runCli(['propose', 'purge', 'mars-abc1'])
    expect(result.stderr.trim()).toBe('')
  })
})
