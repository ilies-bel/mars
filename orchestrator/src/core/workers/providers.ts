// Provider registry — one auditable location for how a Worker spawns and
// feeds prompts to an agent CLI. Each Provider bundles the spawn argv
// builder, the prompt-feed method, and an optional done-signal hook.

import { createHash } from 'node:crypto'
import { installClaudeStopHook, waitForClaudeDone } from './claude-done-signal'

export type ProviderName = 'claude' | 'gemini' | 'codex'

// Runtime options forwarded to spawnArgv when the orchestrator launches
// a Provider process. Typed as a plain record so future slices can widen
// the shape without breaking existing call sites.
export type SpawnOpts = Readonly<Record<string, string | undefined>>

// Minimal handle to a running provider process exposed to feedPrompt and
// doneSignal. Matches the write-side of PtyHandle so the interactive harness
// can supply the concrete pty handle directly without adaptation.
export interface ProcessHandle {
  write(data: string): void
}

// Discriminated union describing how the orchestrator should detect that a
// Provider's agent has finished a task cycle.
//
//   status-file  — the agent writes a sentinel file; the orchestrator watches
//                  that path. Implemented in claude-done-signal.ts.
//   prompt-scan  — the pty buffer is scanned for a spinnerOverride sequence
//                  followed by the shell promptPrefix returning.
export interface StatusFileDoneSignal {
  readonly kind: 'status-file'
  /**
   * Watches <cwd>/.mars/pty-status/<sessionId>.json and resolves when the
   * file appears (written by the Stop hook). Rejects with an AbortError
   * when the signal fires.
   */
  wait(sessionId: string, cwd: string, signal: AbortSignal): Promise<void>
}

export interface PromptScanDoneSignal {
  readonly kind: 'prompt-scan'
  /** Fixed string the agent shell prints when it returns to the prompt. */
  readonly promptPrefix: string
  /** Regex matching the spinner-override/clear sequence the agent emits on
   *  task completion, before the prompt reappears. */
  readonly spinnerOverride: RegExp
}

export type ProviderDoneSignal = StatusFileDoneSignal | PromptScanDoneSignal

// Descriptor for a single agent CLI. Bundles:
//   - spawnArgv  : build the argv array used to launch the process;
//   - feedPrompt : write the task prompt into a running process handle;
//   - doneSignal : optional descriptor that tells the orchestrator how to
//                  detect session completion beyond a normal process exit;
//   - prepare    : optional pre-spawn setup — called with (cwd, sessionId)
//                  before the process is launched. Providers that require
//                  side-effects before the process starts (e.g. writing a
//                  Stop hook for the claude status-file done-signal) implement
//                  this; providers that need no setup omit it.
export interface Provider {
  readonly name: ProviderName
  spawnArgv(opts: SpawnOpts): readonly string[]
  feedPrompt(handle: ProcessHandle, prompt: string): Promise<void>
  readonly doneSignal?: ProviderDoneSignal
  prepare?(cwd: string, sessionId: string): void
}

