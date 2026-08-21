/**
 * Tests for the supersede salvage-tip briefing and its companion
 * classification helper, against a REAL git repository.
 *
 * Context: `mars task add --supersede <id>` inherits the superseded task's
 * branch verbatim. When that branch's tip is itself an orchestrator-authored
 * salvage checkpoint (a coder was killed mid-run with uncommitted changes —
 * see `checkpoint.ts`'s `SALVAGE_CHECKPOINT_TRAILER_KEY`), a coder dispatched
 * onto it otherwise has no signal that the commit it's looking at is a "do
 * not merge as-is" auto-commit rather than real progress. Three such tasks
 * died of context exhaustion / SIGTERM without ever landing a real commit on
 * top, so the merge step refused every one of them with an identical
 * `merge:salvage-checkpoint-tip` signature and tripped the signature-storm
 * breaker (see the incident writeup that spawned this task).
 *
 * `buildSupersedeSalvageTipBrief` is the fix for the first half (brief the
 * coder up front); `hasRealCommitAboveBase` is the fix for the second half
 * (let the merge step tell "some coder made real progress, a later attempt
 * still died" apart from "this branch has NEVER held real work").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  buildSupersedeSalvageTipBrief,
  hasRealCommitAboveBase,
  isSalvageCheckpointCommit,
  SALVAGE_CHECKPOINT_SUBJECT_PREFIX,
  SALVAGE_CHECKPOINT_TRAILER_KEY,
  SALVAGE_CHECKPOINT_TRAILER_VALUE,
} from '../checkpoint'

let repo: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-salvage-tip-brief-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@mars.local')
  git(dir, 'config', 'user.name', 'Mars Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(resolve(dir, 'README.md'), 'hi\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

let commitCounter = 0

/** Commit an arbitrary real file change on whatever branch is checked out. */
const commitChange = (dir: string, message: string): string => {
  commitCounter += 1
  writeFileSync(resolve(dir, `file-${commitCounter}.txt`), `content ${commitCounter}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** The exact commit-message shape coder-exit.ts writes for a salvage checkpoint. */
const salvageCheckpointMessage = (): string =>
  `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} coder killed (exit 143) with 1 uncommitted path(s) — do not merge as-is\n\n${SALVAGE_CHECKPOINT_TRAILER_KEY}: ${SALVAGE_CHECKPOINT_TRAILER_VALUE}`

const commitSalvageCheckpoint = (dir: string): string => {
  git(dir, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
  return git(dir, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('buildSupersedeSalvageTipBrief', () => {
  it('names the task id in the blocked-follow-up instruction', () => {
    const brief = buildSupersedeSalvageTipBrief('mars-abc12345')
    expect(brief).toContain('mars task add --blocked-by mars-abc12345')
  })

  it('tells the coder to inspect first, land real work early, and commit in small increments', () => {
    const brief = buildSupersedeSalvageTipBrief('mars-abc12345')
    expect(brief).toContain('git log -p -1')
    expect(brief).toContain('Finish the real work and land it as a genuine commit')
    expect(brief).toContain('Commit in small increments')
  })

  it('names the salvage-checkpoint subject prefix so the coder can recognize the commit', () => {
    const brief = buildSupersedeSalvageTipBrief('mars-abc12345')
    expect(brief).toContain(SALVAGE_CHECKPOINT_SUBJECT_PREFIX)
  })
})

describe('hasRealCommitAboveBase', () => {
  it('returns false when every commit above the base is itself a salvage checkpoint', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD')
    const tipSha = commitSalvageCheckpoint(repo)

    expect(await isSalvageCheckpointCommit(repo, tipSha)).toBe(true)
    expect(await hasRealCommitAboveBase(repo, baseSha, tipSha)).toBe(false)
  })

  it('returns true when a real (non-checkpoint) commit exists below a checkpoint tip', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD')
    commitChange(repo, 'feat: real work before the coder died')
    const tipSha = commitSalvageCheckpoint(repo)

    expect(await hasRealCommitAboveBase(repo, baseSha, tipSha)).toBe(true)
  })

  it('returns true when the tip itself is a real commit (no checkpoint involved)', async () => {
    const baseSha = git(repo, 'rev-parse', 'HEAD')
    const tipSha = commitChange(repo, 'feat: ordinary work')

    expect(await hasRealCommitAboveBase(repo, baseSha, tipSha)).toBe(true)
  })

  it('returns true (fails open) when base or tip cannot be resolved', async () => {
    const tipSha = commitSalvageCheckpoint(repo)
    expect(await hasRealCommitAboveBase(repo, 'not-a-real-sha', tipSha)).toBe(true)
  })

  it('spans multiple supersede inheritances: a real commit anywhere in the range counts', async () => {
    // Simulates a branch that went through two `--supersede` hops: real work,
    // then a checkpoint, then ANOTHER checkpoint from a second dead attempt.
    const baseSha = git(repo, 'rev-parse', 'HEAD')
    commitChange(repo, 'feat: first attempt landed real work')
    commitSalvageCheckpoint(repo)
    const tipSha = commitSalvageCheckpoint(repo)

    expect(await hasRealCommitAboveBase(repo, baseSha, tipSha)).toBe(true)
  })
})
