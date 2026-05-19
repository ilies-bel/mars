import { createServer, type Server } from 'node:http'
import type { RestartTaskError } from './restart-task'

export interface HttpServerDeps {
  /**
   * Called to restart a task. Should throw {@link RestartTaskError} (with
   * `code` set to `'NOT_FOUND'` or `'WRONG_STATUS'`) for known validation
   * failures; any other error is surfaced as a 500.
   */
  restartTask: (id: string) => Promise<void>
  /** Returns `true` while the daemon is accepting work (draining → `false`). */
  isAcceptingWork: () => boolean
}

export interface HttpServerHandle {
  /** The OS-assigned port the server is listening on. */
  port: number
  /** The address the server is bound to (always `'127.0.0.1'`). */
  address: string
  close: () => Promise<void>
}

/** Detect a {@link RestartTaskError} from any caller without requiring a
 * direct `instanceof` check (avoids coupling the handler to the module
 * identity). We match on the well-typed `code` field that
 * `RestartTaskError` always sets.
 */
const isRestartTaskError = (
  err: unknown,
): err is RestartTaskError & { code: 'NOT_FOUND' | 'WRONG_STATUS' } => {
  if (!(err instanceof Error)) return false
  const code = (err as Record<string, unknown>).code
  return code === 'NOT_FOUND' || code === 'WRONG_STATUS'
}

const sendJson = (
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Start a local HTTP server bound to `127.0.0.1` only. Exposes a single
 * verb:
 *
 *   POST /tasks/:id/restart
 *
 * The server uses an OS-assigned port (port 0). Callers discover the port
 * via the returned {@link HttpServerHandle}.
 */
export const startHttpServer = async (
  deps: HttpServerDeps,
): Promise<HttpServerHandle> => {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' })
      return
    }

    // Route: POST /tasks/:id/restart
    const match = req.url?.match(/^\/tasks\/([^/]+)\/restart$/)
    if (!match || !match[1]) {
      sendJson(res, 404, { ok: false, error: 'Not found' })
      return
    }

    const id = match[1]

    if (!deps.isAcceptingWork()) {
      sendJson(res, 503, {
        ok: false,
        error: 'daemon draining; new work refused',
        errorCode: 'DRAINING',
      })
      return
    }

    deps
      .restartTask(id)
      .then(() => {
        sendJson(res, 200, { ok: true })
      })
      .catch((err: unknown) => {
        if (isRestartTaskError(err)) {
          if (err.code === 'NOT_FOUND') {
            sendJson(res, 404, { ok: false, error: err.message, errorCode: 'NOT_FOUND' })
          } else {
            // WRONG_STATUS
            sendJson(res, 409, { ok: false, error: err.message, errorCode: 'WRONG_STATUS' })
          }
        } else {
          const message = err instanceof Error ? err.message : String(err)
          sendJson(res, 500, { ok: false, error: message })
        }
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Bind to 127.0.0.1 — loopback only; never reachable from another host.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('unexpected HTTP server address type after listen()')
  }

  const port = addr.port
  const address = addr.address

  return {
    port,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
