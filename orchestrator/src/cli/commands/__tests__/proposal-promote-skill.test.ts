/**
 * Tests for skill-forge proposal promotion.
 *
 * Acceptance criteria:
 * 1. Happy path: skill-forge proposal with valid frontmatter writes SKILL.md
 *    and emits the bundle-refresh hint as the last stdout line.
 * 2. Duplicate abort: SKILL.md already exists at target path → code 1, no overwrite.
 * 3. Non-skill-forge no-op: non-skill-forge proposals route to daemon; no file written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-promote-skill-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const { initProposals } = await import('../../../core/proposals')
  await initProposals()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFake = async (responder?: (req: Record<string, unknown>) => unknown) => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon(responder)
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Shared fixture: a minimal SKILL.md with valid frontmatter
// ---------------------------------------------------------------------------

const SAMPLE_SKILL_MD = `---
name: test-skill-promote
description: A test skill for the promote command
---

# Test Skill Promote

This skill is used only in tests.
`

const skillTargetPath = (repoDir: string, slug: string): string =>
  join(repoDir, 'orchestrator/src/init/templates/claude/skills', slug, 'SKILL.md')

// ---------------------------------------------------------------------------
// 1. Happy path: SKILL.md written, bundle-refresh hint on last stdout line
// ---------------------------------------------------------------------------

describe('proposal promote — skill-forge happy path', () => {
  it('writes SKILL.md and emits the bundle-refresh hint', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake()

    const { createProposal } = await import('../../../core/proposals')
    const p = await createProposal('Skill: test-skill-promote', {
      source: 'skill-forge',
      solution: SAMPLE_SKILL_MD,
    })

    const r = await run(['proposal', 'promote', p.id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)

    // File must exist at the correct template path.
    const target = skillTargetPath(repo, 'test-skill-promote')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(SAMPLE_SKILL_MD)

    // Last stdout line must be the exact bundle-refresh hint.
    const lastLine = r.out[r.out.length - 1]
    expect(lastLine).toBe(
      'next: run `npm run mars:bundle:refresh` from orchestrator/ to bundle the new skill',
    )

    // Daemon must NOT be called for skill-forge proposals.
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Duplicate abort: target already exists → code 1, no overwrite
// ---------------------------------------------------------------------------

describe('proposal promote — skill-forge duplicate abort', () => {
  it('aborts with code 1 when SKILL.md already exists at the target path', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake()

    const { createProposal } = await import('../../../core/proposals')
    const p = await createProposal('Skill: test-skill-promote', {
      source: 'skill-forge',
      solution: SAMPLE_SKILL_MD,
    })

    // Pre-create the target so the abort path fires.
    const target = skillTargetPath(repo, 'test-skill-promote')
    mkdirSync(join(repo, 'orchestrator/src/init/templates/claude/skills', 'test-skill-promote'), {
      recursive: true,
    })
    writeFileSync(target, 'pre-existing content')

    const r = await run(['proposal', 'promote', p.id], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/already exists/)
    // Pre-existing content must NOT be overwritten.
    expect(readFileSync(target, 'utf8')).toBe('pre-existing content')
  })
})

// ---------------------------------------------------------------------------
// 3. Non-skill-forge proposals route to the daemon; no file written
// ---------------------------------------------------------------------------

describe('proposal promote — non-skill-forge routes to daemon', () => {
  it('calls the daemon and writes no files for a human-source proposal', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake((req) => {
      if ((req as { op: string }).op === 'proposal.promote') {
        return { proposalId: (req as { proposalId: string }).proposalId, status: 'prd-ready' }
      }
      return {}
    })

    const { createProposal } = await import('../../../core/proposals')
    const p = await createProposal('Some human-driven proposal', { source: 'human' })

    const r = await run(['proposal', 'promote', p.id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    // Daemon must have been called with proposal.promote.
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { op: string }).op).toBe('proposal.promote')
    expect(fake.calls[0]).toMatchObject({ coordinated: false })
    expect(r.out.join('\n')).toContain('tasks will be enqueued automatically when slicing completes')

    // No skill file should have been written.
    const skillsDir = join(repo, 'orchestrator/src/init/templates/claude/skills')
    expect(existsSync(skillsDir)).toBe(false)
  })

  it('carries coordination when requested', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const fake = await makeFake((req) => ({
      proposalId: (req as { proposalId: string }).proposalId,
      status: 'prd-ready',
    }))
    const { createProposal } = await import('../../../core/proposals')
    const p = await createProposal('Coordinate this plan', { source: 'human' })

    const r = await run(['proposal', 'promote', p.id, '--coordinated'], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(fake.calls[0]).toMatchObject({ coordinated: true })
    expect(r.out.join('\n')).toContain('tasks will be enqueued automatically')
  })
})
