import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathExists } from './git'

describe('pathExists', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mars-git-pathexists-'))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('returns true for an existing file', async () => {
    const file = join(scratch, 'file.txt')
    await writeFile(file, 'hi', 'utf8')
    await expect(pathExists(file)).resolves.toBe(true)
  })

  it('returns true for an existing directory', async () => {
    const dir = join(scratch, 'dir')
    await mkdir(dir)
    await expect(pathExists(dir)).resolves.toBe(true)
  })

  it('returns false for a path that does not exist', async () => {
    const ghost = join(scratch, 'does-not-exist')
    await expect(pathExists(ghost)).resolves.toBe(false)
  })

  it('returns false for an empty string', async () => {
    await expect(pathExists('')).resolves.toBe(false)
  })
})
