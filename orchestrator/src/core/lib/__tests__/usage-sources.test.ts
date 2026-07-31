// Unit tests for the UsageSource seam.
//
// Each test uses fixture data (inline strings or real temp files) to verify
// that each adapter converts its provider-specific format into UsageTotals.
// No real claude/codex/gemini process is spawned.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  resolveUsage,
  claudeSessionJsonlAdapter,
  codexPtyLogAdapter,
  geminiPtyLogAdapter,
} from '../usage-sources'
import { emptyUsageTotals } from '../claude-usage'

// ── helpers ──────────────────────────────────────────────────────────────────

const makeTmpDir = (): string => mkdtempSync(join(tmpdir(), 'usage-src-'))

/** Build a minimal claude session JSONL line for an assistant turn. */
const assistantLine = (
  input: number,
  output: number,
  cacheCreate = 0,
  cacheRead = 0,
): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  })

// ── claudeSessionJsonlAdapter ─────────────────────────────────────────────────

describe('claudeSessionJsonlAdapter', () => {
  it('returns null when the projects dir does not exist', async () => {
    const result = await claudeSessionJsonlAdapter('non-existent-session', '/tmp/does-not-exist-xyz')
    expect(result).toBeNull()
  })

  it('returns null when no matching session file is found', async () => {
    const projectsDir = makeTmpDir()
    mkdirSync(join(projectsDir, '-Users-project'), { recursive: true })
    // write a file for a different session
    writeFileSync(join(projectsDir, '-Users-project', 'other-session.jsonl'), assistantLine(10, 5))

    const result = await claudeSessionJsonlAdapter('target-session-id', projectsDir)
    expect(result).toBeNull()
  })

  it('sums per-turn usage across all assistant events in the JSONL', async () => {
    const projectsDir = makeTmpDir()
    const projectDir = join(projectsDir, '-Users-project')
    mkdirSync(projectDir, { recursive: true })
    const sessionId = 'test-session-abc'
    const content = [
      assistantLine(100, 50),
      assistantLine(200, 75),
    ].join('\n') + '\n'
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), content)

    const result = await claudeSessionJsonlAdapter(sessionId, projectsDir)
    expect(result).not.toBeNull()
    expect(result!.inputTokens).toBe(300)
    expect(result!.outputTokens).toBe(125)
    expect(result!.messageCount).toBe(2)
  })

  it('counts cache tokens separately', async () => {
    const projectsDir = makeTmpDir()
    const projectDir = join(projectsDir, '-project')
    mkdirSync(projectDir, { recursive: true })
    const sessionId = 'cache-test-session'
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      assistantLine(10, 5, 1000, 200) + '\n',
    )

    const result = await claudeSessionJsonlAdapter(sessionId, projectsDir)
    expect(result!.inputTokens).toBe(10)
    expect(result!.cacheCreateTokens).toBe(1000)
    expect(result!.cacheReadTokens).toBe(200)
  })

  it('skips malformed JSON lines without throwing', async () => {
    const projectsDir = makeTmpDir()
    const projectDir = join(projectsDir, '-project-bad')
    mkdirSync(projectDir, { recursive: true })
    const sessionId = 'bad-lines-session'
    const content = [
      assistantLine(50, 20),
      '{ this is not valid json }',
      '',
      assistantLine(30, 10),
    ].join('\n') + '\n'
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), content)

    const result = await claudeSessionJsonlAdapter(sessionId, projectsDir)
    expect(result!.inputTokens).toBe(80)
    expect(result!.outputTokens).toBe(30)
    expect(result!.messageCount).toBe(2)
  })

  it('searches across multiple project subdirectories', async () => {
    const projectsDir = makeTmpDir()
    mkdirSync(join(projectsDir, '-project-a'), { recursive: true })
    mkdirSync(join(projectsDir, '-project-b'), { recursive: true })
    const sessionId = 'multi-proj-session'
    // Put the session in project-b
    writeFileSync(
      join(projectsDir, '-project-b', `${sessionId}.jsonl`),
      assistantLine(42, 17) + '\n',
    )

    const result = await claudeSessionJsonlAdapter(sessionId, projectsDir)
    expect(result!.inputTokens).toBe(42)
    expect(result!.outputTokens).toBe(17)
  })
})

