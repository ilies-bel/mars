/**
 * Tests for static file serving in the UI server.
 *
 * These tests verify the core behaviour introduced by the mars-6743b639 fix:
 *
 *   - The server serves index.html at the root when distDir contains it.
 *   - Unknown paths fall back to index.html so SPA hash-routes survive
 *     a hard reload.
 *   - When --dev is set, the server returns 404 for non-API paths (Vite
 *     owns the frontend in dev mode; this server must not compete with it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer } from './index.ts'

// ── fixtures ──────────────────────────────────────────────────────────────

let tmpRepo: string
let tmpDist: string
let originalMarsRepo: string | undefined

beforeEach(() => {
  // Isolated repo dir so resolveRepo never runs git detection.
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-ui-static-repo-'))
  mkdirSync(join(tmpRepo, '.mars'), { recursive: true })
  // Isolated dist dir with a minimal index.html.
  tmpDist = mkdtempSync(resolve(tmpdir(), 'mars-ui-static-dist-'))
  originalMarsRepo = process.env['MARS_REPO']
  process.env['MARS_REPO'] = tmpRepo
})

afterEach(() => {
  if (originalMarsRepo === undefined) {
    delete process.env['MARS_REPO']
  } else {
    process.env['MARS_REPO'] = originalMarsRepo
  }
  rmSync(tmpRepo, { recursive: true, force: true })
  rmSync(tmpDist, { recursive: true, force: true })
})

// Common server deps that skip project registration (no DB or file-writes
// outside the isolated tmp dirs) and silence the SSE heartbeat.
const minimalDeps = {
  sseHeartbeatMs: 999_999,
  _registerProject: () => {},
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('static file serving — distDir set', () => {
  it('serves index.html at / when distDir contains it', async () => {
    writeFileSync(join(tmpDist, 'index.html'), '<html><body>Mars UI</body></html>')

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist },
      minimalDeps,
    )
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(resp.status).toBe(200)
      const body = await resp.text()
      expect(body).toContain('Mars UI')
    } finally {
      server.stop()
    }
  })

  it('falls back to index.html for an unknown path (SPA hash-route reload)', async () => {
    writeFileSync(join(tmpDist, 'index.html'), '<html><body>Mars UI SPA</body></html>')

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist },
      minimalDeps,
    )
    try {
      // Browser sends GET /chat when the user hard-reloads /#/chat
      const resp = await fetch(`http://127.0.0.1:${server.port}/chat`)
      expect(resp.status).toBe(200)
      const body = await resp.text()
      expect(body).toContain('Mars UI SPA')
    } finally {
      server.stop()
    }
  })

  it('serves existing assets from distDir with the correct Content-Type', async () => {
    writeFileSync(join(tmpDist, 'index.html'), '<html></html>')
    mkdirSync(join(tmpDist, 'assets'))
    writeFileSync(join(tmpDist, 'assets', 'app.js'), 'console.log("app")')

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist },
      minimalDeps,
    )
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/assets/app.js`)
      expect(resp.status).toBe(200)
      expect(resp.headers.get('content-type')).toContain('application/javascript')
    } finally {
      server.stop()
    }
  })
})

describe('static file serving — dev mode', () => {
  it('returns 404 for / when dev is true (Vite owns the frontend)', async () => {
    // In dev mode this server must not serve static files; Vite handles them.
    const server = await startServer(
      { port: 0, host: '127.0.0.1', dev: true },
      minimalDeps,
    )
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(resp.status).toBe(404)
    } finally {
      server.stop()
    }
  })
})
