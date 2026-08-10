/**
 * Guard that every action-queue kind name referenced in CLAUDE.md docs is
 * present in the ACTION_QUEUE_KINDS registry.
 *
 * Prevents documentation drift where docs name a kind the CLI rejects,
 * sending operators to `mars action-queue list --kind <bogus>` which errors.
 *
 * Two sources are checked:
 *   1. The framework's own CLAUDE.md (repo root).
 *   2. The bundled template CLAUDE.md shipped to consumers via `mars init`.
 *
 * Extraction heuristics:
 *   - `kind \`<name>\`` / `kinds \`<name>\`` — explicit kind annotations
 *   - `--kind <name1>,<name2>` in code blocks — filter examples
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_QUEUE_KINDS } from '../../core/lib/action-queue-kinds'

// Paths relative to this test file's directory:
//   orchestrator/src/cli/__tests__/  →  4 levels up reaches the worktree root
const REPO_CLAUDE_MD = resolve(import.meta.dirname, '../../../..', 'CLAUDE.md')
const TMPL_CLAUDE_MD = resolve(
  import.meta.dirname,
  '../../init/templates/CLAUDE.md',
)

const VALID_KINDS = new Set(ACTION_QUEUE_KINDS)

/**
 * Extract every kind-name token explicitly referenced in the given doc text.
 *
 * Patterns searched:
 *   kind[s] `<name>`  — text annotation like "(kind `failed`)"
 *   --kind <csv>      — CLI filter flag like `--kind failed,stale-queued`
 */
function extractKindReferences(text: string): string[] {
  const found: string[] = []

  // Pattern: kind `name` or kinds `name`
  const backtickPattern = /kinds?\s+`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = backtickPattern.exec(text)) !== null) {
    found.push(...m[1].split(',').map((k) => k.trim()))
  }

  // Pattern: --kind name1,name2 (in code blocks, no backticks around names)
  const flagPattern = /--kind\s+([\w,-]+)/g
  while ((m = flagPattern.exec(text)) !== null) {
    found.push(...m[1].split(',').map((k) => k.trim()))
  }

  return found.filter(Boolean)
}

describe('action-queue kinds referenced in CLAUDE.md docs', () => {
  it('every kind named in the framework CLAUDE.md exists in the registry', () => {
    const text = readFileSync(REPO_CLAUDE_MD, 'utf8')
    const refs = extractKindReferences(text)

    expect(refs.length).toBeGreaterThan(0) // sanity: we found at least one kind reference

    const unknown = refs.filter((k) => !VALID_KINDS.has(k as (typeof ACTION_QUEUE_KINDS)[number]))
    expect(
      unknown,
      `Framework CLAUDE.md references unknown action-queue kind(s): ${unknown.join(', ')}. ` +
        `Valid kinds: ${[...VALID_KINDS].join(', ')}`,
    ).toEqual([])
  })

  it('every kind named in the bundled template CLAUDE.md exists in the registry', () => {
    const text = readFileSync(TMPL_CLAUDE_MD, 'utf8')
    const refs = extractKindReferences(text)

    expect(refs.length).toBeGreaterThan(0) // sanity: we found at least one kind reference

    const unknown = refs.filter((k) => !VALID_KINDS.has(k as (typeof ACTION_QUEUE_KINDS)[number]))
    expect(
      unknown,
      `Template CLAUDE.md references unknown action-queue kind(s): ${unknown.join(', ')}. ` +
        `Valid kinds: ${[...VALID_KINDS].join(', ')}`,
    ).toEqual([])
  })
})
