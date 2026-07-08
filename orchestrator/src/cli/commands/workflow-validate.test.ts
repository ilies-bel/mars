/**
 * Tests for `mars workflow validate <kind>  [--file <path>]`.
 *
 * The command is a sanity-check against the SAME loader (`loadWorkflowByName`)
 * that the daemon uses at dispatch time. All four paths are exercised:
 *
 *   1. OK (kind-based) — well-formed file → exit 0, output `ok: <path>`
 *   2. Missing file    — exit 1, exact `loadWorkflowByName` error message
 *   3. Malformed export — exit 1, field-level error message
 *   4. --file <path>   — validates an arbitrary file, bypassing path derivation
 *
 * Tests use the in-process command seam (ADR-0023) with real temp directories
 * so the file-system checks in the loader are exercised directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake store — no DB needed for validate. */
const makeNullStore = (): DomainTaskStore =>
  ({
    query: async () => ({ rows: [], columns: [] }),
    execute: async () => ({ rows: [], columns: [] }),
  }) as unknown as DomainTaskStore

const makeOpts = (repoRoot: string): InProcessOptions => {
  const stateDir = resolve(repoRoot, '.mars')
  mkdirSync(stateDir, { recursive: true })
  const ctx: OrchestratorContext = {
    repoRoot,
    stateDir,
  } as OrchestratorContext
  return {
    store: makeNullStore(),
    daemon: makeFakeDaemon(),
    ctx,
  }
}

/** Write a workflow JS file under `.mars/workflows/<name>-workflow.js`. */
const writeWorkflow = (repoRoot: string, name: string, content: string): string => {
  const dir = resolve(repoRoot, '.mars', 'workflows')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${name}-workflow.js`)
  writeFileSync(path, content)
  return path
}

/** A minimal valid workflow default export. */
const VALID_WF_SOURCE = `export default { id: 'valid', fn: async function() { return {} } }\n`

/** A malformed default export — id is present but fn is missing. */
const MALFORMED_WF_SOURCE = `export default { id: 'broken' }\n`

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-validate-test-'))
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. OK path (kind-based)
// ---------------------------------------------------------------------------

describe('mars workflow validate <kind> — OK path', () => {
  it('exits 0 and prints ok: <path> for a well-formed file', async () => {
    const diskPath = writeWorkflow(repoRoot, 'myflow', VALID_WF_SOURCE)
    const opts = makeOpts(repoRoot)

    const r = await runCommandInProcess(['workflow', 'validate', 'myflow'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`ok: ${diskPath}`)
    expect(r.err).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Missing file (kind-based)
// ---------------------------------------------------------------------------

describe('mars workflow validate <kind> — missing file', () => {
  it('exits 1 with the exact loadWorkflowByName error when no file exists', async () => {
    const opts = makeOpts(repoRoot)

    const r = await runCommandInProcess(['workflow', 'validate', 'ghost'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain("no workflow file for 'ghost'")
    // The loader message also names the remedy — make sure it's forwarded.
    expect(r.err.join('\n')).toContain('No fallback pipeline')
  })
})

// ---------------------------------------------------------------------------
// 3. Malformed default export
// ---------------------------------------------------------------------------

describe('mars workflow validate <kind> — malformed export', () => {
  it('exits 1 with a field-level error when the default export has the wrong shape', async () => {
    writeWorkflow(repoRoot, 'bad', MALFORMED_WF_SOURCE)
    const opts = makeOpts(repoRoot)

    const r = await runCommandInProcess(['workflow', 'validate', 'bad'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('must default-export a workflow object')
    expect(r.err.join('\n')).toContain('{ id: string, fn: function }')
  })
})

// ---------------------------------------------------------------------------
// 4. --file <path> (arbitrary file path)
// ---------------------------------------------------------------------------

describe('mars workflow validate --file <path>', () => {
  it('exits 0 and prints ok: <path> for a well-formed file at an arbitrary path', async () => {
    // Write the file OUTSIDE .mars/workflows/ to prove path-derivation is skipped.
    const dir = resolve(repoRoot, 'custom')
    mkdirSync(dir, { recursive: true })
    const filePath = resolve(dir, 'my-custom.js')
    writeFileSync(filePath, VALID_WF_SOURCE)

    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(
      ['workflow', 'validate', '--file', filePath],
      opts,
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`ok: ${filePath}`)
    expect(r.err).toHaveLength(0)
  })

  it('exits 1 when the --file path does not exist', async () => {
    const opts = makeOpts(repoRoot)
    const missingPath = resolve(repoRoot, 'no-such-file.js')

    const r = await runCommandInProcess(
      ['workflow', 'validate', '--file', missingPath],
      opts,
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no workflow file at')
  })

  it('exits 1 when the --file path points to a malformed export', async () => {
    const dir = resolve(repoRoot, 'custom')
    mkdirSync(dir, { recursive: true })
    const filePath = resolve(dir, 'bad.js')
    writeFileSync(filePath, MALFORMED_WF_SOURCE)

    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(
      ['workflow', 'validate', '--file', filePath],
      opts,
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('must default-export a workflow object')
  })
})
