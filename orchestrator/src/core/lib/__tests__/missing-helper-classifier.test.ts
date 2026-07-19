import { describe, expect, it } from 'vitest'
import { classifyMissingHelper } from '../missing-helper-classifier'

describe('classifyMissingHelper', () => {
  // ── Positive tests — one per shape ────────────────────────────────────

  it('recognises repeated "command not found" and returns a helper key for the missing binary', () => {
    // Fixture: bash error emitted when rg is absent from PATH
    const result = classifyMissingHelper({
      reasonCode: 'COMMAND_NOT_FOUND',
      snippet: 'rg: command not found',
    })
    expect(result).not.toBeNull()
    expect(result!.helperKey).toBe('helper:rg')
    expect(result!.evidence).toContain('command not found')
  })

  it('recognises repeated identical rg+Read sweeps via MODULE_NOT_FOUND and returns the module name as helper key', () => {
    // Fixture: Node/TypeScript resolution error for a missing code-intel module
    const result = classifyMissingHelper({
      reasonCode: 'MODULE_NOT_FOUND',
      snippet:
        "Cannot find module 'codegraph-diff' or its corresponding type declarations.",
    })
    expect(result).not.toBeNull()
    expect(result!.helperKey).toBe('codegraph-diff')
    expect(result!.evidence).toContain('codegraph-diff')
  })

  it('recognises repeated bash-loop patterns described in a reflection excerpt', () => {
    // Fixture: reflection report that names a bash-loop helper gap
    const result = classifyMissingHelper(
      { reasonCode: 'UNKNOWN', snippet: '' },
      'Detected repeated bash-loop pattern across 5 tasks — missing helper: bash-loop-runner to wrap the common shell sequence.',
    )
    expect(result).not.toBeNull()
    expect(result!.helperKey).toBe('bash-loop-runner')
    expect(result!.evidence).toMatch(/missing helper/i)
  })

  // ── Negative tests — no false positives ───────────────────────────────

  it('returns null for an unknown reasonCode with no reflection', () => {
    const result = classifyMissingHelper({
      reasonCode: 'SYNTAX_ERROR',
      snippet: 'Unexpected token at line 5',
    })
    expect(result).toBeNull()
  })

  it('returns null when COMMAND_NOT_FOUND snippet contains no parseable command name', () => {
    // Empty snippet: the reasonCode is right but there is nothing to extract
    const result = classifyMissingHelper({
      reasonCode: 'COMMAND_NOT_FOUND',
      snippet: '',
    })
    expect(result).toBeNull()
  })

  it('returns null when reflection is present but contains no missing-helper pattern', () => {
    // Fixture: a benign reflection report with rg/Read mentions but no gap marker
    const result = classifyMissingHelper(
      { reasonCode: 'UNKNOWN', snippet: '' },
      'Task completed successfully with some rg searches and file reads — no issues detected.',
    )
    expect(result).toBeNull()
  })
})
