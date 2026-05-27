/**
 * Agent runtimes.
 *
 * Steps that drive a coding agent depend on the `AgentRuntime` interface,
 * never on a specific binary. The engine itself knows nothing about agents
 * — a workflow function pulls a runtime out of the `services` it was given
 * and streams whatever the runtime yields.
 *
 * Two shapes were specced (`HeadlessRuntime` for `claude -p`, `TmuxRuntime`
 * for interactive panes). The interface is the load-bearing part; a minimal
 * `HeadlessRuntime` skeleton ships here. The tmux variant is intentionally
 * left for a later slice.
 */

/** Options handed to a single agent run. */
export interface AgentRunOptions {
  /** Working directory for the agent process (e.g. a git worktree). */
  cwd: string;
  /** Abort signal propagated from the workflow run. */
  signal?: AbortSignal;
  /** Extra argv appended after the runtime's own default args. */
  extraArgs?: string[];
}

/**
 * The runtime-agnostic contract a step depends on. An implementation
 * launches an agent for `prompt` and yields its events one at a time;
 * events are opaque to the engine (`unknown`).
 */
export interface AgentRuntime {
  run(prompt: string, options: AgentRunOptions): AsyncIterable<unknown>;
}

/** Construction options for {@link HeadlessRuntime}. */
export interface HeadlessRuntimeOptions {
  /** Executable to spawn, e.g. `'claude'`. */
  binary: string;
  /** Args inserted before the prompt on every run (e.g. model flags). */
  defaultArgs?: string[];
}

/**
 * Minimal headless runtime skeleton: spawns `binary` with `-p <prompt>` and
 * yields parsed stream-json lines. Deliberately thin — it establishes the
 * shape without over-building. Process spawning is wired lazily so this
 * module imports cleanly in environments where the binary is absent.
 */
export class HeadlessRuntime implements AgentRuntime {
  constructor(private readonly opts: HeadlessRuntimeOptions) {}

  async *run(prompt: string, options: AgentRunOptions): AsyncIterable<unknown> {
    const { spawn } = await import('node:child_process');
    const args = [...(this.opts.defaultArgs ?? []), '-p', prompt, ...(options.extraArgs ?? [])];

    const child = spawn(this.opts.binary, args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          yield parseLine(line);
        }
        newline = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      yield parseLine(tail);
    }
  }
}

/** Parse one stream-json line, falling back to the raw string on error. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { raw: line };
  }
}
