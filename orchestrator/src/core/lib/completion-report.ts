/**
 * Completion-report parsing: types and the parser.
 *
 * Extracted from workflows/primitives/shared.ts so the daemon and verify
 * primitives can import it without pulling in the full workflow-primitive tree.
 */

/** The info-string that marks the fenced completion-report block. */
export const COMPLETION_REPORT_FENCE = 'completion-report'

export type CompletionReportLine = {
  status: 'done' | 'partial' | 'blocked'
  criterion: string
  evidence: string
}

/**
 * Typed result of parsing a completion-report block from coder output.
 *
 *  - `parsed`      — block was found and every line is well-formed.
 *  - `absent`      — no completion-report fenced block was found in text.
 *  - `unparseable` — block was found but at least one line is malformed.
 */
export type CompletionReport =
  | { kind: 'parsed'; lines: CompletionReportLine[] }
  | { kind: 'absent' }
  | { kind: 'unparseable'; raw: string }

/**
 * Extract and parse the LAST completion-report fenced block in `text`.
 *
 * Total: never throws. Malformed input → typed `unparseable` result.
 */
export const parseCompletionReport = (text: string): CompletionReport => {
  try {
    const openTag = '```' + COMPLETION_REPORT_FENCE
    const lastOpen = text.lastIndexOf(openTag)
    if (lastOpen === -1) return { kind: 'absent' }

    const bodyStart = lastOpen + openTag.length
    // Closing fence is '```' on its own line after the opening tag.
    const closeIdx = text.indexOf('\n```', bodyStart)
    const raw =
      closeIdx === -1
        ? text.slice(bodyStart).trim()
        : text.slice(bodyStart, closeIdx).trim()

    if (raw.length === 0) return { kind: 'unparseable', raw: '' }

    const lines: CompletionReportLine[] = []
    for (const rawLine of raw.split('\n')) {
      const trimmed = rawLine.trim()
      if (trimmed.length === 0) continue
      // Full grammar: - [<status>] <criterion> — [evidence: ]<evidence>
      // (em dash U+2014).  The 'evidence:' keyword is OPTIONAL — some coders
      // write '- [done] <criterion> — <evidence>' without it.  Greedy (.+)
      // splits on the LAST ' — ' so criteria containing em dashes are
      // captured correctly.
      const fullMatch = trimmed.match(
        /^-\s+\[(done|partial|blocked)\]\s+(.+)\s+\u2014\s+(?:evidence:\s*)?(.+)$/,
      )
      if (fullMatch) {
        lines.push({
          status: fullMatch[1] as 'done' | 'partial' | 'blocked',
          criterion: fullMatch[2].trim(),
          evidence: fullMatch[3].trim(),
        })
        continue
      }
      // Fallback grammar: status bracket present but no ' — ' separator.
      // Parse with empty evidence rather than rejecting the whole block
      // (Postel's law).  checkEvidenceClaim('', …) falls through to the
      // "non-verifiable evidence" branch and returns { ok: true }, so this
      // cannot produce false unsubstantiated-completion failures.
      const fallbackMatch = trimmed.match(
        /^-\s+\[(done|partial|blocked)\]\s+(.+)$/,
      )
      if (fallbackMatch) {
        lines.push({
          status: fallbackMatch[1] as 'done' | 'partial' | 'blocked',
          criterion: fallbackMatch[2].trim(),
          evidence: '',
        })
      }
      // Lines matching neither regex are silently skipped.
    }

    if (lines.length === 0) return { kind: 'unparseable', raw }
    return { kind: 'parsed', lines }
  } catch {
    return { kind: 'unparseable', raw: '' }
  }
}
