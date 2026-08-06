import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adrDirIn, nextAdrNumber, parseAdrStatus, slugify, supersedeAdrInWorktree, writeAdrInWorktree } from '../adr'

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
  it('creates docs/knowledge/decisions/ lazily and writes a numbered file', async () => {
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

describe('adr parseAdrStatus', () => {
  it('returns null when no ## Status section exists', () => {
    const content = '# Title\n\nBody content.\n'
    expect(parseAdrStatus(content)).toBeNull()
  })

  it('returns supersededBy when status says "Superseded by NNNN"', () => {
    const content = '# Title\n\n## Status\n\nSuperseded by 0091\n\nBody.\n'
    expect(parseAdrStatus(content)).toEqual({ supersededBy: '0091' })
  })

  it('returns null for a non-superseded status section', () => {
    const content = '# Title\n\n## Status\n\nProposed (some strategy).\n\nBody.\n'
    expect(parseAdrStatus(content)).toBeNull()
  })
})

describe('adr supersedeAdrInWorktree', () => {
  it('adds a Status section to an ADR with no existing status', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(
      resolve(dir, '0084-a-subject-closes.md'),
      '# A Subject closes on a declared terminal event\n\nBody content.\n',
    )

    const result = await supersedeAdrInWorktree({
      worktreePath: workRoot,
      oldNumber: '0084',
      newNumber: '0091',
    })

    expect(result.filename).toBe('0084-a-subject-closes.md')
    const text = await readFile(result.filePath, 'utf8')
    expect(text).toContain('## Status')
    expect(text).toContain('Superseded by 0091')
    // Original body preserved
    expect(text).toContain('Body content.')
    // parseAdrStatus should confirm supersession
    expect(parseAdrStatus(text)).toEqual({ supersededBy: '0091' })
  })

  it('replaces an existing ## Status section', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(
      resolve(dir, '0087-old.md'),
      '# Old ADR\n\n## Status\n\nProposed.\n\n## Context\n\nContext body.\n',
    )

    await supersedeAdrInWorktree({
      worktreePath: workRoot,
      oldNumber: '0087',
      newNumber: '0088',
    })

    const text = await readFile(resolve(dir, '0087-old.md'), 'utf8')
    expect(parseAdrStatus(text)).toEqual({ supersededBy: '0088' })
    // Original context preserved
    expect(text).toContain('## Context')
    expect(text).toContain('Context body.')
    // Old status text gone
    expect(text).not.toContain('Proposed.')
  })

  it('accepts unpadded numbers and normalises them', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(
      resolve(dir, '0009-releases.md'),
      '# Releases ship one bundle\n\nBody.\n',
    )

    await supersedeAdrInWorktree({
      worktreePath: workRoot,
      oldNumber: '9',   // unpadded
      newNumber: '34',  // unpadded
    })

    const text = await readFile(resolve(dir, '0009-releases.md'), 'utf8')
    expect(parseAdrStatus(text)).toEqual({ supersededBy: '0034' })
  })

  it('throws when the old ADR does not exist', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })

    await expect(
      supersedeAdrInWorktree({
        worktreePath: workRoot,
        oldNumber: '0999',
        newNumber: '1000',
      }),
    ).rejects.toThrow(/0999/)
  })

  it('throws when the ADR directory does not exist', async () => {
    await expect(
      supersedeAdrInWorktree({
        worktreePath: workRoot,
        oldNumber: '0001',
        newNumber: '0002',
      }),
    ).rejects.toThrow(/does not exist/)
  })
})
