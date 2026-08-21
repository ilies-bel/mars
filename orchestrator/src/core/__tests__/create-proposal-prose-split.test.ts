/**
 * `createProposal` — prose blob is split into title + body at the write
 * boundary.
 *
 * Before this fix, `mars proposal add @<file>` handed a whole multi-paragraph
 * document to `createProposal` as `title`, so `proposals.title` held a
 * 2000-3800 char paragraph and `problem` stayed `''`. The Proposals page then
 * rendered each draft as an unbroken wall of text, and `generateProposalId`
 * slugified the blob into an id truncated mid-sentence.
 *
 * The regression guard that matters most here is the LAST test: structured
 * callers (reflector, failure-reflector, slicer, scorer-trend-trigger,
 * self-evolve-trigger, promote-from-thread, chat-runner) already pass an
 * explicit `problem`, and must keep their current behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalsMod {
  createProposal: typeof import('../proposals').createProposal
  initProposals: typeof import('../proposals').initProposals
  PROPOSAL_TITLE_LIMIT: typeof import('../proposals').PROPOSAL_TITLE_LIMIT
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-split-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<ProposalsMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const p = (await import('../proposals')) as unknown as ProposalsMod
  await p.initProposals()
  return p
}

/** A realistic agent-authored draft: markdown heading, ~2000 chars of body. */
const AGENT_BLOB = [
  '# Proposals are illegible: the whole prose blob is stored as `title`',
  '',
  '## Symptom',
  '',
  'On the Proposals page every planner-sourced draft renders as an unbroken',
  'wall of text — a 2000-3800 character paragraph where the title should be.',
  '',
  '## Root cause',
  '',
  '`mars proposal add` passes its entire prose argument to `createProposal`',
  'as the `title`, and never populates `problem`.',
  '',
  `${'Filler prose to push this document past two thousand characters. '.repeat(30)}`,
].join('\n')

describe('createProposal — prose blob split', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('stores a short title and a non-empty problem for a 2000-char blob', async () => {
    const p = await loadMods(repo)
    expect(AGENT_BLOB.length).toBeGreaterThan(2000)

    const proposal = await p.createProposal(AGENT_BLOB, { source: 'planner' })

    expect(proposal.title).toBe(
      'Proposals are illegible: the whole prose blob is stored as `title`',
    )
    expect(proposal.title.length).toBeLessThanOrEqual(p.PROPOSAL_TITLE_LIMIT)
    expect(proposal.title).not.toContain('\n')
    expect(proposal.problem.length).toBeGreaterThan(0)
    expect(proposal.problem).toContain('## Symptom')
    expect(proposal.problem).toContain('## Root cause')
  })

  it('derives the id from the short title, so it no longer slugs mid-sentence', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal(AGENT_BLOB, { source: 'planner' })

    // The id slug is bounded by the derived title, not the whole document.
    expect(proposal.id).toContain('proposals-are-illegible')
    expect(proposal.id).not.toContain('filler')
  })

  it('leaves a genuinely single-line proposal with an empty problem', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal('Add a typescript typecheck verify gate', {
      source: 'human',
    })

    expect(proposal.title).toBe('Add a typescript typecheck verify gate')
    expect(proposal.problem).toBe('')
  })

  it('preserves an explicit problem from a structured caller, untouched', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal('Add a typescript typecheck verify gate', {
      source: 'failure-reflector',
      problem: 'Verify gates do not run tsc, so type errors reach main.',
    })

    expect(proposal.title).toBe('Add a typescript typecheck verify gate')
    // Single-line title => no leftover body => the caller's problem is verbatim.
    expect(proposal.problem).toBe('Verify gates do not run tsc, so type errors reach main.')
  })

  it('prepends leftover body to an explicit problem rather than dropping it', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal('A real title\n\nleftover body text', {
      source: 'failure-reflector',
      problem: 'the structured problem',
    })

    expect(proposal.title).toBe('A real title')
    // No text may be silently lost: both halves survive, body first.
    expect(proposal.problem).toBe('leftover body text\n\nthe structured problem')
  })
})

describe('createProposal — explicit `--title` override', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('stores an explicit title verbatim and treats the whole goal as body', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal(
      'this first line would normally become the title',
      { source: 'human', explicitTitle: 'A deliberate title' },
    )

    expect(proposal.title).toBe('A deliberate title')
    expect(proposal.problem).toBe('this first line would normally become the title')
  })

  it('word-boundary-truncates an over-long explicit title at the same limit as a derived one', async () => {
    const p = await loadMods(repo)
    const longTitle = 'word '.repeat(40).trim() // 199 chars
    const proposal = await p.createProposal('goal body', {
      source: 'human',
      explicitTitle: longTitle,
    })

    expect(proposal.title.length).toBeLessThanOrEqual(p.PROPOSAL_TITLE_LIMIT)
    expect(proposal.title.endsWith('…')).toBe(true)
  })

  it('falls back to derivation when explicitTitle is blank/whitespace-only', async () => {
    const p = await loadMods(repo)
    const proposal = await p.createProposal('# Heading wins\n\nbody text', {
      source: 'human',
      explicitTitle: '   ',
    })

    expect(proposal.title).toBe('Heading wins')
    expect(proposal.problem).toBe('body text')
  })

  it('does not truncate the id slug boundary onto the display title', async () => {
    const p = await loadMods(repo)
    // Longer than generateProposalId's 40-char slug cap but under the title limit.
    const title = 'A title that is definitely longer than forty characters long'
    const proposal = await p.createProposal('goal body', {
      source: 'human',
      explicitTitle: title,
    })

    expect(proposal.title).toBe(title)
  })
})
