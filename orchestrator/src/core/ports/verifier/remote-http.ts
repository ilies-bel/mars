/**
 * `remote-http` Verifier implementation — delegates verification to a
 * remote HTTP endpoint (e.g. a CI runner) instead of running verify steps
 * as local subprocesses. This is the adapter the module doc on
 * `../../config/registry.ts` names as consumer slice 2 ("Remote Verifier
 * adapter over HTTP"): the `remote-http` `kind` that Port catalog already
 * declares under the `verifier` entry, previously undeclared here (see the
 * `resolveVerifier` test this file's registration makes obsolete).
 *
 * Wire contract — POST the serializable {@link VerifierRunArgs} as JSON to
 * the configured endpoint, expect a {@link VerifierRunResult} JSON body
 * back. This mirrors `scripts/verify-remote-verifier.mjs`, the standalone
 * smoke script that exercises a *real* configured endpoint against the same
 * contract (transport/auth/schema) before an operator flips
 * `MARS_VERIFIER_KIND=remote-http` in production.
 *
 * Config — the endpoint URL, the auth token used to build the
 * `authorization: Bearer <token>` header, and the request timeout are
 * declared `MARS_*` knobs in the shared config registry
 * (`../../config/env-registry.ts`'s `ENV_KNOBS`, composed by
 * `../../config/load.ts`'s `loadConfig()`), not read from `process.env`
 * ad hoc here. `MARS_VERIFIER_KIND` (the Port *selector*) stays in the
 * separate Port catalog (`../../config/registry.ts`) — see that env
 * registry's module doc for why the two are split.
 *
 * Failure handling — every failure this adapter itself detects (missing
 * config, a network error, a non-2xx response, or a response body that
 * doesn't match {@link VerifierRunResult}) resolves to a `passed: false`,
 * `verdict: 'FAIL'` result carrying the {@link REMOTE_HTTP_ADAPTER_FAILURE_MARKER}
 * prefix — never a thrown error — so a caller treats it exactly like any
 * other failing verify run. A `verdict: 'FAIL'` reported *by* the remote
 * endpoint itself is passed through unchanged: the adapter does not
 * reinterpret a genuine remote failure, only its own inability to reach or
 * trust the endpoint.
 */
import type { DaemonConfigFile } from '../../daemon/config'
import { loadConfig, type MarsConfig } from '../../config/load'
import type { Verifier, VerifierRunArgs, VerifierRunContext, VerifierRunResult } from './types'

const VERIFY_VERDICTS: ReadonlySet<string> = new Set(['PASS', 'FAIL', "CAN'T-VERIFY"])

/**
 * Prefix on the synthetic step this adapter fabricates when it cannot
 * produce a genuine remote verdict — as opposed to a `FAIL` the remote
 * endpoint itself reported. Lets a caller (or a test) distinguish "the
 * remote verify ran and failed" from "the remote-http adapter itself
 * couldn't get a trustworthy answer" without parsing prose.
 */
export const REMOTE_HTTP_ADAPTER_FAILURE_MARKER = 'remote-http verifier adapter failure'

/** Single synthetic step name for every adapter-detected failure. */
const ADAPTER_STEP_NAME = 'remote-http-verifier'

const adapterFailure = (reason: string, args: VerifierRunArgs): VerifierRunResult => ({
  passed: false,
  verdict: 'FAIL',
  steps: [
    {
      name: ADAPTER_STEP_NAME,
      passed: false,
      output: `${REMOTE_HTTP_ADAPTER_FAILURE_MARKER}: ${reason}`,
    },
  ],
  modelAttribution: args.modelAttribution,
})

/** Structural check that `value` is a well-formed {@link VerifierRunResult}. */
const isVerifierRunResult = (value: unknown): value is VerifierRunResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.passed !== 'boolean') return false
  if (typeof v.verdict !== 'string' || !VERIFY_VERDICTS.has(v.verdict)) return false
  if (!Array.isArray(v.steps)) return false
  return true
}

export interface RemoteHttpVerifierOptions {
  /**
   * Env source `loadConfig()` reads the three `MARS_VERIFIER_REMOTE_*`
   * knobs from. Defaults to `process.env`; tests inject a hermetic map
   * instead (same pattern as `loadConfig()`'s own `LoadConfigOptions.env`).
   */
  env?: NodeJS.ProcessEnv
  /**
   * Forwarded to `loadConfig()`'s `fileConfig` — defaults to
   * `readDaemonConfigFile()` (reads the live `.mars/daemon.json`). Tests
   * pass `{}` so a run stays hermetic to the injected `env`.
   */
  fileConfig?: DaemonConfigFile
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Builds a `remote-http` {@link Verifier}. `../../config/load.ts`'s
 * `loadConfig()` is called fresh on every {@link Verifier.run} — not cached
 * at construction — so an operator's config-file/env change takes effect on
 * the next verify run without a process restart.
 */
export const createRemoteHttpVerifier = (opts: RemoteHttpVerifierOptions = {}): Verifier => {
  const fetchImpl = opts.fetchImpl ?? fetch

  return {
    kind: 'remote-http',

    async run(args: VerifierRunArgs, ctx: VerifierRunContext = {}): Promise<VerifierRunResult> {
      const config: MarsConfig = loadConfig({ env: opts.env, fileConfig: opts.fileConfig })
      const { remoteUrl, remoteAuthToken, remoteTimeoutMs } = config.verifier

      if (!remoteUrl) {
        return adapterFailure('MARS_VERIFIER_REMOTE_URL is not configured', args)
      }

      const controller = new AbortController()
      if (ctx.signal) {
        if (ctx.signal.aborted) controller.abort()
        else ctx.signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
      const timer = setTimeout(() => controller.abort(), remoteTimeoutMs)

      let response: Response
      try {
        response = await fetchImpl(remoteUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(remoteAuthToken ? { authorization: `Bearer ${remoteAuthToken}` } : {}),
          },
          body: JSON.stringify(args),
          signal: controller.signal,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return adapterFailure(`network error reaching ${remoteUrl}: ${message}`, args)
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        return adapterFailure(`endpoint responded HTTP ${response.status} ${response.statusText}`, args)
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return adapterFailure(`response body is not valid JSON: ${message}`, args)
      }

      if (!isVerifierRunResult(body)) {
        return adapterFailure('response body does not match VerifierRunResult', args)
      }

      return body
    },
  }
}

/** The self-registering built-in instance, bound to `process.env` and the global `fetch`. */
export const remoteHttpVerifier: Verifier = createRemoteHttpVerifier()
