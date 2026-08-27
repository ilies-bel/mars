import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const getSettingMock = vi.fn<(_db: unknown, key: string) => Promise<string | null>>()

vi.mock('../../lib/settings', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(args[0], args[1] as string),
  ONBOARDING_OPERATOR_NAME_KEY: 'onboarding.operator_name',
}))
vi.mock('../../store/state-client', () => ({
  resolveStateClient: vi.fn().mockReturnValue({}),
}))

import { CHAT_SYSTEM_PROMPT, resolveChatSystemPrompt } from '../chat-system-prompt'
import { CHAT_ONBOARDING_INTERVIEW_STANZA, CHAT_ONBOARDING_PROMPT } from '../chat-onboarding-prompt'

describe('resolveChatSystemPrompt — operator name and vision injection', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'mars-chat-vision-test-'))
    await mkdir(join(repoRoot, '.mars'))
    getSettingMock.mockReset()
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  /**
   * Write docs/knowledge/vision.md inside the temp repo so resolveChatSystemPrompt
   * can read it via readVision(repoRoot).
   */
  const writeVisionFile = async (content: string) => {
    await mkdir(join(repoRoot, 'docs', 'knowledge'), { recursive: true })
    await writeFile(join(repoRoot, 'docs', 'knowledge', 'vision.md'), content, 'utf8')
  }

  it('prepends operator name and vision when both are set', async () => {
    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.operator_name') return 'Alex'
      return null
    })
    await writeVisionFile('Build the best orchestrator.')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).toContain('Operator: Alex.')
    expect(result.prompt).toContain('Project Vision (persisted; keep in mind every turn):\nBuild the best orchestrator.')
    expect(result.prompt).toContain('---')
    expect(result.prompt).toContain(CHAT_SYSTEM_PROMPT)
    expect(result.prompt.indexOf('Operator: Alex.')).toBeLessThan(result.prompt.indexOf(CHAT_SYSTEM_PROMPT))
    expect(result.source).toBe('built-in')
  })

  it('does not emit the onboarding interview stanza when the Vision is stored', async () => {
    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.operator_name') return 'Alex'
      return null
    })
    await writeVisionFile('Build the best orchestrator.')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).not.toContain('Onboarding mode')
    expect(result.prompt).not.toContain(CHAT_ONBOARDING_INTERVIEW_STANZA)
    expect(result.prompt).not.toContain('After the Vision is captured')
  })

  it('prepends only vision when operator name is null', async () => {
    getSettingMock.mockResolvedValue(null)
    await writeVisionFile('Ship fast.')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).not.toContain('Operator:')
    expect(result.prompt).toContain('Project Vision (persisted; keep in mind every turn):\nShip fast.')
    expect(result.prompt).toContain(CHAT_SYSTEM_PROMPT)
  })

  it('puts the agent in onboarding mode when no Vision is stored', async () => {
    getSettingMock.mockResolvedValue(null)
    // No vision file written — docs/knowledge/vision.md does not exist.

    const result = await resolveChatSystemPrompt(repoRoot)
    // Should contain the full interview stanza.
    expect(result.prompt).toContain(CHAT_ONBOARDING_INTERVIEW_STANZA)
    // Should contain the after-Vision instructions so the agent knows what to do
    // once the Vision is persisted.
    expect(result.prompt).toContain(CHAT_ONBOARDING_PROMPT)
    // The main Mars prompt body must still follow.
    expect(result.prompt).toContain(CHAT_SYSTEM_PROMPT)
    // The onboarding stanza comes before the main body.
    expect(result.prompt.indexOf(CHAT_ONBOARDING_INTERVIEW_STANZA)).toBeLessThan(
      result.prompt.indexOf(CHAT_SYSTEM_PROMPT),
    )
    expect(result.source).toBe('built-in')
  })

  it('puts the agent in onboarding mode even when the operator name is already set but Vision is absent', async () => {
    // Name persisted during a previous turn but Vision interview not yet completed.
    getSettingMock.mockImplementation(async (_db, key) => {
      if (key === 'onboarding.operator_name') return 'Alex'
      return null
    })
    // No vision file.

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result.prompt).toContain(CHAT_ONBOARDING_INTERVIEW_STANZA)
    expect(result.prompt).toContain(CHAT_ONBOARDING_PROMPT)
    // The personalisation stanza (Operator: name) is NOT prepended during onboarding.
    expect(result.prompt).not.toContain('Operator: Alex.')
    expect(result.prompt).not.toContain('Project Vision')
  })

  it('re-reads vision file per call (no caching)', async () => {
    getSettingMock.mockResolvedValue(null)
    const first = await resolveChatSystemPrompt(repoRoot)
    // No vision on first call → onboarding stanza.
    expect(first.prompt).toContain(CHAT_ONBOARDING_INTERVIEW_STANZA)
    expect(first.prompt).not.toContain('Project Vision')

    // Write the vision file between calls.
    await writeVisionFile('Lean and local.')
    const second = await resolveChatSystemPrompt(repoRoot)
    expect(second.prompt).toContain('Project Vision (persisted; keep in mind every turn):\nLean and local.')
    // Onboarding stanza should be gone once vision is set.
    expect(second.prompt).not.toContain(CHAT_ONBOARDING_INTERVIEW_STANZA)
  })
})
