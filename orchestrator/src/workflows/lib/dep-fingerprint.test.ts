import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeDepFingerprint } from './dep-fingerprint.js'

describe('computeDepFingerprint', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dep-fingerprint-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when no manifest or lockfile is present', async () => {
    const result = await computeDepFingerprint(dir)
    expect(result).toBeNull()
  })

  it('returns a non-null string when package.json is present', async () => {
    await writeFile(join(dir, 'package.json'), '{"name":"test"}')
    const result = await computeDepFingerprint(dir)
    expect(result).not.toBeNull()
    expect(typeof result).toBe('string')
    expect(result!.length).toBeGreaterThan(0)
  })

  it('flips the fingerprint when package.json content changes', async () => {
    await writeFile(join(dir, 'package.json'), '{"name":"test","version":"1.0.0"}')
    const fp1 = await computeDepFingerprint(dir)

    await writeFile(join(dir, 'package.json'), '{"name":"test","version":"2.0.0"}')
    const fp2 = await computeDepFingerprint(dir)

    expect(fp1).not.toBeNull()
    expect(fp2).not.toBeNull()
    expect(fp1).not.toBe(fp2)
  })

  it('flips the fingerprint when the lockfile changes', async () => {
    await writeFile(join(dir, 'package.json'), '{"name":"test"}')
    await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":2}')
    const fp1 = await computeDepFingerprint(dir)

    await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3}')
    const fp2 = await computeDepFingerprint(dir)

    expect(fp1).not.toBeNull()
    expect(fp2).not.toBeNull()
    expect(fp1).not.toBe(fp2)
  })

  it('keeps the fingerprint stable across calls when files are unchanged', async () => {
    const pkg = '{"name":"stable","version":"1.0.0"}'
    const lock = 'lockfileVersion: 6\n'
    await writeFile(join(dir, 'package.json'), pkg)
    await writeFile(join(dir, 'yarn.lock'), lock)

    const fp1 = await computeDepFingerprint(dir)
    const fp2 = await computeDepFingerprint(dir)

    expect(fp1).not.toBeNull()
    expect(fp1).toBe(fp2)
  })

  it('keeps the fingerprint stable for a whitespace-only rewrite of identical content', async () => {
    // Write once, capture fingerprint.
    const content = '{"name":"test"}'
    await writeFile(join(dir, 'package.json'), content)
    const fp1 = await computeDepFingerprint(dir)

    // Overwrite with the exact same bytes — same content, same fingerprint.
    await writeFile(join(dir, 'package.json'), content)
    const fp2 = await computeDepFingerprint(dir)

    expect(fp1).toBe(fp2)
  })

  it('returns null when only an empty dir exists (no manifest files)', async () => {
    const result = await computeDepFingerprint(dir)
    expect(result).toBeNull()
  })

  it('returns non-null when only a lockfile is present (no package.json)', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const result = await computeDepFingerprint(dir)
    expect(result).not.toBeNull()
  })

  it('uses pnpm-lock.yaml when package-lock.json is absent', async () => {
    await writeFile(join(dir, 'package.json'), '{"name":"test"}')
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    const fp = await computeDepFingerprint(dir)
    expect(fp).not.toBeNull()

    // Mutating pnpm-lock.yaml flips the fingerprint.
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n')
    const fp2 = await computeDepFingerprint(dir)
    expect(fp2).not.toBe(fp)
  })

  it('does not throw when the worktree root path does not exist', async () => {
    const nonExistent = join(dir, 'ghost')
    const result = await computeDepFingerprint(nonExistent)
    expect(result).toBeNull()
  })
})
