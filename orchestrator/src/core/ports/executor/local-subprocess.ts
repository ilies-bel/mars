/**
 * `local` Executor implementation — the default binding. Runs one agent
 * invocation as a local subprocess by delegating to `runClaudeCode`
 * (`../../lib/git/claude`), so resolving the Port and calling `run()` is
 * behaviourally identical to calling the wrapper directly: same argv
 * construction, same worker env, same streaming, same timeout and
 * context-budget aborts, same quota-rejection and transport-drop detection.
 *
 * The kind is `'local'` to match the `executor` entry declared in the shared
 * Port catalog (`../../config/registry.ts`, selector `MARS_EXECUTOR_KIND`,
 * default `'local'`); "local subprocess" is what that kind means, and the
 * module is named for the mechanism — mirroring
 * `../verifier/local-subprocess.ts`.
 */
import { runClaudeCode } from '../../lib/git/claude'
import type { Executor, ExecutorRunArgs, ExecutorRunContext, RunAgentResult } from './types'

export const localSubprocessExecutor: Executor = {
  kind: 'local',
  async run(args: ExecutorRunArgs, ctx: ExecutorRunContext = {}): Promise<RunAgentResult> {
    // Re-join the serializable request with the in-process-only extras: the
    // local wrapper is in-process, so it can honour all three. A remote
    // implementation would drop `ctx` and send `args` alone.
    return runClaudeCode({
      ...args,
      onEvent: ctx.onEvent,
      externalAbort: ctx.externalAbort,
      onPid: ctx.onPid,
    })
  },
}