// ── codexPtyLogAdapter ────────────────────────────────────────────────────────

describe('codexPtyLogAdapter', () => {
  it('returns empty totals when the log file does not exist', async () => {
    const result = await codexPtyLogAdapter('/tmp/does-not-exist-codex.log')
    expect(result).toEqual(emptyUsageTotals())
  })

  it('parses a codex usage line and returns correct totals', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'session.log')
    // Codex CLI usage format: "Usage: X tokens (input: A, output: B, cached: C, ...)"
    writeFileSync(logPath, [
      'Working on task...',
      'Usage: 4,503 tokens (input: 3,892, output: 611, cached: 0, reasoning: 0)',
      '',
    ].join('\n'))

    const result = await codexPtyLogAdapter(logPath)
    expect(result.inputTokens).toBe(3892)
    expect(result.outputTokens).toBe(611)
    expect(result.cacheReadTokens).toBe(0)
  })

  it('parses codex usage with thousands separators', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'session2.log')
    writeFileSync(
      logPath,
      'Usage: 12,000 tokens (input: 10,000, output: 2,000, cached: 500, reasoning: 0)\n',
    )

    const result = await codexPtyLogAdapter(logPath)
    expect(result.inputTokens).toBe(10000)
    expect(result.outputTokens).toBe(2000)
    expect(result.cacheReadTokens).toBe(500)
  })

  it('strips ANSI escape codes before parsing', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'ansi.log')
    // Line with ANSI color codes around the usage text
    const ansiLine =
      '\x1b[32mUsage: 100 tokens (input: 80, output: 20, cached: 0, reasoning: 0)\x1b[0m'
    writeFileSync(logPath, ansiLine + '\n')

    const result = await codexPtyLogAdapter(logPath)
    expect(result.inputTokens).toBe(80)
    expect(result.outputTokens).toBe(20)
  })

  it('returns empty totals when no usage line is present', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'no-usage.log')
    writeFileSync(logPath, 'Working on task...\nDone!\n')

    const result = await codexPtyLogAdapter(logPath)
    expect(result).toEqual(emptyUsageTotals())
  })
})

// ── geminiPtyLogAdapter ───────────────────────────────────────────────────────

describe('geminiPtyLogAdapter', () => {
  it('returns empty totals when the log file does not exist', async () => {
    const result = await geminiPtyLogAdapter('/tmp/does-not-exist-gemini.log')
    expect(result).toEqual(emptyUsageTotals())
  })

  it('parses a gemini token usage line (input= output= format)', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'gemini.log')
    writeFileSync(logPath, [
      'Thinking...',
      'Token usage: input=1000 output=234',
      '',
    ].join('\n'))

    const result = await geminiPtyLogAdapter(logPath)
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(234)
  })

  it('parses a gemini tokens: X (input: A, output: B) format', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'gemini2.log')
    writeFileSync(logPath, 'tokens: 1,234 (input: 1,000, cached: 50, output: 184)\n')

    const result = await geminiPtyLogAdapter(logPath)
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(184)
    expect(result.cacheReadTokens).toBe(50)
  })

  it('strips ANSI escape codes before parsing', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'gemini-ansi.log')
    const ansiLine = '\x1b[1mToken usage: input=500 output=100\x1b[0m'
    writeFileSync(logPath, ansiLine + '\n')

    const result = await geminiPtyLogAdapter(logPath)
    expect(result.inputTokens).toBe(500)
    expect(result.outputTokens).toBe(100)
  })

  it('returns empty totals when no usage line is present', async () => {
    const dir = makeTmpDir()
    const logPath = join(dir, 'no-usage-gemini.log')
    writeFileSync(logPath, 'Processing...\nDone!\n')

    const result = await geminiPtyLogAdapter(logPath)
    expect(result).toEqual(emptyUsageTotals())
  })
})

