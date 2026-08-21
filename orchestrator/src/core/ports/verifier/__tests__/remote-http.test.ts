/**
 * Tests for the `remote-http` Verifier implementation
 * (`../remote-http.ts`). Runs the adapter against a REAL local HTTP server
 * (`node:http`, not a mocked `fetch`) so the transport/auth/schema paths are
 * exercised against an actual socket — the same convention
 * `scripts/verify-remote-verifier.test.mjs` uses for the standalone smoke
 * script this adapter's wire contract mirrors.
 *
 * Hermetic by construction: `createRemoteHttpVerifier()` accepts `env` +
 * `fileConfig` overrides threaded straight into `loadConfig()`, so these
 * tests never touch the live `.mars/daemon.json` or the ambient
 * `process.env` (same pattern as `config/__tests__/load.test.ts`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRemoteHttpVerifier,
  REMOTE_HTTP_ADAPTER_FAILURE_MARKER,
  remoteHttpVerifier,
} from '../remote-http'
import { getVerifier, listVerifiers, resolveVerifier } from '../registry'
import type { VerifierRunArgs } from '../types'

const BASE_ARGS: VerifierRunArgs = {
  cwd: '/tmp/mars-verify-remote-http-test',
  steps: [],
  changedFiles: ['orchestrator/src/core/ports/verifier/remote-http.ts'],
  verifyCmd: 'echo remote-http-verifier-test',
  modelAttribution: { provider: 'test-provider', model: 'test-model' },
}

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()))
  server = undefined
})

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

/** Starts `handler` on an ephemeral local port and returns its base URL. */
const startServer = (handler: RequestHandler): Promise<string> =>
  new Promise((resolvePromise) => {
    server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (address === null || typeof address !== 'object') throw new Error('server did not bind a port')
      resolvePromise(`http://127.0.0.1:${address.port}`)
    })
  })

describe('registration', () => {
  it('registers remote-http at import time', () => {
    expect(listVerifiers().map((impl) => impl.kind)).toContain('remote-http')
    expect(getVerifier('remote-http')).toBe(remoteHttpVerifier)
  })

  it('is selectable by config via resolveVerifier', () => {
    expect(resolveVerifier({ MARS_VERIFIER_KIND: 'remote-http' })).toBe(remoteHttpVerifier)
  })
})

describe('config knobs', () => {
  it('reads the endpoint URL, auth token and timeout from env — not ad-hoc, through loadConfig()', async () => {
    let receivedAuth: string | undefined
    const url = await startServer((req, res) => {
      receivedAuth = req.headers['authorization']
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ passed: true, verdict: 'PASS', steps: [] }))
    })

    const verifier = createRemoteHttpVerifier({
      fileConfig: {},
      env: {
        MARS_VERIFIER_REMOTE_URL: url,
        MARS_VERIFIER_REMOTE_TOKEN: 'right-token',
        MARS_VERIFIER_REMOTE_TIMEOUT_MS: '5000',
      },
    })
    const result = await verifier.run(BASE_ARGS)

    expect(result).toEqual({ passed: true, verdict: 'PASS', steps: [] })
    expect(receivedAuth).toBe('Bearer right-token')
  })

  it('fails with a distinguishable reason when the URL knob is unconfigured', async () => {
    const verifier = createRemoteHttpVerifier({ fileConfig: {}, env: {} })
    const result = await verifier.run(BASE_ARGS)

    expect(result.passed).toBe(false)
    expect(result.verdict).toBe('FAIL')
    expect(result.steps[0]?.output).toContain(REMOTE_HTTP_ADAPTER_FAILURE_MARKER)
    expect(result.steps[0]?.output).toContain('MARS_VERIFIER_REMOTE_URL')
  })
})

describe('a failing remote verify fails identically to a local failure', () => {
  it('propagates a remote FAIL verdict unchanged', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          passed: false,
          verdict: 'FAIL',
          steps: [{ name: 'typecheck', passed: false, output: 'error TS2307' }],
        }),
      )
    })

    const verifier = createRemoteHttpVerifier({ fileConfig: {}, env: { MARS_VERIFIER_REMOTE_URL: url } })
    const result = await verifier.run(BASE_ARGS)

    // Same shape a local verify failure produces: passed=false, verdict=FAIL,
    // the failing step's name/output carried through untouched. A caller
    // that only branches on `result.passed`/`result.verdict` (the
    // task-verify gate) cannot tell this apart from a local failure.
    expect(result).toEqual({
      passed: false,
      verdict: 'FAIL',
      steps: [{ name: 'typecheck', passed: false, output: 'error TS2307' }],
    })
  })
})

describe('a network error surfaces as a verify failure, not a crash', () => {
  it('resolves (does not throw) when nothing is listening on the target port', async () => {
    const verifier = createRemoteHttpVerifier({
      fileConfig: {},
      env: { MARS_VERIFIER_REMOTE_URL: 'http://127.0.0.1:1/verify' },
    })

    await expect(verifier.run(BASE_ARGS)).resolves.toMatchObject({
      passed: false,
      verdict: 'FAIL',
    })
    const result = await verifier.run(BASE_ARGS)
    expect(result.steps[0]?.output).toContain(REMOTE_HTTP_ADAPTER_FAILURE_MARKER)
    expect(result.steps[0]?.output).toContain('network error')
  })

  it('resolves with a distinguishable reason on a non-2xx response', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
    })

    const verifier = createRemoteHttpVerifier({ fileConfig: {}, env: { MARS_VERIFIER_REMOTE_URL: url } })
    const result = await verifier.run(BASE_ARGS)

    expect(result.passed).toBe(false)
    expect(result.verdict).toBe('FAIL')
    expect(result.steps[0]?.output).toContain(REMOTE_HTTP_ADAPTER_FAILURE_MARKER)
    expect(result.steps[0]?.output).toContain('500')
  })

  it('resolves with a distinguishable reason when the response body is not valid JSON', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('not json')
    })

    const verifier = createRemoteHttpVerifier({ fileConfig: {}, env: { MARS_VERIFIER_REMOTE_URL: url } })
    const result = await verifier.run(BASE_ARGS)

    expect(result.passed).toBe(false)
    expect(result.steps[0]?.output).toContain(REMOTE_HTTP_ADAPTER_FAILURE_MARKER)
  })

  it('resolves with a distinguishable reason when the response body does not match VerifierRunResult', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })

    const verifier = createRemoteHttpVerifier({ fileConfig: {}, env: { MARS_VERIFIER_REMOTE_URL: url } })
    const result = await verifier.run(BASE_ARGS)

    expect(result.passed).toBe(false)
    expect(result.steps[0]?.output).toContain(REMOTE_HTTP_ADAPTER_FAILURE_MARKER)
    expect(result.steps[0]?.output).toContain('VerifierRunResult')
  })
})
