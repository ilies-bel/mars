/**
 * Tests for `mars adr supersede`, `mars adr list` (with status), and the
 * group help string (slice mars-f53759f5).
 *
 * Covers:
 *   1. `adr supersede` dispatches the correct daemon request.
 *   2. `adr supersede` validates both arguments.
 *   3. `adr list` appends `[superseded → NNNN]` for superseded ADRs.
 *   4. `adr list` shows no suffix for non-superseded ADRs.
 *   5. `adr --help` / bare `mars adr` show the new verb in the usage line.
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon
 * and a temp filesystem for list-related tests.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakeDaemon, runCommandInProcess } from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

// Minimal in-memory store stub — adr commands don't touch the store.
const noopStore = {} as unknown as DomainTaskStore

let repoRoot = ''

beforeEach(async () => {
  repoRoot = await mkdtemp(resolve(tmpdir(), 'mars-adr-cli-test-'))
})

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true })
})

const makeCtx = (): OrchestratorContext =>
  ({ repoRoot }) as unknown as OrchestratorContext

describe('mars adr supersede', () => {
  it('dispatches adr-supersede with padded numbers to the daemon', async () => {
    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr', 'supersede', '84', '91'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })
    expect(result.code).toBe(0)
    expect(result.out[0]).toContain('0084')
    expect(result.out[0]).toContain('0091')
    expect(daemon.calls).toHaveLength(1)
    const req = daemon.calls[0]
    expect(req).toMatchObject({ op: 'adr-supersede', oldNumber: '0084', newNumber: '0091' })
  })

  it('accepts already-padded numbers', async () => {
    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr', 'supersede', '0084', '0091'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })
    expect(result.code).toBe(0)
    expect(daemon.calls[0]).toMatchObject({ op: 'adr-supersede', oldNumber: '0084', newNumber: '0091' })
  })

  it('returns code 2 when arguments are missing', async () => {
    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr', 'supersede', '0084'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })
    expect(result.code).toBe(2)
    expect(daemon.calls).toHaveLength(0)
  })

  it('returns code 2 when arguments are non-numeric', async () => {
    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr', 'supersede', 'abc', 'def'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })
    expect(result.code).toBe(2)
    expect(daemon.calls).toHaveLength(0)
  })
})

describe('mars adr list (status rendering)', () => {
  it('appends [superseded → NNNN] for superseded ADRs', async () => {
    const adrDir = resolve(repoRoot, 'docs/knowledge/decisions')
    await mkdir(adrDir, { recursive: true })
    await writeFile(
      resolve(adrDir, '0084-a-subject-closes.md'),
      '# A Subject closes\n\n## Status\n\nSuperseded by 0091\n\nBody.\n',
    )
    await writeFile(
      resolve(adrDir, '0091-a-subject-can-never-open.md'),
      '# A Subject can never open or close itself\n\nBody.\n',
    )

    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr', 'list'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })

    expect(result.code).toBe(0)
    const supersededLine = result.out.find((l) => l.startsWith('0084-'))
    const activeLine = result.out.find((l) => l.startsWith('0091-'))
    expect(supersededLine).toContain('[superseded → 0091]')
    expect(activeLine).not.toContain('[superseded')
  })

  it('shows no status suffix for ADRs without a Status section', async () => {
    const adrDir = resolve(repoRoot, 'docs/knowledge/decisions')
    await mkdir(adrDir, { recursive: true })
    await writeFile(
      resolve(adrDir, '0001-first.md'),
      '# First decision\n\nBody.\n',
    )

    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr', 'list'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })

    expect(result.code).toBe(0)
    expect(result.out[0]).not.toContain('[superseded')
  })
})

describe('mars adr (group help)', () => {
  it('usage line includes supersede', async () => {
    const daemon = makeFakeDaemon()
    const result = await runCommandInProcess(['adr'], {
      store: noopStore,
      daemon,
      ctx: makeCtx(),
    })
    // Group command emits usage on stderr and returns code 2
    expect(result.code).toBe(2)
    expect(result.err.join(' ')).toContain('supersede')
  })
})
