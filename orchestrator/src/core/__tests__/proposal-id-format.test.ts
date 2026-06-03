/**
 * Verify that proposals are minted with `prop-<hex>` ids (no slug suffix).
 *
 * Acceptance criteria:
 *  - generateProposalId() returns a `prop-<hex>` string (no slug suffix).
 *  - createProposal() stores and returns the `prop-<hex>` id form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-id-fmt-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('generateProposalId — prop-<hex> with no slug', () => {
  it('returns a prop-<hex> tagged string', async () => {
    const { generateProposalId } = await import('../proposals')
    const id = generateProposalId()
    expect(id).toMatch(/^prop-[0-9a-f]{8}$/)
  })

  it('returns a different id each call', async () => {
    const { generateProposalId } = await import('../proposals')
    const a = generateProposalId()
    const b = generateProposalId()
    expect(a).not.toBe(b)
  })

  it('does not include any slug text', async () => {
    const { generateProposalId } = await import('../proposals')
    const id = generateProposalId()
    // A slug would contain word characters after the hex; the id must be exactly
    // prop- followed by 8 hex chars and nothing else.
    expect(id.split('-')).toHaveLength(2)
    expect(id.split('-')[0]).toBe('prop')
    expect(id.split('-')[1]).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('createProposal — id is prop-<hex>', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('a new proposal carries a prop-<hex> id', async () => {
    const { initProposals, createProposal } = await import('../proposals')
    await initProposals()
    const proposal = await createProposal('Some new feature idea')
    expect(proposal.id).toMatch(/^prop-[0-9a-f]{8}$/)
  })

  it('two proposals get distinct ids', async () => {
    const { initProposals, createProposal } = await import('../proposals')
    await initProposals()
    const a = await createProposal('Feature A')
    const b = await createProposal('Feature B')
    expect(a.id).not.toBe(b.id)
  })

  it('proposal id is the same length as a task id render', async () => {
    // task id render = 'task-<8hex>' = 13 chars; prop-<8hex> = 13 chars
    const { initProposals, createProposal } = await import('../proposals')
    await initProposals()
    const proposal = await createProposal('Width parity check')
    expect(proposal.id.length).toBe('task-xxxxxxxx'.length)
  })
})
