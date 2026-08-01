/**
 * Tests for the lessons injection feature (PRD 6544c0a0, slice 3).
 *
 * Covers:
 *  - composePrompt byte-parity when lessons is empty or omitted
 *  - composePrompt renders <lessons> block correctly when lessons are provided
 *  - fetchLessonsForTask caps results at MARS_MEMORY_TOPK (default 6)
 *  - fetchLessonsForTask deduplicates packets when the same domain appears twice
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composePrompt } from '../shared'
import {
  fetchLessonsForTask,
  insertMemoryPacket,
  resolveTaskDomains,
  __resetMemoryPacketsForTests,
} from '../../../core/store/memory-packet-store'
import { __resetStateClientForTests } from '../../../core/store/state-client'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// composePrompt — lessons rendering (pure, no DB)
// ---------------------------------------------------------------------------

describe('composePrompt — empty lessons byte-parity', () => {
  it('output with lessons=[] is byte-identical to output with lessons omitted', () => {
    const withOmitted = composePrompt('Fix the bug', null, 'coder', null, 'mars-t01', '/tmp/wt')
    const withEmpty = composePrompt('Fix the bug', null, 'coder', null, 'mars-t01', '/tmp/wt', 'task', [])
    expect(withEmpty).toBe(withOmitted)
  })

  it('does not include a <lessons> tag when lessons is empty', () => {
    const out = composePrompt('Fix the bug', null)
    expect(out).not.toContain('<lessons>')
    expect(out).not.toContain('</lessons>')
  })

  it('does not include a <lessons> tag when lessons is omitted', () => {
    const out = composePrompt('Fix the bug', null, 'coder', null, 'mars-t01', '/tmp/wt', 'task')
    expect(out).not.toContain('<lessons>')
  })
})

describe('composePrompt — non-empty lessons rendering', () => {
  it('renders each lesson as a list item inside <lessons>', () => {
    const out = composePrompt(
      'Fix the bug',
      null,
      'coder',
      null,
      'mars-t01',
      '/tmp/wt',
      'task',
      ['Prefer async/await', 'Avoid any type'],
    )
    expect(out).toContain('<lessons>\n  - Prefer async/await\n  - Avoid any type\n</lessons>')
  })

  it('places the <lessons> block BEFORE CODING_DISCIPLINE', () => {
    const out = composePrompt(
      'Fix the bug',
      null,
      'coder',
      null,
      'mars-t01',
      '/tmp/wt',
      'task',
      ['a lesson'],
    )
    const lessonsPos = out.indexOf('<lessons>')
    const disciplinePos = out.indexOf('## Coding discipline')
    expect(lessonsPos).toBeGreaterThan(-1)
    expect(disciplinePos).toBeGreaterThan(-1)
    expect(lessonsPos).toBeLessThan(disciplinePos)
  })

  it('places the <lessons> block AFTER the structured-task spec block', () => {
    const spec = {
      mergeMode: 'auto' as const,
      files: ['src/foo.ts'],
      verifyCmd: 'npm test',
      doneCriteria: ['tests pass'],
      readFirst: [],
      prescriptiveAction: null,
    }
    const out = composePrompt(
      'Fix the bug',
      null,
      'coder',
      spec,
      'mars-t01',
      '/tmp/wt',
      'task',
      ['a lesson'],
    )
    const specPos = out.indexOf('<task_id>mars-t01</task_id>')
    const lessonsPos = out.indexOf('<lessons>')
    expect(specPos).toBeGreaterThan(-1)
    expect(lessonsPos).toBeGreaterThan(-1)
    expect(lessonsPos).toBeGreaterThan(specPos)
  })
})

// ---------------------------------------------------------------------------
// resolveTaskDomains — pure helper
// ---------------------------------------------------------------------------

describe('resolveTaskDomains', () => {
  it('returns [workflow, ...tags] filtering out null workflow', () => {
    expect(resolveTaskDomains({ workflow: null, tags: ['coder', 'orchestrator'] })).toEqual([
      'coder',
      'orchestrator',
    ])
  })

  it('includes workflow when present', () => {
    expect(resolveTaskDomains({ workflow: 'implement', tags: ['coder'] })).toEqual([
      'implement',
      'coder',
    ])
  })

  it('filters out empty-string tags', () => {
    expect(resolveTaskDomains({ workflow: null, tags: ['', 'foo', ''] })).toEqual(['foo'])
  })
})

// ---------------------------------------------------------------------------
// fetchLessonsForTask — real temp DB tests
// ---------------------------------------------------------------------------

describe('fetchLessonsForTask — cap and dedupe', () => {
  let repoDir: string
  const savedTopk = process.env.MARS_MEMORY_TOPK
  const savedSalience = process.env.MARS_MEMORY_SALIENCE

  beforeEach(() => {
    repoDir = mkdtempSync(resolve(tmpdir(), 'mars-lessons-test-'))
    mkdirSync(resolve(repoDir, '.mars'))
    process.env.MARS_REPO = repoDir
    delete process.env.MARS_MEMORY_TOPK
    delete process.env.MARS_MEMORY_SALIENCE
    __resetContextCacheForTests()
    __resetStateClientForTests()
    __resetMemoryPacketsForTests()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    if (savedTopk !== undefined) process.env.MARS_MEMORY_TOPK = savedTopk
    else delete process.env.MARS_MEMORY_TOPK
    if (savedSalience !== undefined) process.env.MARS_MEMORY_SALIENCE = savedSalience
    else delete process.env.MARS_MEMORY_SALIENCE
    __resetContextCacheForTests()
    __resetStateClientForTests()
    __resetMemoryPacketsForTests()
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('returns at most 6 lessons by default when more than 6 packets qualify', async () => {
    for (let i = 0; i < 9; i++) {
      await insertMemoryPacket({ domain: 'orchestrator', text: `lesson-${i}`, salience: 0.9 })
    }
    const texts = await fetchLessonsForTask(['orchestrator'])
    expect(texts).toHaveLength(6)
  })

  it('respects MARS_MEMORY_TOPK env override', async () => {
    for (let i = 0; i < 5; i++) {
      await insertMemoryPacket({ domain: 'orchestrator', text: `lesson-${i}`, salience: 0.9 })
    }
    process.env.MARS_MEMORY_TOPK = '3'
    const texts = await fetchLessonsForTask(['orchestrator'])
    expect(texts).toHaveLength(3)
  })

  it('does not return packets below MARS_MEMORY_SALIENCE threshold (default 0.7)', async () => {
    await insertMemoryPacket({ domain: 'orchestrator', text: 'low-salience', salience: 0.5 })
    await insertMemoryPacket({ domain: 'orchestrator', text: 'high-salience', salience: 0.8 })
    const texts = await fetchLessonsForTask(['orchestrator'])
    expect(texts).toContain('high-salience')
    expect(texts).not.toContain('low-salience')
  })

  it('deduplicates packets when the same domain appears twice in the domain list', async () => {
    await insertMemoryPacket({ domain: 'foo', text: 'lesson-A', salience: 0.9 })
    await insertMemoryPacket({ domain: 'foo', text: 'lesson-B', salience: 0.8 })
    // Simulates workflow === tags[0], e.g. resolveTaskDomains returns ['foo', 'foo', 'bar']
    const texts = await fetchLessonsForTask(['foo', 'foo'])
    expect(texts).toHaveLength(2)
    expect(texts).toContain('lesson-A')
    expect(texts).toContain('lesson-B')
  })

  it('collects lessons across multiple distinct domains', async () => {
    await insertMemoryPacket({ domain: 'domain-a', text: 'from-a', salience: 0.8 })
    await insertMemoryPacket({ domain: 'domain-b', text: 'from-b', salience: 0.8 })
    const texts = await fetchLessonsForTask(['domain-a', 'domain-b'])
    expect(texts).toContain('from-a')
    expect(texts).toContain('from-b')
  })

  it('returns [] for empty domains', async () => {
    const texts = await fetchLessonsForTask([])
    expect(texts).toHaveLength(0)
  })
})
