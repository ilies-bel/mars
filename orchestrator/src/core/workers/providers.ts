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

// Optional hook a Provider installs to detect completion beyond a normal
// process exit (e.g. watching stdout for a sentinel line). When present
// the orchestrator awaits it before declaring the session done.
export type ProviderDoneSignal = (handle: ProcessHandle) => Promise<void>

// Descriptor for a single agent CLI. Bundles:
//   - spawnArgv  : build the argv array used to launch the process;
//   - feedPrompt : write the task prompt into a running process handle;
//   - doneSignal : optional hook that fires when the process completes.
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
