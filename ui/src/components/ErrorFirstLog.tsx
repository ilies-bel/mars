import { useState } from 'react'

/**
 * Patterns that mark a log line as an error.
 * Order matters — evaluated top-to-bottom; first match wins.
 */
const ERROR_PATTERNS: RegExp[] = [
  /\berror TS\d+/i,   // TypeScript: "error TS2345:"
  /\berror:\s/i,      // Generic "Error: <message>" (colon + whitespace)
  /[×✗✘]/,           // Vitest / Jest failure row markers
  /\bFAIL\b/,         // Jest "FAIL" suite header
  /\bfailed\b/i,      // "1 test failed"
  /\bnot ok\b/i,      // TAP protocol: "not ok 3 - …"
]

/**
 * Patterns that mark a log line as a passing test / success note.
 * PASSING is checked after ERROR — an error pattern always wins.
 */
const PASSING_PATTERNS: RegExp[] = [
  /[✓✔]/,             // Passing test check marks (vitest, jest)
  /\bpassed\b/i,      // "N tests passed"
  /\bpassing\b/i,     // "N passing"
  /^ok\s/i,           // TAP protocol: "ok 1 - …"
  /\b0 errors\b/i,    // TypeScript: "Found 0 errors."
]

type LineKind = 'error' | 'passing' | 'neutral'

function classifyLine(line: string): LineKind {
  if (ERROR_PATTERNS.some((p) => p.test(line))) return 'error'
  if (PASSING_PATTERNS.some((p) => p.test(line))) return 'passing'
  return 'neutral'
}

interface ErrorFirstLogProps {
  /** Multi-line log output (stdout/stderr) to render errors-first. */
  log: string
  /** Optional testid forwarded to the root element. */
  'data-testid'?: string
}

/**
 * Renders a multi-line log string errors-first:
 * - Error lines are shown immediately, highlighted in error colour.
 * - Passing lines are collapsed to a count badge (expandable on click).
 * - Neutral lines are shown after the error block.
 *
 * Falls back to plain verbatim rendering when no lines match either pattern.
 *
 * Use this for verify-step stdout/stderr where thousands of passing test lines
 * would otherwise bury the handful of failures the operator cares about.
 *
 * Shared primitive — build one, reuse in every surface that shows log output.
 */
export const ErrorFirstLog = ({
  log,
  'data-testid': testId,
}: ErrorFirstLogProps) => {
  const [showPassing, setShowPassing] = useState(false)

  const errorLines: string[] = []
  const passingLines: string[] = []
  const neutralLines: string[] = []

  for (const line of log.split('\n')) {
    const kind = classifyLine(line)
    if (kind === 'error') errorLines.push(line)
    else if (kind === 'passing') passingLines.push(line)
    else if (line.trim()) neutralLines.push(line) // skip blank lines
  }

  // Fallback: plain rendering when no structure is detectable.
  if (errorLines.length === 0 && passingLines.length === 0) {
    return (
      <pre
        data-testid={testId}
        className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-1.5 font-mono text-micro text-primary"
      >
        {log}
      </pre>
    )
  }

  return (
    <div data-testid={testId} className="flex flex-col gap-1.5">
      {/* ── Summary bar ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {errorLines.length > 0 ? (
          <span
            data-testid="error-first-log-error-count"
            className="rounded border border-error/40 bg-error/10 px-1.5 py-0.5 font-mono text-micro font-semibold text-error"
          >
            {errorLines.length} error{errorLines.length !== 1 ? 's' : ''}
          </span>
        ) : null}
        {passingLines.length > 0 ? (
          <button
            type="button"
            data-testid="error-first-log-passing-toggle"
            onClick={() => setShowPassing((v) => !v)}
            aria-expanded={showPassing}
            className="rounded border border-done/30 bg-done/5 px-1.5 py-0.5 font-mono text-micro text-done hover:bg-done/10"
          >
            {passingLines.length} passing
            <span className="ml-1 text-micro" aria-hidden="true">
              {showPassing ? '▾' : '▸'}
            </span>
          </button>
        ) : null}
      </div>

      {/* ── Error lines — always visible ────────────────────────────────── */}
      {errorLines.length > 0 ? (
        <pre
          data-testid="error-first-log-errors"
          className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-error/5 p-1.5 font-mono text-micro text-error/90"
        >
          {errorLines.join('\n')}
        </pre>
      ) : null}

      {/* ── Neutral lines — shown after errors ──────────────────────────── */}
      {neutralLines.length > 0 ? (
        <pre
          data-testid="error-first-log-neutral"
          className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-1.5 font-mono text-micro text-primary"
        >
          {neutralLines.join('\n')}
        </pre>
      ) : null}

      {/* ── Passing lines — collapsed by default ────────────────────────── */}
      {showPassing && passingLines.length > 0 ? (
        <pre
          data-testid="error-first-log-passing"
          className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-done/5 p-1.5 font-mono text-micro text-done/80"
        >
          {passingLines.join('\n')}
        </pre>
      ) : null}
    </div>
  )
}
