#!/usr/bin/env node
/**
 * verify-remote-verifier.mjs
 *
 * Smoke-tests the `remote-http` implementation of the Verifier Port
 * (ADR-0097 "Every seam is a cordis service Port with serializable
 * contracts") against a REAL, configured endpoint. Run this once before
 * flipping `MARS_VERIFIER_KIND=remote-http` in production, and again any
 * time the remote CI runner's contract changes.
 *
 * It POSTs a synthetic VerifierRunArgs (see
 * orchestrator/src/core/ports/verifier/types.ts: VerifierRunArgs) to the
 * configured endpoint and validates the JSON response against the
 * VerifierRunResult contract — orchestrator/src/core/ports/verifier/types.ts:
 * VerifierRunResult, the Port's documented return type
 * ({passed, verdict, steps[], modelAttribution?}).
 * (The Port's types and its default `local` implementation now exist; a
 * remote-http adapter module does not yet — this script defines that
 * adapter's wire contract inline pending its landing. See the module doc on
 * orchestrator/src/core/config/registry.ts for the consumer slices that are
 * expected to fill it in.)
 *
 * Usage:
 *   node scripts/verify-remote-verifier.mjs
 *
 * Config — read through the Port config registry
 * (orchestrator/src/core/config/registry.ts: getPortRegistryEntry +
 * resolvePortKind), never via a hardcoded env var name in this script:
 *   MARS_VERIFIER_KIND          must resolve to "remote-http"
 *   MARS_VERIFIER_REMOTE_URL    the endpoint to POST the synthetic run to
 *   MARS_VERIFIER_REMOTE_TOKEN  optional bearer token
 * (the two remote env var names above are read from the registry's
 * `remote-http` implementation entry, not spelled out as literals here.)
 *
 * Exit codes:
 *   0  PASS       response received and validates against VerifierRunResult
 *   1  CONFIG     MARS_VERIFIER_KIND isn't remote-http, or its URL is unset
 *   2  TRANSPORT  the HTTP request itself failed (DNS, refused, timed out)
 *   3  AUTH       the endpoint responded 401/403
 *   4  HTTP       the endpoint responded with some other non-2xx status
 *   5  SCHEMA     2xx response, but the body isn't valid JSON / doesn't
 *                 match VerifierRunResult
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORCH_DIR = join(REPO_ROOT, 'orchestrator')
const TSX_BIN = join(ORCH_DIR, 'node_modules', '.bin', 'tsx')
const REGISTRY_MODULE = join(ORCH_DIR, 'src', 'core', 'config', 'registry.ts')
const REQUEST_TIMEOUT_MS = 15_000
const VERIFY_VERDICTS = new Set(['PASS', 'FAIL', "CAN'T-VERIFY"])

/**
 * Loads the Verifier Port's registry entry and resolved implementation kind
 * through the project's actual config loader
 * (orchestrator/src/core/config/registry.ts — getPortRegistryEntry +
 * resolvePortKind) instead of re-declaring the remote env var names here.
 *
 * Shells out via tsx: this script is a dependency-free root-level `.mjs`
 * (the repo-root `scripts/*.mjs` convention — see scripts/arch-guard.mjs)
 * and orchestrator ships TypeScript source only (`tsc --noEmit`, no
 * `dist/`) consumed exclusively via tsx, so there is no compiled JS this
 * plain script could `import` directly.
 */
