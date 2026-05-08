import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adrDirIn, nextAdrNumber, slugify, writeAdrInWorktree } from '../adr'

let workRoot = ''

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), 'mars-adr-test-'))
})

afterEach(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true })
})

describe('adr slugify', () => {
  it('lowercases and dash-joins, drops punctuation', () => {
    expect(slugify('Use Postgres for the Write Model')).toBe(
      'use-postgres-for-the-write-model',
    )
    expect(slugify('Event-Sourced Orders!')).toBe('event-sourced-orders')
  })

  it('returns "adr" when nothing slug-worthy remains', () => {
    expect(slugify('!!!')).toBe('adr')
    expect(slugify('')).toBe('adr')
  })

  it('caps length at 60 chars', () => {
    const long = 'a'.repeat(120)
    expect(slugify(long).length).toBe(60)
  })
})

describe('adr nextAdrNumber', () => {
  it('returns 1 for missing dir', async () => {
    expect(await nextAdrNumber(resolve(workRoot, 'missing'))).toBe(1)
  })

  it('returns 1 for empty dir', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    expect(await nextAdrNumber(dir)).toBe(1)
  })

  it('returns max+1 across valid filenames, ignoring junk', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, '0001-first.md'), '# First\n')
    await writeFile(resolve(dir, '0007-seventh.md'), '# Seventh\n')
    await writeFile(resolve(dir, 'README.md'), 'ignored')
    await writeFile(resolve(dir, '99-no-pad.md'), 'ignored')
    expect(await nextAdrNumber(dir)).toBe(8)
  })
})

describe('adr writeAdrInWorktree', () => {
  it('creates docs/adr/ lazily and writes a numbered file', async () => {
    const result = await writeAdrInWorktree({
      worktreePath: workRoot,
      title: 'Use Postgres for the Write Model',
      body: 'We picked Postgres because of write throughput needs.',
    })
    expect(result.number).toBe(1)
    expect(result.filePath.endsWith('0001-use-postgres-for-the-write-model.md')).toBe(
      true,
    )
    const text = await readFile(result.filePath, 'utf8')
    expect(text).toContain('# Use Postgres for the Write Model')
    expect(text).toContain('We picked Postgres')
  })

  it('increments number across successive writes', async () => {
    const a = await writeAdrInWorktree({
      worktreePath: workRoot,
      title: 'First',
      body: 'one',
    })
    const b = await writeAdrInWorktree({
      worktreePath: workRoot,
      title: 'Second',
      body: 'two',
    })
    expect(a.number).toBe(1)
    expect(b.number).toBe(2)
    const entries = await readdir(adrDirIn(workRoot))
    expect(entries.sort()).toEqual(['0001-first.md', '0002-second.md'])
  })
})
