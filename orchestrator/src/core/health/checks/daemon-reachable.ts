/**
 * Health check: daemon HTTP API is reachable.
 *
 * Reads the daemon's published port from .mars/http.port and performs a
 * simple HTTP GET.  Any response (even a non-2xx) means the daemon process
 * is up; a connection error or a missing port file means it is not.
 *
 * Prereq: 'fs' — needs filesystem access to read the port file.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerCheck } from '../registry.js'

registerCheck({
  id: 'daemon.reachable',
  description: 'Mars daemon HTTP API is reachable',
  requires: ['fs'],
  route: 'alert',

  async run(_ctx) {
    try {
      const repoRoot = process.env.MARS_REPO ?? process.cwd()
      const portPath = join(repoRoot, '.mars', 'http.port')
      const port = (await readFile(portPath, 'utf8')).trim()
      // Any HTTP response means the process is listening.
      await fetch(`http://127.0.0.1:${port}/`)
      return { ok: true }
    } catch {
      return {
        ok: false,
        findingKey: 'daemon.unreachable',
        detail: 'Daemon HTTP API is not reachable — is the daemon running?',
      }
    }
  },
})
