/**
 * qa-step-list.test.ts — Unit tests for generateQaStepList.
 *
 * runHeadlessProvider is stubbed via vi.mock so no network call is made.
 * collectAssistantText returns '' (making the code fall back to stdout) so
 * the mock's stdout field drives every assertion.
 *
 * Covers:
 *   - Numbered list format `1.` / `1)`
 *   - Dash format `-`
 *   - Asterisk format `*`
 *   - Empty / unparseable output → { criterion, steps: [] }
 *   - Provider throw → { criterion, steps: [] } (never throws)
 *   - Options forwarded to runHeadlessProvider (modelTier, disallowedTools)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Stub runHeadlessProvider ──────────────────────────────────────────────────

const runHeadlessProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    sessionId: null,
    conversation: [] as unknown[],
    quotaRejected: null,
  })),
)

vi.mock('../../../core/workers/providers.js', () => ({
  runHeadlessProvider: runHeadlessProviderMock,
}))

// ── Stub collectAssistantText ─────────────────────────────────────────────────
// Always returns '' so the code falls back to agentResult.stdout.

vi.mock('../../../core/lib/reflector.js', () => ({
  collectAssistantText: vi.fn((_conversation: unknown[]) => ''),
}))

// ── Import under test (after mocks are in place) ──────────────────────────────

import { generateQaStepList } from '../qa-step-list.js'

// ─────────────────────────────────────────────────────────────────────────────

describe('generateQaStepList', () => {
  const criterion = 'The operator can view a list of all open tasks.'
  const cwd = '/tmp/fake-repo'

  beforeEach(() => {
    runHeadlessProviderMock.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
  })

  // ── Return shape ────────────────────────────────────────────────────────────

  it('returns the criterion verbatim in the result', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '1. Open the app.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.criterion).toBe(criterion)
  })

  // ── Format: `1.` numbered list ──────────────────────────────────────────────

  it('parses numbered list with period marker (1. format)', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '1. Open the app home page.\n2. Click the Tasks tab.\n3. Verify the list appears.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual([
      'Open the app home page.',
      'Click the Tasks tab.',
      'Verify the list appears.',
    ])
  })

  // ── Format: `1)` numbered list ──────────────────────────────────────────────

  it('parses numbered list with parenthesis marker (1) format)', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '1) Navigate to the dashboard.\n2) Open the Tasks section.\n3) Confirm tasks are displayed.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual([
      'Navigate to the dashboard.',
      'Open the Tasks section.',
      'Confirm tasks are displayed.',
    ])
  })

  // ── Format: `-` dash list ────────────────────────────────────────────────────

  it('parses dash-prefixed list (- format)', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '- Launch the app.\n- Go to the Tasks page.\n- Check the task list is visible.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual([
      'Launch the app.',
      'Go to the Tasks page.',
      'Check the task list is visible.',
    ])
  })

  // ── Format: `*` asterisk list ────────────────────────────────────────────────

  it('parses asterisk-prefixed list (* format)', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '* Start the server.\n* Open http://localhost:3000.\n* Look for the task list.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual([
      'Start the server.',
      'Open http://localhost:3000.',
      'Look for the task list.',
    ])
  })

  // ── Empty output ─────────────────────────────────────────────────────────────

  it('returns empty steps when the LLM returns an empty string', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual([])
  })

  it('returns empty steps when the LLM returns only whitespace', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '   \n\n   ',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual([])
  })

  // ── Provider error → never throws ─────────────────────────────────────────────

  it('returns empty steps and does not throw when the provider rejects', async () => {
    runHeadlessProviderMock.mockRejectedValueOnce(new Error('network failure'))
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.criterion).toBe(criterion)
    expect(result.steps).toEqual([])
  })

  // ── Provider options ────────────────────────────────────────────────────────

  it('calls runHeadlessProvider with modelTier fast and read-only disallowedTools', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '1. Step one.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    await generateQaStepList({ criterion, cwd })
    expect(runHeadlessProviderMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd,
        modelTier: 'fast',
        disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      }),
    )
  })

  // ── Strips markers but preserves text ────────────────────────────────────────

  it('strips only the leading marker, not content inside the step', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '1. Click the "1. Overview" link in the sidebar.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual(['Click the "1. Overview" link in the sidebar.'])
  })

  // ── Mixed formats in one response ────────────────────────────────────────────

  it('handles mixed markers in a single response', async () => {
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '1. First step.\n- Second step.\n3) Third step.',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })
    const result = await generateQaStepList({ criterion, cwd })
    expect(result.steps).toEqual(['First step.', 'Second step.', 'Third step.'])
  })
})