// ── resolveUsage dispatch ─────────────────────────────────────────────────────

describe('resolveUsage dispatch', () => {
  it('uses in-memory conversation for claude when conversation is non-empty', async () => {
    const conversation = [
      {
        type: 'assistant',
        message: {
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [],
        },
      },
    ]

    const result = await resolveUsage({
      conversation,
      sessionId: null,
      cwd: '/tmp',
      provider: 'claude',
      semantics: 'per-request',
    })

    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
    expect(result.messageCount).toBe(1)
  })

  it('reads the terminal turn.completed usage for a cumulative provider', async () => {
    // The zero-row defect: codex carries usage ONLY here, so reading the
    // assistant shape (as every caller used to) returned zeros for every run.
    const result = await resolveUsage({
      conversation: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        {
          type: 'result',
          is_error: false,
          usage: {
            input_tokens: 31_864,
            cached_input_tokens: 25_088,
            cache_write_input_tokens: 0,
            output_tokens: 118,
            reasoning_output_tokens: 0,
          },
        },
      ],
      sessionId: null,
      cwd: '/tmp',
      provider: 'codex',
      semantics: 'cumulative',
    })

    expect(result.inputTokens).toBe(6_776)
    expect(result.cacheReadTokens).toBe(25_088)
    expect(result.outputTokens).toBe(118)
    expect(result.messageCount).toBe(1)
  })

  it('falls back to the codex PTY log only when the stream carried no usage', async () => {
    const dir = makeTmpDir()
    const sessionId = 'codex-sess-fallback'
    const logDir = join(dir, '.mars', 'pty')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, `${sessionId}.log`),
      'Usage: 1,000 tokens (input: 800, output: 200, cached: 0, reasoning: 0)\n',
    )

    // A stream WITH usage wins over the log — no double source of truth.
    const fromStream = await resolveUsage({
      conversation: [{ type: 'result', is_error: false, usage: { input_tokens: 40, output_tokens: 2 } }],
      sessionId,
      cwd: dir,
      provider: 'codex',
      semantics: 'cumulative',
    })
    expect(fromStream.inputTokens).toBe(40)
    expect(fromStream.outputTokens).toBe(2)
  })

  it('routes codex to PTY log adapter', async () => {
    const dir = makeTmpDir()
    const sessionId = 'codex-sess'
    const logDir = join(dir, '.mars', 'pty')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, `${sessionId}.log`),
      'Usage: 1,000 tokens (input: 800, output: 200, cached: 0, reasoning: 0)\n',
    )

    const result = await resolveUsage({
      conversation: [],
      sessionId,
      cwd: dir,
      provider: 'codex',
      semantics: 'cumulative',
    })

    expect(result.inputTokens).toBe(800)
    expect(result.outputTokens).toBe(200)
  })

  it('routes gemini to PTY log adapter', async () => {
    const dir = makeTmpDir()
    const sessionId = 'gemini-sess'
    const logDir = join(dir, '.mars', 'pty')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, `${sessionId}.log`),
      'Token usage: input=600 output=150\n',
    )

    const result = await resolveUsage({
      conversation: [],
      sessionId,
      cwd: dir,
      provider: 'gemini',
      semantics: 'none',
    })

    expect(result.inputTokens).toBe(600)
    expect(result.outputTokens).toBe(150)
  })

  it('returns empty totals when provider is codex but sessionId is null', async () => {
    const result = await resolveUsage({
      conversation: [],
      sessionId: null,
      cwd: '/tmp',
      provider: 'codex',
      semantics: 'cumulative',
    })
    expect(result).toEqual(emptyUsageTotals())
  })

  it('returns empty totals when provider is claude, conversation is empty, and sessionId is null', async () => {
    const result = await resolveUsage({
      conversation: [],
      sessionId: null,
      cwd: '/tmp',
      provider: 'claude',
      semantics: 'per-request',
    })
    expect(result).toEqual(emptyUsageTotals())
  })
})