function loadVerifierPortConfig(env) {
  const dir = mkdtempSync(join(tmpdir(), 'mars-verifier-config-'))
  const helperFile = join(dir, 'load-verifier-config.mts')
  const helperSrc = [
    `import { getPortRegistryEntry, resolvePortKind } from ${JSON.stringify(REGISTRY_MODULE)}`,
    `const entry = getPortRegistryEntry('verifier')`,
    `const kind = resolvePortKind('verifier', process.env)`,
    `process.stdout.write(JSON.stringify({ entry, kind }))`,
    '',
  ].join('\n')
  writeFileSync(helperFile, helperSrc, 'utf8')
  try {
    const result = spawnSync(TSX_BIN, [helperFile], {
      cwd: ORCH_DIR,
      encoding: 'utf8',
      env,
    })
    if (result.error) {
      throw new Error(`could not run the Port config loader (tsx): ${result.error.message}`)
    }
    if (result.status !== 0) {
      const lastLine = (result.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0]
      throw new Error(`Port config loader exited ${result.status}${lastLine ? `: ${lastLine}` : ''}`)
    }
    return JSON.parse(result.stdout.trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Strips embedded basic-auth credentials from a URL before it's printed. */
function redactEndpoint(rawUrl) {
  try {
    const u = new URL(rawUrl)
    if (u.username) u.username = '***'
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '<unparseable URL>'
  }
}

/**
 * The synthetic VerifierPortRequest body posted to the remote endpoint.
 * Shape mirrors VerifyPortRequest (orchestrator/src/core/lib/git/verify.ts)
 * minus the fields that fail the Port's serializable-contract test
 * (AbortSignal, PID callback, in-process trace ctx) — deliberately a no-op
 * run (empty `steps`, a harmless `verifyCmd`) since this script exists to
 * exercise the transport/auth/schema contract, not to verify real code.
 */
function buildSyntheticRequest() {
  return {
    cwd: '/tmp/mars-verify-remote-smoke',
    steps: [],
    changedFiles: ['scripts/verify-remote-verifier.mjs'],
    verifyCmd: 'echo mars-verify-remote-verifier-smoke-test',
    modelAttribution: { provider: 'mars-smoke-test', model: 'verify-remote-verifier' },
  }
}

/**
 * Validates a parsed JSON response against the VerifierRunResult contract
 * (the wire shape of VerifyResult, orchestrator/src/core/lib/git/verify.ts).
 * Plain structural checks, no schema library — this script has no
 * dependencies beyond Node builtins (repo-root `scripts/*.mjs` convention).
 */
function validateVerifierRunResult(value) {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['response body is not a JSON object'] }
  }
  if (typeof value.passed !== 'boolean') errors.push('.passed must be a boolean')
  if (!VERIFY_VERDICTS.has(value.verdict)) {
    errors.push(`.verdict must be one of ${[...VERIFY_VERDICTS].join(', ')}, got ${JSON.stringify(value.verdict)}`)
  }
  if (!Array.isArray(value.steps)) {
    errors.push('.steps must be an array')
  } else {
    value.steps.forEach((step, i) => {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) {
        errors.push(`.steps[${i}] must be an object`)
        return
      }
      if (typeof step.name !== 'string') errors.push(`.steps[${i}].name must be a string`)
      if (typeof step.passed !== 'boolean') errors.push(`.steps[${i}].passed must be a boolean`)
      if (typeof step.output !== 'string') errors.push(`.steps[${i}].output must be a string`)
    })
  }
  if (value.modelAttribution !== undefined) {
    const ma = value.modelAttribution
    if (ma === null || typeof ma !== 'object' || Array.isArray(ma)) {
      errors.push('.modelAttribution must be an object when present')
    } else {
      if (typeof ma.provider !== 'string') errors.push('.modelAttribution.provider must be a string')
      if (typeof ma.model !== 'string') errors.push('.modelAttribution.model must be a string')
    }
  }
  return { valid: errors.length === 0, errors }
}

async function main() {
  let config
  try {
    config = loadVerifierPortConfig(process.env)
  } catch (err) {
    console.error(`config: ${err.message}`)
    return 1
  }

  const { entry, kind } = config
  if (kind !== 'remote-http') {
    console.error(
      `config: MARS_VERIFIER_KIND resolved to "${kind}", not "remote-http" — ` +
        `set MARS_VERIFIER_KIND=remote-http to smoke-test the remote endpoint`,
    )
    return 1
  }

  const remoteImpl = entry.implementations.find((impl) => impl.kind === 'remote-http')
  const envVars = remoteImpl?.envVars ?? []
  const urlEnvVar = envVars.find((name) => name.includes('URL'))
  const tokenEnvVar = envVars.find((name) => name.includes('TOKEN'))

  if (!urlEnvVar) {
    console.error(
      `config: the registry's remote-http Verifier entry declares no URL env var (${JSON.stringify(remoteImpl)})`,
    )
    return 1
  }

  const rawUrl = process.env[urlEnvVar]
  if (!rawUrl) {
    console.error(`config: ${urlEnvVar} is not set — required to POST to the remote-http Verifier endpoint`)
    return 1
  }
  const token = tokenEnvVar ? process.env[tokenEnvVar] : undefined

  const redacted = redactEndpoint(rawUrl)
  console.log(`Resolved endpoint: ${redacted} (${urlEnvVar}; auth token via ${tokenEnvVar ?? 'n/a'}: ${token ? 'set' : 'not set'})`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(rawUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(buildSyntheticRequest()),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`transport: request to ${redacted} timed out after ${REQUEST_TIMEOUT_MS}ms`)
    } else {
      const cause = err.cause && (err.cause.code || err.cause.message) ? ` (${err.cause.code || err.cause.message})` : ''
      console.error(`transport: request to ${redacted} failed: ${err.message}${cause}`)
    }
    return 2
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    console.error(`auth: ${redacted} responded HTTP ${response.status} ${response.statusText}`)
    return 3
  }

  if (!response.ok) {
    console.error(`http: ${redacted} responded HTTP ${response.status} ${response.statusText}`)
    return 4
  }

  const bodyText = await response.text()
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch (err) {
    console.error(`schema: response body from ${redacted} is not valid JSON: ${err.message}`)
    return 5
  }

  const { valid, errors } = validateVerifierRunResult(parsed)
  if (!valid) {
    console.error(`schema: response from ${redacted} does not match VerifierRunResult — ${errors.join('; ')}`)
    return 5
  }

  console.log(JSON.stringify(parsed, null, 2))
  console.log(`verify-remote-verifier: PASS — verdict=${parsed.verdict} passed=${parsed.passed} steps=${parsed.steps.length}`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`unexpected: ${err && err.stack ? err.stack : err}`)
    process.exit(1)
  })
