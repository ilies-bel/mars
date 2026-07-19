import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

function setupRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-mps-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'))
  return repo
}

async function loadDeps(repo: string) {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../memory-packet-store')
  await mod.initMemoryPackets()
  return mod
}

describe('memory-packet-store', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('inserts a packet and returns it with correct fields', async () => {
    const { insertMemoryPacket } = await loadDeps(repo)
    const p = await insertMemoryPacket({
      domain: 'orchestrator',
      text: 'prefer deep modules over shallow',
      salience: 0.8,
    })

    expect(p.id).toMatch(/^mp-[0-9a-f]{16}$/)
    expect(p.domain).toBe('orchestrator')
    expect(p.text).toBe('prefer deep modules over shallow')
    expect(p.salience).toBe(0.8)
    expect(p.originArcId).toBeNull()
    expect(p.retiredAt).toBeNull()
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('inserts a packet with originArcId', async () => {
    const { insertMemoryPacket } = await loadDeps(repo)
    const p = await insertMemoryPacket({
      domain: 'coder',
      text: 'avoid nested callbacks',
      salience: 0.6,
      originArcId: 'arc-abc123',
    })

    expect(p.originArcId).toBe('arc-abc123')
  })

  it('lists packets ordered by salience descending', async () => {
    const { insertMemoryPacket, listMemoryPackets } = await loadDeps(repo)
    await insertMemoryPacket({ domain: 'test', text: 'low',  salience: 0.2 })
    await insertMemoryPacket({ domain: 'test', text: 'high', salience: 0.9 })
    await insertMemoryPacket({ domain: 'test', text: 'mid',  salience: 0.5 })

    const results = await listMemoryPackets({ domain: 'test' })
    expect(results.map((r) => r.text)).toEqual(['high', 'mid', 'low'])
  })

  it('filters out packets below minSalience threshold', async () => {
    const { insertMemoryPacket, listMemoryPackets } = await loadDeps(repo)
    await insertMemoryPacket({ domain: 'test', text: 'below', salience: 0.3 })
    await insertMemoryPacket({ domain: 'test', text: 'above', salience: 0.9 })

    const results = await listMemoryPackets({ domain: 'test', minSalience: 0.5 })
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('above')
  })

  it('respects top-k limit', async () => {
    const { insertMemoryPacket, listMemoryPackets } = await loadDeps(repo)
    await insertMemoryPacket({ domain: 'test', text: 'first',  salience: 0.9 })
    await insertMemoryPacket({ domain: 'test', text: 'second', salience: 0.8 })
    await insertMemoryPacket({ domain: 'test', text: 'third',  salience: 0.7 })

    const results = await listMemoryPackets({ domain: 'test', limit: 2 })
    expect(results).toHaveLength(2)
    expect(results[0].text).toBe('first')
    expect(results[1].text).toBe('second')
  })

  it('retire hides the packet from listing', async () => {
    const { insertMemoryPacket, listMemoryPackets, retireMemoryPacket } = await loadDeps(repo)
    const p = await insertMemoryPacket({ domain: 'test', text: 'to retire', salience: 0.9 })

    const ok = await retireMemoryPacket(p.id)
    expect(ok).toBe(true)

    const results = await listMemoryPackets({ domain: 'test' })
    expect(results).toHaveLength(0)
  })

  it('retire returns false for an unknown id', async () => {
    const { retireMemoryPacket } = await loadDeps(repo)
    const ok = await retireMemoryPacket('mp-doesnotexist')
    expect(ok).toBe(false)
  })

  it('retire returns false when already retired', async () => {
    const { insertMemoryPacket, retireMemoryPacket } = await loadDeps(repo)
    const p = await insertMemoryPacket({ domain: 'test', text: 'retire twice', salience: 0.7 })
    await retireMemoryPacket(p.id)
    const secondOk = await retireMemoryPacket(p.id)
    expect(secondOk).toBe(false)
  })

  it('only lists packets for the specified domain', async () => {
    const { insertMemoryPacket, listMemoryPackets } = await loadDeps(repo)
    await insertMemoryPacket({ domain: 'domain-a', text: 'a-packet', salience: 0.9 })
    await insertMemoryPacket({ domain: 'domain-b', text: 'b-packet', salience: 0.9 })

    const results = await listMemoryPackets({ domain: 'domain-a' })
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('a-packet')
  })
})
