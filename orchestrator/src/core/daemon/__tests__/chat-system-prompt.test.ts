/**
 * Tests for chat-system-prompt.ts — resolveChatSystemPrompt behaviour
 * and CHAT_SYSTEM_PROMPT content contract.
 *
 * Uses real temp directories so file-system semantics are proven against
 * the actual `fs/promises` APIs rather than mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../lib/settings', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  ONBOARDING_OPERATOR_NAME_KEY: 'onboarding.operator_name',
}))
vi.mock('../../store/state-client', () => ({
  resolveStateClient: vi.fn().mockReturnValue({}),
}))
vi.mock('../../lib/vision', () => ({
  readVision: vi.fn().mockResolvedValue(null),
}))

import { CHAT_SYSTEM_PROMPT, resolveChatSystemPrompt } from '../chat-system-prompt'
import { DESTRUCTIVE_MARS_VERBS, SAFE_MARS_VERBS } from '../../lib/chat-mars-verbs'

describe('resolveChatSystemPrompt', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'mars-chat-prompt-test-'))
    // Create the .mars directory that consumers would have.
    await mkdir(join(repoRoot, '.mars'))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('returns CHAT_SYSTEM_PROMPT when the override file is absent', async () => {
    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toEqual({ prompt: CHAT_SYSTEM_PROMPT, source: 'built-in' })
  })

  it('returns trimmed file contents when the override file exists and is non-empty', async () => {
    const custom = '  My custom operator prompt.\nSecond line.  '
    await writeFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), custom, 'utf8')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toEqual({ prompt: custom.trim(), source: 'override' })
  })

  it('falls back to CHAT_SYSTEM_PROMPT when the override file is empty', async () => {
    await writeFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), '', 'utf8')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toEqual({ prompt: CHAT_SYSTEM_PROMPT, source: 'built-in' })
  })

  it('falls back to CHAT_SYSTEM_PROMPT when the override file is whitespace-only', async () => {
    await writeFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), '   \n\t\n  ', 'utf8')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toEqual({ prompt: CHAT_SYSTEM_PROMPT, source: 'built-in' })
  })

  it('falls back to CHAT_SYSTEM_PROMPT when .mars directory does not exist', async () => {
    // Remove the .mars dir entirely so the read throws ENOENT.
    await rm(join(repoRoot, '.mars'), { recursive: true })

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toEqual({ prompt: CHAT_SYSTEM_PROMPT, source: 'built-in' })
  })
})

describe('CHAT_SYSTEM_PROMPT content', () => {
  it('matches snapshot', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatchSnapshot()
  })

  it('does not contain the old "chat surface, not an implementation surface" language', () => {
    expect(CHAT_SYSTEM_PROMPT).not.toContain(
      'this is a chat surface, not an implementation surface',
    )
  })

  it('lists every safe verb in the Scope paragraph', () => {
    const scopeStart = CHAT_SYSTEM_PROMPT.indexOf('Scope:')
    const scopeEnd = CHAT_SYSTEM_PROMPT.indexOf('\n\n', scopeStart)
    const scopeParagraph = CHAT_SYSTEM_PROMPT.slice(
      scopeStart,
      scopeEnd === -1 ? undefined : scopeEnd,
    )
    for (const verb of SAFE_MARS_VERBS) {
      expect(scopeParagraph).toContain(verb)
    }
  })

  it('lists every destructive verb in the Scope paragraph', () => {
    const scopeStart = CHAT_SYSTEM_PROMPT.indexOf('Scope:')
    const scopeEnd = CHAT_SYSTEM_PROMPT.indexOf('\n\n', scopeStart)
    const scopeParagraph = CHAT_SYSTEM_PROMPT.slice(
      scopeStart,
      scopeEnd === -1 ? undefined : scopeEnd,
    )
    for (const verb of DESTRUCTIVE_MARS_VERBS) {
      expect(scopeParagraph).toContain(verb)
    }
  })

  it('instructs the destructive-propose protocol with mars propose', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('mars propose')
  })

  it('still routes code changes through mars task add', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('mars task add')
  })

  it('includes the hardness rubric verbatim', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain(`- term-defining
- cross-cutting
- scope-ambiguous
- contradicts an ADR`)
  })
})
