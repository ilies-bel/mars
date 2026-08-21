/**
 * `local` Verifier implementation — the default binding. Runs each verify
 * step as a local subprocess by delegating to `verifyChanges`
 * (`../../lib/git/verify`), so resolving the Port and calling `run()` is
 * behaviourally identical to calling the runner directly, including its
 * trace emission, per-step timeouts, abort handling and infra-retry.
 *
 * The kind is `'local'` to match the `verifier` entry already declared in the
 * shared Port catalog (`../../config/registry.ts`, selector
 * `MARS_VERIFIER_KIND`, default `'local'`); "local subprocess" is what that
 * kind means, and the module is named for the mechanism.
 */
import { verifyChanges } from '../../lib/git/verify'
import type { Verifier, VerifierRunArgs, VerifierRunContext, VerifierRunResult } from './types'

export const localSubprocessVerifier: Verifier = {
  kind: 'local',
  async run(args: VerifierRunArgs, ctx: VerifierRunContext = {}): Promise<VerifierRunResult> {
    // Re-join the serializable request with the in-process-only extras: the
    // local runner is in-process, so it can honour all three. A remote
    // implementation would drop `ctx` and send `args` alone.
    return verifyChanges({
      ...args,
      traceCtx: ctx.traceCtx,
      signal: ctx.signal,
      onChildPid: ctx.onChildPid,
    })
  },
}
