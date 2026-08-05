/**
 * Minimal Bun runtime shims for test files that use Bun.serve / Bun.write.
 *
 * The server tests (`actionQueue.test.ts`, etc.) call `startServer()` which
 * internally calls `Bun.serve`, and write test fixtures with `Bun.write`.
 * These shims map those calls to equivalent Node.js APIs so the tests run
 * unchanged under `npx vitest run`.
 *
 * Only the subset of the Bun API exercised by the server tests is shimmed
 * here. If a test exercises a Bun API not covered here, add a shim below.
 */

import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Bun.serve — creates a Node.js HTTP server that accepts Bun-style fetch
// handlers (Web API Request/Response). The returned object has the same
// interface as Bun's Server: { hostname, port, stop }.
// ---------------------------------------------------------------------------

interface BunServeOptions {
  port?: number
  hostname?: string
  idleTimeout?: number
  fetch(req: Request): Response | Promise<Response>
}

interface BunServer {
  hostname: string
  port: number
  stop(force?: boolean): void
}

const nodeBunServe = (options: BunServeOptions): Promise<BunServer> => {
  const fetchHandler = options.fetch

  const server = createServer((nodeReq, nodeRes) => {
    const chunks: Buffer[] = []
    nodeReq.on('data', (chunk: Buffer) => chunks.push(chunk))
    nodeReq.on('end', () => {
      const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : null

      const host = nodeReq.headers.host ?? 'localhost'
      const url = new URL(nodeReq.url ?? '/', `http://${host}`)

      const headers = new Headers()
      for (const [key, val] of Object.entries(nodeReq.headers)) {
        if (typeof val === 'string') headers.set(key, val)
        else if (Array.isArray(val)) val.forEach((v) => headers.append(key, v))
      }

      const requestInit: RequestInit = {
        method: nodeReq.method ?? 'GET',
        headers,
      }
      if (rawBody && rawBody.length > 0) {
        requestInit.body = rawBody
      }

      const webRequest = new Request(url.toString(), requestInit)

      Promise.resolve(fetchHandler(webRequest))
        .then(async (response) => {
          nodeRes.statusCode = response.status
          response.headers.forEach((value, key) => {
            nodeRes.setHeader(key, value)
          })
          // Stream the response body back to the Node.js response.
          if (response.body) {
            const reader = response.body.getReader()
            const pump = async (): Promise<void> => {
              const { done, value } = await reader.read()
              if (done) {
                nodeRes.end()
                return
              }
              nodeRes.write(Buffer.from(value))
              return pump()
            }
            return pump()
          }
          nodeRes.end()
        })
        .catch((err: unknown) => {
          nodeRes.statusCode = 500
          nodeRes.end(JSON.stringify({ error: String(err) }))
        })
    })
  })

  // `startServer` explicitly sets Bun's idleTimeout to zero so a long-running
  // daemon proxy request cannot make the next request reuse a socket that the
  // server has already retired. Node defaults to a five-second keep-alive
  // timeout, so honour the Bun option instead of silently changing that
  // lifecycle contract in Vitest.
  if (options.idleTimeout === 0) {
    server.keepAliveTimeout = 0
  }

  return new Promise<BunServer>((resolve, reject) => {
    const port = options.port ?? 0
    const hostname = options.hostname ?? '127.0.0.1'
    server.listen(port, hostname, () => {
      const addr = server.address() as { address: string; port: number }
      resolve({
        hostname: addr.address,
        port: addr.port,
        stop: () => {
          server.close()
        },
      })
    })
    server.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Bun.write — write a string or Uint8Array to a file path.
// ---------------------------------------------------------------------------

const nodeWrite = (path: string, content: string | Uint8Array): Promise<void> =>
  writeFile(path, content)

// ---------------------------------------------------------------------------
// Bun.file — return a minimal file-backed Blob-like object that can be used
// as a Response body. Only needed for routes that serve static files; those
// routes are not exercised by the current server test suite, so this shim
// returns a stub that carries the path for debugging purposes.
// ---------------------------------------------------------------------------

const nodeFile = (path: string): Blob => {
  try {
    const buf = readFileSync(path)
    return new Blob([buf])
  } catch {
    // File not found — return an empty blob so a Response can still be
    // constructed (the static-file handler guards existsSync before calling
    // Bun.file, so this path should never be hit in tests).
    return new Blob([])
  }
}

// ---------------------------------------------------------------------------
// Install shims as globals (only when Bun is not already the runtime).
// ---------------------------------------------------------------------------

if (typeof globalThis.Bun === 'undefined') {
  ;(globalThis as Record<string, unknown>).Bun = {
    serve: nodeBunServe,
    write: nodeWrite,
    file: nodeFile,
    argv: process.argv,
  }
}

// ---------------------------------------------------------------------------
// Project registry isolation
//
// MARS_PROJECTS_FILE — redirect the project registry away from the developer's
// real ~/.mars/projects.json. Without this, any server boot during tests
// (ensureProjectRegistered is called unconditionally on daemon/UI startup)
// writes a permanent row for a temp repo that is deleted seconds later.
//
// IMPORTANT: unconditional assignment (`=`, not `??=`). A developer's shell
// may already export MARS_PROJECTS_FILE; we must still redirect tests to a
// throwaway path so production registries are never polluted.
//
// Use process.pid for per-worker isolation in Vitest's forks pool so parallel
// workers never collide on the same file.
// ---------------------------------------------------------------------------
process.env.MARS_PROJECTS_FILE = join(tmpdir(), `mars-test-projects-${process.pid}.json`)
