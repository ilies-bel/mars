import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const getSettingMock = vi.fn<[unknown, string], Promise<string | null>>()

vi.mock('../../lib/settings', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(args[0], args[1] as string),
  ONBOARDING_OPERATOR_NAME_KEY: 'onboarding.operator_name',
  ONBOARDING_VISION_KEY: 'onboarding.vision',
}))
vi.mock('../../store/state-client', () => ({
  resolveStateClient: vi.fn().mockReturnValue({}),
}))

import { CHAT_SYSTEM_PROMPT, resolveChatSystemPrompt } from '../chat-system-prompt'

describe('resolveChatSystemPrompt — operator name and vision injection', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'mars-chat-vision-test-'))
    await mkdir(join(repoRoot, '.mars'))
    getSettingMock.mockReset()
  })

  it('prepends operator name and vision when both are set', async () => {
    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.operator_name') return 'Alex'
      if (key === 'onboarding.vision') return 'Build the best orchestrator.'
      return null
    })

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).toContain('Operator: Alex.')
    expect(result.prompt).toContain('Project Vision (persisted; keep in mind every turn):\nBuild the best orchestrator.')
    expect(result.prompt).toContain('---')
    expect(result.prompt).toContain(CHAT_SYSTEM_PROMPT)
    expect(result.prompt.indexOf('Operator: Alex.')).toBeLessThan(result.prompt.indexOf(CHAT_SYSTEM_PROMPT))
    expect(result.source).toBe('built-in')
  })

  it('prepends only operator name when vision is null', async () => {
    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.operator_name') return 'Alex'
      return null
    })

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).toContain('Operator: Alex.')
    expect(result.prompt).not.toContain('Project Vision')
    expect(result.prompt).toContain(CHAT_SYSTEM_PROMPT)
  })

  it('prepends only vision when operator name is null', async () => {
    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.vision') return 'Ship fast.'
      return null
    })

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).not.toContain('Operator:')
    expect(result.prompt).toContain('Project Vision (persisted; keep in mind every turn):\nShip fast.')
    expect(result.prompt).toContain(CHAT_SYSTEM_PROMPT)
  })

  it('returns base prompt verbatim when neither is set', async () => {
    getSettingMock.mockResolvedValue(null)

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).toBe(CHAT_SYSTEM_PROMPT)
    expect(result.source).toBe('built-in')
  })

  it('re-reads settings per call (no caching)', async () => {
    getSettingMock.mockResolvedValue(null)
    const first = await resolveChatSystemPrompt(repoRoot)
    expect(first.prompt).toBe(CHAT_SYSTEM_PROMPT)

    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.operator_name') return 'Riley'
      return null
    })
    const second = await resolveChatSystemPrompt(repoRoot)
    expect(second.prompt).toContain('Operator: Riley.')
  })
})
