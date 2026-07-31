import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatMcpManager } from '../chat-mcp'
import { promoteProposalFromThread } from '../promote-from-thread'

const proposals = vi.hoisted(() => ({
  addProposalUserStory: vi.fn(),
  createProposal: vi.fn(),
  promoteProposal: vi.fn(),
}))
vi.mock('../../proposals', () => proposals)

const store = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  getThread: vi.fn(),
  posture: 'grill' as 'triage' | 'grill',
  setThreadPosture: vi.fn(),
}))
vi.mock('../../lib/chat-store', () => store)

describe('promoteProposalFromThread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.posture = 'grill'
    store.getThread.mockImplementation(async (id: string) => ({
      thread: {
        id,
        title: 'Make grill outcomes self-contained',
        posture: store.posture,
      },
      messages: [
        {
          role: 'user',
          content: 'A settled grill should become a PRD without a separate skill.',
          segments: [{ type: 'glossary_ref', ref: 'grill posture' }],
        },
        {
          role: 'assistant',
          content: 'We will promote the shaped conversation when every rubric item is settled.',
          segments: [{ type: 'adr_ref', ref: 'ADR-0069' }],
        },
      ],
    }))
    store.setThreadPosture.mockImplementation(async (_id: string, posture: 'triage' | 'grill') => {
      store.posture = posture
    })
    proposals.createProposal.mockResolvedValue({ id: 'proposal-17' })
    proposals.addProposalUserStory.mockResolvedValue({ id: 'proposal-17' })
    proposals.promoteProposal.mockResolvedValue({ id: 'proposal-17', status: 'prd-ready' })
  })

  it('promotes one settled grill as a PRD and returns its thread to triage', async () => {
    const proposal = await promoteProposalFromThread('thread-17')

    expect(proposal).toMatchObject({ id: 'proposal-17', status: 'prd-ready' })
    expect(proposals.createProposal).toHaveBeenCalledTimes(1)
    expect(proposals.createProposal).toHaveBeenCalledWith(
      'Make grill outcomes self-contained',
      expect.objectContaining({
        problem: expect.stringContaining('without a separate skill'),
        solution: expect.stringContaining('promote the shaped conversation'),
        outOfScope: expect.any(String),
        notes: expect.stringContaining('Glossary mutations: grill posture'),
      }),
    )
    expect(proposals.addProposalUserStory).toHaveBeenCalledWith(
      'proposal-17',
      expect.stringContaining('As an operator'),
    )
    expect(proposals.promoteProposal).toHaveBeenCalledWith('proposal-17')
    expect(store.posture).toBe('triage')
    expect(store.appendMessage).toHaveBeenCalledWith(
      'thread-17',
      'assistant',
      expect.stringContaining('proposal proposal-17'),
      expect.anything(),
    )
  })

  it('registers the promotion action as a chat MCP tool', async () => {
    const mcp = new ChatMcpManager()

    const tools = await mcp.getTools('/repo')
    const result = await mcp.call('/repo', 'promote_proposal_from_thread', { threadId: 'thread-17' })

    expect(tools).toContainEqual(expect.objectContaining({ name: 'promote_proposal_from_thread' }))
    expect(result).toEqual({ text: 'promoted proposal proposal-17', isError: false })
    expect(proposals.promoteProposal).toHaveBeenCalledTimes(1)
  })
})
