/**
 * qa-step-list.ts — Generate a numbered plain-text QA step list for one
 * Definition-of-Done criterion.
 *
 * Given a single criterion string and a repo root, calls the fast provider
 * LLM and returns the concrete, ordinary-language moves a human (or future
 * walk agent) needs to reach and observe that behaviour. No walking, no
 * screenshots — prose steps only.
 *
 * The result is intentionally prose rather than code or selectors so a later
 * agent can re-run the steps unchanged even after the interface has moved.
 *
 * Never throws: a parseable-or-not LLM response always yields a
 * `{ criterion, steps: [] }` fallback at worst.
 */

import { runHeadlessProvider } from '../../core/workers/providers.js'
import { collectAssistantText } from '../../core/lib/reflector.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface QaStepList {
  /** The criterion verbatim. */
  criterion: string
  /**
   * Ordered list of plain-English moves needed to reach and observe that
   * behaviour. Each element is one instruction with no leading marker (e.g.
   * 'Open the app home page.', 'Click the Arcs tab.').
   */
  steps: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Regex that strips leading list markers: `1.`, `1)`, `-`, `*`. */
const LIST_MARKER_RE = /^\s*(?:\d+[.)]|-|\*)\s*/

/**
 * Split `rawText` on newlines, strip list markers from each non-empty line,
 * and return only lines that contain real content.
 */
function parseSteps(rawText: string): string[] {
  return rawText
    .split('\n')
    .map((line) => line.replace(LIST_MARKER_RE, '').trim())
    .filter((line) => line.length > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(criterion: string): string {
  return [
    'You are a QA step writer. Given one Definition-of-Done criterion for a',
    'software project, write a numbered list of the concrete moves a human tester',
    'needs to make to reach and observe that behaviour on a running app.',
    '',
    'Rules:',
    '  - Each step is one short, ordinary-language instruction (e.g. "Open the',
    '    app home page.", "Click the Arcs tab.", "Check that the counter reads 3.").',
    '  - No code, no CSS selectors, no technical jargon — just what a human does.',
    '  - Cover setup (launching the app, navigating to the right page) if needed.',
    '  - Cover the observation step (what to look for to confirm the criterion).',
    '  - Return ONLY the numbered list. No preamble, no explanation, no summary.',
    '',
    '## Criterion',
    '',
    criterion,
    '',
    'Return ONLY a numbered list of steps.',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a numbered plain-text QA step list for one DoD criterion.
 *
 * Calls the fast provider LLM (read-only tool surface). Returns
 * `{ criterion, steps: [] }` when the LLM returns nothing parseable —
 * never throws.
 */
export async function generateQaStepList(opts: {
  criterion: string
  cwd: string
}): Promise<QaStepList> {
  const { criterion, cwd } = opts

  try {
    const agentResult = await runHeadlessProvider(buildPrompt(criterion), {
      cwd,
      modelTier: 'fast',
      timeoutMs: 60_000,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    })

    const rawText =
      collectAssistantText(agentResult.conversation) || agentResult.stdout

    const steps = parseSteps(rawText)
    return { criterion, steps }
  } catch {
    // Best-effort — infrastructure or provider errors degrade to empty steps.
    return { criterion, steps: [] }
  }
}
