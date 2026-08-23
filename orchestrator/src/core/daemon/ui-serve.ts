import { createReadStream } from 'node:fs'
import type { ServerResponse } from 'node:http'

/**
 * Stream a static binary asset (currently: arc-qa PNG screenshots captured
 * during a behaviour-verification walk, which the UI's QA viewer displays)
 * to `res`. This is the daemon HTTP surface's one piece of static-asset
 * serving, split out from the JSON route-dispatch logic in `routes.ts` so
 * the two can evolve independently.
 *
 * The caller is responsible for resolving and validating `filePath` (path-
 * traversal checks, route matching) before calling this — this function only
 * streams bytes and maps filesystem errors onto HTTP responses.
 *
 * Response shapes are preserved byte-for-byte from the pre-split inline
 * implementation: a missing file is `404 { error: 'screenshot not found' }`;
 * any other read error is `500 { ok: false, error: <message> }`, matching
 * `sendError`'s generic fallback in routes.ts.
 */
export const streamPngAsset = (res: ServerResponse, filePath: string): void => {
  const stream = createReadStream(filePath)
  let headersSent = false
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (!headersSent) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'screenshot not found' }))
      } else {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: message }))
      }
    } else {
      res.destroy()
    }
  })
  stream.on('open', () => {
    headersSent = true
    res.writeHead(200, { 'Content-Type': 'image/png' })
    stream.pipe(res)
  })
}
