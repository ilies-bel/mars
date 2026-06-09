// Completion detector that scans the pty buffer for a provider-defined
// prompt-prefix appearing after a spinner-override sequence. Satisfies
// the 'prompt-scan' doneSignal kind for providers that ship without a
// status-file hook (e.g. codex, gemini).
//
// Design: purely data-event driven — fires on every onData chunk, never
// uses setInterval or an inactivity timer.

import type { PtyHandle } from '../lib/pty/spawn.js'

export interface PromptScanSpec {
  /** Fixed string that the agent shell prints when it returns to the prompt. */
  readonly promptPrefix: string
  /** Regex that matches the spinner-override/clear sequence the agent emits
   *  when it finishes a task cycle. The promptPrefix is only considered once
   *  this pattern has been seen in the accumulated buffer. */
  readonly spinnerOverride: RegExp
}

/**
 * Watches `handle.onData` events and resolves once the accumulated pty buffer
 * contains a `spinnerOverride` match followed (at any later position) by
 * `promptPrefix`.
 *
 * Rejects if `signal` is aborted before the condition is met.
 *
 * No setInterval, no quiescence / idle timer — purely data-event driven.
 */
export function watchPromptScan(
  handle: PtyHandle,
  spec: PromptScanSpec,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const onAbort = (): void => {
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    // Position in the accumulated buffer after the first spinnerOverride match.
    // -1 means the spinner has not been seen yet.
    let spinnerMatchEnd = -1

    handle.onData((): void => {
      const buf = handle.buffer()

      if (spinnerMatchEnd < 0) {
        // Search for the spinner pattern from the start of the buffer each
        // time, resetting lastIndex so global-flagged regexes behave correctly.
        spec.spinnerOverride.lastIndex = 0
        const match = spec.spinnerOverride.exec(buf)
        if (match !== null) {
          spinnerMatchEnd = match.index + match[0].length
        }
      }

      if (spinnerMatchEnd >= 0) {
        // Only look for the promptPrefix in the portion of the buffer that
        // comes after the spinner match.
        if (buf.slice(spinnerMatchEnd).includes(spec.promptPrefix)) {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
      }
    })
  })
}
