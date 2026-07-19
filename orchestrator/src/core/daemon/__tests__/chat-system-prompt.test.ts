/**
 * Tests for chat-system-prompt.ts — resolveChatSystemPrompt behaviour.
 *
 * Uses real temp directories so file-system semantics are proven against
 * the actual `fs/promises` APIs rather than mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CHAT_SYSTEM_PROMPT, resolveChatSystemPrompt } from '../chat-system-prompt'

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
    expect(result).toBe(CHAT_SYSTEM_PROMPT)
  })

  it('returns trimmed file contents when the override file exists and is non-empty', async () => {
    const custom = '  My custom operator prompt.\nSecond line.  '
    await writeFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), custom, 'utf8')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toBe(custom.trim())
  })

  it('falls back to CHAT_SYSTEM_PROMPT when the override file is empty', async () => {
    await writeFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), '', 'utf8')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toBe(CHAT_SYSTEM_PROMPT)
  })

  it('falls back to CHAT_SYSTEM_PROMPT when the override file is whitespace-only', async () => {
    await writeFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), '   \n\t\n  ', 'utf8')

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toBe(CHAT_SYSTEM_PROMPT)
  })

  it('falls back to CHAT_SYSTEM_PROMPT when .mars directory does not exist', async () => {
    // Remove the .mars dir entirely so the read throws ENOENT.
    await rm(join(repoRoot, '.mars'), { recursive: true })

    const result = await resolveChatSystemPrompt(repoRoot)
    expect(result).toBe(CHAT_SYSTEM_PROMPT)
  })
})
