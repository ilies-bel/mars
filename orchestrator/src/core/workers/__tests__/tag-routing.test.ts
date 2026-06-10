// Integration tests for tag-based Worker routing.
// Verifies that pickWorkerForTags correctly dispatches to a codex/pty Worker
// when the task tag matches, and falls back to the built-in headless Coder
// when no tag matches.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pickWorkerForTags } from '..'
import {
  addWorkerToRegistry,
  listMergedWorkers,
  type WorkerDeclaration,
} from '../persisted-registry'

const CODEX_DECL: WorkerDeclaration = {
  name: 'CodexCoder',
  model: 'claude-sonnet-4-6',
  effort: 'high',
  permissionMode: 'default',
  bare: false,
  disallowedTools: [],
  outputFormat: 'stream-json',
  runtime: 'pty',
  provider: 'codex',
  tags: ['codex'],
}

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(resolve(tmpdir(), 'mars-tag-routing-test-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('pickWorkerForTags — tag-based routing contract', () => {
  it('routes a task tagged "codex" to the codex pty Worker', () => {
    addWorkerToRegistry(stateDir, CODEX_DECL)
    const workers = listMergedWorkers(stateDir)
    const merged = Object.fromEntries(workers.map((w) => [w.config.name, w]))
    const picked = pickWorkerForTags(['codex'], merged)
    expect(picked.config.provider).toBe('codex')
  })

  it('falls back to the built-in headless Coder when no tags are given', () => {
    addWorkerToRegistry(stateDir, CODEX_DECL)
    const workers = listMergedWorkers(stateDir)
    const merged = Object.fromEntries(workers.map((w) => [w.config.name, w]))
    const picked = pickWorkerForTags([], merged)
    expect(picked).toBe(merged['Coder'])
  })

  it('falls back to headless runtime when tag does not match any Worker', () => {
    addWorkerToRegistry(stateDir, CODEX_DECL)
    const workers = listMergedWorkers(stateDir)
    const merged = Object.fromEntries(workers.map((w) => [w.config.name, w]))
    const picked = pickWorkerForTags(['unknown-tag'], merged)
    expect(picked.config.runtime).toBe('headless')
  })
})