// Registry of every known Provider keyed by ProviderName.
export const PROVIDERS: Readonly<Record<ProviderName, Provider>> = {
  claude: {
    name: 'claude',
    // Argv for interactive (non-headless) claude invocations under the native
    // TTY harness. No `-p` flag — the agent runs in interactive mode and
    // receives the task prompt via feedPrompt below.
    //
    // `--session-id <uuid>` starts a brand-new named session rather than
    // reopening an existing one. The previous `--resume <id>` flag opened the
    // interactive resume picker when the id was unknown to claude, causing the
    // done-signal to never fire and the run to be killed at timeout (exit 137).
    //
    // claude requires `--session-id` to be a valid RFC 4122 UUID. Orchestrator
    // task ids (e.g. "mars-586e6998") are not UUIDs, so we derive a
    // deterministic UUID v5 (SHA-1 over the DNS namespace + task-id bytes)
    // rather than storing a separate mapping. A task id that already looks like
    // a UUID is passed through unchanged.
    spawnArgv: ({ sessionId, model }: SpawnOpts): readonly string[] => {
      let sessionUUID: string | undefined
      if (sessionId) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
          // Already a valid UUID — pass through unchanged.
          sessionUUID = sessionId
        } else {
          // Derive UUID v5: SHA-1(DNS-namespace-bytes || task-id-bytes).
          const h = createHash('sha1')
            .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')) // DNS namespace
            .update(sessionId)
            .digest()
          h[6] = (h[6] & 0x0f) | 0x50 // version 5
          h[8] = (h[8] & 0x3f) | 0x80 // variant RFC 4122
          sessionUUID = [h.slice(0, 4), h.slice(4, 6), h.slice(6, 8), h.slice(8, 10), h.slice(10, 16)]
            .map((b) => b.toString('hex'))
            .join('-')
        }
      }
      return [
        'claude',
        ...(model ? ['--model', model] : []),
        ...(sessionUUID ? ['--session-id', sessionUUID] : []),
      ]
    },
    // Write the prompt into the running pty followed by the submit key
    // sequence (CR) so the interactive harness starts execution.
    // The delay between writing the prompt text and the Enter keypress is
    // required: the claude TUI must finish ingesting the pasted text before
    // the CR arrives or the Enter keypress is silently dropped and the prompt
    // sits un-submitted in the input box (observed with claude CLI 2.1.159).
    // See: github.com/Dicklesworthstone/ntm internal/tmux/session.go SendKeysWithDelay
    feedPrompt: async (handle: ProcessHandle, prompt: string): Promise<void> => {
      handle.write(prompt)
      await new Promise<void>((r) => setTimeout(r, 150))
      handle.write('\r')
    },
    // Status-file done-signal: the Stop hook installed by installClaudeStopHook
    // writes a sentinel file; waitForClaudeDone watches for it.
    doneSignal: {
      kind: 'status-file' as const,
      wait: (sessionId: string, cwd: string, signal: AbortSignal): Promise<void> =>
        waitForClaudeDone(cwd, sessionId, signal),
    },
    // Pre-spawn setup: install the Stop hook so the done-signal sentinel file
    // is written when Claude's turn ends. Must run before the process starts.
    prepare: installClaudeStopHook,
  },
  gemini: {
    name: 'gemini',
    // Argv for interactive gemini invocations under the native TTY harness.
    // No headless/pipe flag — the agent runs interactively and receives the
    // task prompt via feedPrompt below.
    spawnArgv: (_opts: SpawnOpts): readonly string[] => ['gemini'],
    // Write the prompt into the running pty followed by the submit key
    // sequence (CR) so the interactive harness starts execution.
    feedPrompt: async (handle: ProcessHandle, prompt: string): Promise<void> => {
      handle.write(prompt)
      handle.write('\r')
    },
    // Prompt-scan done-signal: the orchestrator watches the pty output buffer
    // for the gemini shell prompt returning after the spinner clears.
    doneSignal: {
      kind: 'prompt-scan' as const,
      // Gemini CLI returns to this prefix once it is ready for the next input.
      promptPrefix: '> ',
      // Braille spinner characters emitted by gemini while processing a task,
      // followed by optional whitespace / ANSI clear sequences.
      spinnerOverride: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    },
  },
  codex: {
    name: 'codex',
    // Argv for interactive codex invocations under the native TTY harness.
    // No headless/pipe flag — the agent runs interactively and receives the
    // task prompt via feedPrompt below.
    spawnArgv: ({ model }: SpawnOpts): readonly string[] => [
      'codex',
      ...(model ? ['--model', model] : []),
    ],
    // Write the prompt into the running pty followed by the submit key
    // sequence (CR) so the interactive harness starts execution.
    feedPrompt: async (handle: ProcessHandle, prompt: string): Promise<void> => {
      handle.write(prompt)
      handle.write('\r')
    },
    // Prompt-scan done-signal: the orchestrator watches the pty output buffer
    // for the codex shell prompt returning after the spinner clears.
    doneSignal: {
      kind: 'prompt-scan' as const,
      // codex CLI returns to this prefix once it is ready for the next input.
      promptPrefix: 'codex>',
      // Braille spinner characters emitted by codex while processing a task,
      // followed by a space and the rest of the spinner text up to end-of-line.
      spinnerOverride: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*$/,
    },
  },
} as const
