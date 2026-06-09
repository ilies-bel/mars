// Provider registry — one auditable location for how a Worker spawns and
// feeds prompts to an agent CLI. Each Provider bundles the spawn argv
// builder, the prompt-feed method, and an optional done-signal hook.
//
// Currently only 'claude' is registered. Future slices will add runtimes
// that drive other CLIs or interactive harnesses; dispatch branching on
// provider is reserved for those slices — this slice is data-only.

export type ProviderName = 'claude'

// Runtime options forwarded to spawnArgv when the orchestrator launches
// a Provider process. Typed as a plain record so future slices can widen
// the shape without breaking existing call sites.
export type SpawnOpts = Readonly<Record<string, string | undefined>>

// Minimal handle to a running provider process. Exposed to feedPrompt and
// doneSignal so they can interact with the process without owning its full
// lifecycle.
export interface ProcessHandle {
  readonly stdin: NodeJS.WritableStream
}

// Discriminated union describing how the orchestrator should detect that a
// Provider's agent has finished a task cycle.
//
//   status-file  — the agent writes a sentinel file; the orchestrator polls
//                  or watches that path. (future slice)
//   prompt-scan  — the pty buffer is scanned for a spinnerOverride sequence
//                  followed by the shell promptPrefix returning.
export interface StatusFileDoneSignal {
  readonly kind: 'status-file'
  /** Absolute path the agent writes when it completes a task cycle. */
  readonly path: string
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
//                  detect session completion beyond a normal process exit.
export interface Provider {
  readonly name: ProviderName
  spawnArgv(opts: SpawnOpts): readonly string[]
  feedPrompt(handle: ProcessHandle, prompt: string): Promise<void>
  readonly doneSignal?: ProviderDoneSignal
}

// Registry of every known Provider keyed by ProviderName.
export const PROVIDERS: Readonly<Record<ProviderName, Provider>> = {
  claude: {
    name: 'claude',
    // Base argv for headless `claude -p` invocations. Callers append model,
    // effort, permission, and output-format flags on top of this.
    spawnArgv: (_opts: SpawnOpts): readonly string[] => ['claude', '-p'],
    // Write the prompt to stdin then close the write side so the process
    // sees EOF and begins execution.
    feedPrompt: (handle: ProcessHandle, prompt: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        handle.stdin.write(prompt, (err) => {
          if (err) {
            reject(err)
            return
          }
          handle.stdin.end(() => resolve())
        })
      }),
  },
} as const
