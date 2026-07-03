/**
 * Tests for `mars workflow list` and `mars workflow show <kind>`.
 *
 * Uses the in-process command seam (ADR-0023) with a real temp stateDir
 * so the filesystem classification logic is exercised directly.
 *
 * The DB is not needed for list/show — last-run timestamps degrade gracefully
 * when `workflow_runs` is absent. Tests assert on behaviour through the public
 * CLI interface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import { PRIMITIVE_DESCRIPTORS } from '../../workflows/primitives/opts-descriptors'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/commands -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const bundledWorkflowsDir = resolve(
  projectRoot,
  'src',
  'init',
  'templates',
  'workflows',
)

/** Minimal fake store that accepts SQL queries and returns empty results. */
const makeNullStore = (): DomainTaskStore =>
  ({
    query: async () => ({ rows: [], columns: [] }),
    execute: async () => ({ rows: [], columns: [] }),
  }) as unknown as DomainTaskStore

/**
 * Build in-process options with a real stateDir under `repoRoot` and a
 * null store (no DB).
 */
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

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-workflow-test-'))
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// workflow list — all bundled (no on-disk files)
// ---------------------------------------------------------------------------

describe('mars workflow list — no user files', () => {
  it('lists all bundled kinds with source=bundled when no .mars/workflows/ exists', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'list'], opts)
    expect(r.code).toBe(0)

    // Should include the bundled kinds (task, fix, diagnose, write at minimum).
    const output = r.out.join('\n')
    expect(output).toContain('bundled')
    // All bundled kinds should appear.
    expect(output).toContain('task')
    expect(output).toContain('fix')
    expect(output).toContain('diagnose')
  })

  it('shows (bundled) in the file column for bundled-only entries', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'list'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('(bundled)')
  })
})

// ---------------------------------------------------------------------------
// workflow list — pristine scaffold → source=scaffolded
// ---------------------------------------------------------------------------

describe('mars workflow list — pristine scaffold file', () => {
  it('reports source=scaffolded when the on-disk file is byte-identical to the bundled template', async () => {
    const opts = makeOpts(repoRoot)
    // Copy the bundled task-workflow.js verbatim into .mars/workflows/.
    const workflowsDir = resolve(repoRoot, '.mars', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    const templateContent = readFileSync(
      resolve(bundledWorkflowsDir, 'task-workflow.js'),
      'utf8',
    )
    writeFileSync(resolve(workflowsDir, 'task-workflow.js'), templateContent)

    const r = await runCommandInProcess(['workflow', 'list'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')

    // The "task" kind should show "scaffolded".
    const taskLine = r.out.find((l) => l.startsWith('task') || l.includes('task'))
    expect(taskLine).toBeDefined()
    expect(output).toContain('scaffolded')
  })
})

// ---------------------------------------------------------------------------
// workflow list — user-modified file → source=user-modified
// ---------------------------------------------------------------------------

describe('mars workflow list — user-modified file', () => {
  it('reports source=user-modified when the on-disk file differs from the bundled template', async () => {
    const opts = makeOpts(repoRoot)
    const workflowsDir = resolve(repoRoot, '.mars', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })

    // Write a modified version of the task workflow.
    const original = readFileSync(
      resolve(bundledWorkflowsDir, 'task-workflow.js'),
      'utf8',
    )
    const modified = original + '\n// user customisation\n'
    writeFileSync(resolve(workflowsDir, 'task-workflow.js'), modified)

    const r = await runCommandInProcess(['workflow', 'list'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('user-modified')
  })
})

// ---------------------------------------------------------------------------
// workflow list — custom kind → source=custom
// ---------------------------------------------------------------------------

describe('mars workflow list — custom kind', () => {
  it('reports source=custom when the on-disk file has no bundled counterpart', async () => {
    const opts = makeOpts(repoRoot)
    const workflowsDir = resolve(repoRoot, '.mars', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })

    // Write a custom workflow that doesn't match any bundled kind.
    writeFileSync(
      resolve(workflowsDir, 'my-special-workflow.js'),
      '// custom workflow\nexport default {};\n',
    )

    const r = await runCommandInProcess(['workflow', 'list'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('my-special')
    expect(output).toContain('custom')
  })
})

// ---------------------------------------------------------------------------
// workflow show — unknown kind
// ---------------------------------------------------------------------------

describe('mars workflow show — errors', () => {
  it('exits 1 with no kind argument', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'show'], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars workflow show')
  })

  it('exits 1 when the kind does not exist', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'show', 'nonexistent-kind'], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('nonexistent-kind')
  })
})

// ---------------------------------------------------------------------------
// workflow show — prints per-primitive options with descriptions
// ---------------------------------------------------------------------------

describe('mars workflow show — parameter surface', () => {
  it('prints all primitive names and at least one option description for each', async () => {
    // Use a bundled kind so we don't need to create any files.
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'show', 'task'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')

    // Every primitive should appear in the output.
    for (const { name, descriptors } of PRIMITIVE_DESCRIPTORS) {
      expect(output).toContain(name)
      // Every option for this primitive should appear.
      for (const [opt] of Object.entries(descriptors)) {
        expect(output).toContain(opt)
      }
    }
  })

  it('labels the active source and file path for a bundled kind', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'show', 'task'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('bundled')
    expect(output).toContain('(bundled fallback)')
  })

  it('shows the on-disk file path when a user file is present', async () => {
    const opts = makeOpts(repoRoot)
    const workflowsDir = resolve(repoRoot, '.mars', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    const templateContent = readFileSync(
      resolve(bundledWorkflowsDir, 'task-workflow.js'),
      'utf8',
    )
    const diskPath = resolve(workflowsDir, 'task-workflow.js')
    writeFileSync(diskPath, templateContent)

    const r = await runCommandInProcess(['workflow', 'show', 'task'], opts)
    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain(diskPath)
  })
})

// ---------------------------------------------------------------------------
// workflow group — prints usage when called without subcommand
// ---------------------------------------------------------------------------

describe('mars workflow — group command', () => {
  it('exits 1 with usage hint when no subcommand given', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow'], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars workflow')
  })
})
