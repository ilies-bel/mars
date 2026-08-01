import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMemoryFacts } from '../../workers/providers'
import { ChatRunner } from '../chat-runner'

vi.mock('../chat-system-prompt', () => ({
  resolveChatSystemPrompt: vi.fn().mockResolvedValue({ prompt: 'Mars.', source: 'built-in' }),
}))

vi.mock('../chat-skills', () => ({
  buildSkillsSection: vi.fn(),
  discoverSkills: vi.fn().mockResolvedValue([]),
  loadSkill: vi.fn(),
}))

vi.mock('../chat-mcp', () => ({
  ChatMcpManager: class {
    describe = vi.fn().mockResolvedValue([])
  },
}))

const originalChatModel = process.env.MARS_CHAT_MODEL

afterEach(() => {
  if (originalChatModel === undefined) delete process.env.MARS_CHAT_MODEL
  else process.env.MARS_CHAT_MODEL = originalChatModel
})

describe('ChatRunner provider memory', () => {
  it('reports the selected provider memory facts in its public configuration', async () => {
    const memory: ConversationMemoryFacts = {
      retentionMs: 90_000,
      minimumReusablePrefixTokens: 2_048,
      contextWindowTokens: 128_000,
    }
    const config = await new ChatRunner(undefined, memory).describeConfig('/repo')

    expect(config).toMatchObject(memory)
  })

  it('fails explicitly when the selected provider has no facts for the configured chat model', async () => {
    process.env.MARS_CHAT_MODEL = 'not-a-provider-model'

    expect(() => new ChatRunner()).toThrow(
      "Provider 'codex' has no conversation-memory facts for model 'not-a-provider-model'",
    )
  })
})
