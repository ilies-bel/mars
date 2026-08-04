/**
 * adr-number-allocator tests.
 *
 * Verifies that nextAdrNumber and adrDirIn resolve the decisions directory
 * correctly at `docs/knowledge/decisions/` and that number allocation
 * sequences correctly within it.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adrDirIn, nextAdrNumber } from '../adr'

let workRoot = ''

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), 'mars-adralloc-'))
})

afterEach(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true })
})

describe('adrDirIn', () => {
  it('resolves to docs/knowledge/decisions under the repo root', () => {
    const dir = adrDirIn(workRoot)
    expect(dir).toBe(resolve(workRoot, 'docs/knowledge/decisions'))
  })
})

describe('nextAdrNumber under docs/knowledge/decisions/', () => {
  it('returns 1 when the decisions directory does not exist yet', async () => {
    const dir = adrDirIn(workRoot)
    expect(await nextAdrNumber(dir)).toBe(1)
  })

  it('returns 1 when the decisions directory is empty', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    expect(await nextAdrNumber(dir)).toBe(1)
  })

  it('allocates the next sequential number after existing records', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, '0003-example.md'), '# Example\n')
    await writeFile(resolve(dir, '0005-other.md'), '# Other\n')
    expect(await nextAdrNumber(dir)).toBe(6)
  })

  it('ignores non-conforming filenames when computing the next number', async () => {
    const dir = adrDirIn(workRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, '0002-valid.md'), '# Valid\n')
    await writeFile(resolve(dir, 'README.md'), 'ignored\n')
    await writeFile(resolve(dir, '99-no-pad.md'), 'ignored\n')
    expect(await nextAdrNumber(dir)).toBe(3)
  })
})
