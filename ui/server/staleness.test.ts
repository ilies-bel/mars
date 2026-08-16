/**
 * Tests for staleness detection, auto-rebuild, and bundle provenance in the UI server.
 *
 * These tests verify the behaviours required by mars-06ea190f and mars-db03253f:
 *
 *   - When ui/dist is older than ui/src, startServer auto-rebuilds and serves
 *     the new bundle rather than refusing to start.
 *   - When the auto-rebuild fails, startServer rejects with a "stale" error.
 *   - When ui/dist is newer than ui/src, startServer starts normally.
 *   - Omitting srcDir skips the staleness check (backward-compatible for tests
 *     that do not care about freshness).
 *   - /healthz reports bundleBuiltAt and servedFrom:'dist' when serving from dist.
 *   - /healthz reports servedFrom:'vite-dev' in dev mode.
 *   - /rebuild returns { ok: true, action: 'fresh' } when the bundle is up to date.
 *   - /rebuild returns { ok: true, action: 'rebuilt' } and invokes the build when stale.
 *   - vite.config.ts has strictPort:true so a port collision causes a non-zero
 *     exit instead of a silent fallback to the stale prebuilt bundle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── fixtures ─────────────────────────────────────────────────────────────────

let tmpRepo: string
let tmpDist: string
let tmpSrc: string
let originalMarsRepo: string | undefined

const OLD_TIME = new Date('2026-08-05T17:24:00.000Z')
const NEW_TIME = new Date('2026-08-07T12:00:00.000Z')

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-ui-stale-repo-'))
  mkdirSync(join(tmpRepo, '.mars'), { recursive: true })
  tmpDist = mkdtempSync(resolve(tmpdir(), 'mars-ui-stale-dist-'))
  tmpSrc = mkdtempSync(resolve(tmpdir(), 'mars-ui-stale-src-'))
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
  rmSync(tmpSrc, { recursive: true, force: true })
})

// Minimal server deps that skip side-effects unrelated to this test suite.
const minimalDeps = {
  sseHeartbeatMs: 999_999,
  _registerProject: () => {},
}

// ── staleness detection ───────────────────────────────────────────────────────

describe('staleness detection', () => {
  it('auto-rebuilds when stale and build succeeds', async () => {
    // dist/index.html has an old build timestamp
    writeFileSync(join(tmpDist, 'index.html'), '<html>stale</html>')
    utimesSync(join(tmpDist, 'index.html'), OLD_TIME, OLD_TIME)

    // src/main.ts was modified after the build
    mkdirSync(join(tmpSrc, 'src'), { recursive: true })
    writeFileSync(join(tmpSrc, 'src', 'main.ts'), 'export const x = 1')
    utimesSync(join(tmpSrc, 'src', 'main.ts'), NEW_TIME, NEW_TIME)

    let buildCalled = false
    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
      { ...minimalDeps, _runBuild: async () => { buildCalled = true } },
    )
    server.stop()
    // Resolving without throwing is the assertion — and the build was invoked.
    expect(buildCalled).toBe(true)
  })

  it('rejects with a stale error when auto-rebuild fails', async () => {
    // dist/index.html has an old build timestamp
    writeFileSync(join(tmpDist, 'index.html'), '<html>stale</html>')
    utimesSync(join(tmpDist, 'index.html'), OLD_TIME, OLD_TIME)

    // src/main.ts was modified after the build
    mkdirSync(join(tmpSrc, 'src'), { recursive: true })
    writeFileSync(join(tmpSrc, 'src', 'main.ts'), 'export const x = 1')
    utimesSync(join(tmpSrc, 'src', 'main.ts'), NEW_TIME, NEW_TIME)

    await expect(
      startServer(
        { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
        { ...minimalDeps, _runBuild: async () => { throw new Error('npm run build exited with code 1') } },
      ),
    ).rejects.toThrow(/stale/i)
  })

  it('starts normally when dist/index.html is newer than all src files', async () => {
    // src/main.ts has an old mtime
    mkdirSync(join(tmpSrc, 'src'), { recursive: true })
    writeFileSync(join(tmpSrc, 'src', 'main.ts'), 'export const x = 1')
    utimesSync(join(tmpSrc, 'src', 'main.ts'), OLD_TIME, OLD_TIME)

    // dist/index.html was built after the last source change
    writeFileSync(join(tmpDist, 'index.html'), '<html>fresh</html>')
    utimesSync(join(tmpDist, 'index.html'), NEW_TIME, NEW_TIME)

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
      minimalDeps,
    )
    server.stop()
    // Resolving without throwing is the assertion.
  })

  it('skips the staleness check when srcDir is not provided', async () => {
    // dist/index.html is stale, but no srcDir → check skipped → server starts
    writeFileSync(join(tmpDist, 'index.html'), '<html>stale but no check</html>')
    utimesSync(join(tmpDist, 'index.html'), OLD_TIME, OLD_TIME)

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist }, // srcDir omitted
      minimalDeps,
    )
    server.stop()
    // Resolving without throwing is the assertion.
  })

  it('detects staleness via a nested src file, not just the directory mtime', async () => {
    // A deeply-nested source file that was touched after the last build
    mkdirSync(join(tmpSrc, 'src', 'components', 'deep'), { recursive: true })
    const deepFile = join(tmpSrc, 'src', 'components', 'deep', 'Widget.tsx')
    writeFileSync(deepFile, 'export const Widget = () => null')
    utimesSync(deepFile, NEW_TIME, NEW_TIME)

    // dist/index.html is older than the nested source file
    writeFileSync(join(tmpDist, 'index.html'), '<html></html>')
    utimesSync(join(tmpDist, 'index.html'), OLD_TIME, OLD_TIME)

    let buildCalled = false
    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
      { ...minimalDeps, _runBuild: async () => { buildCalled = true } },
    )
    server.stop()
    // The build was triggered for the deeply-nested changed file.
    expect(buildCalled).toBe(true)
  })
})

// ── bundle provenance on /healthz ─────────────────────────────────────────────

describe('bundle provenance on /healthz', () => {
  it('reports bundleBuiltAt and servedFrom:"dist" when serving from dist', async () => {
    const buildTime = new Date('2026-08-07T12:00:00.000Z')
    writeFileSync(join(tmpDist, 'index.html'), '<html></html>')
    utimesSync(join(tmpDist, 'index.html'), buildTime, buildTime)

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist },
      minimalDeps,
    )
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/healthz`)
      expect(resp.status).toBe(200)
      const body = (await resp.json()) as {
        ok: boolean
        bundleBuiltAt?: string
        servedFrom?: string
      }
      expect(body.ok).toBe(true)
      expect(body.servedFrom).toBe('dist')
      expect(body.bundleBuiltAt).toBe(buildTime.toISOString())
    } finally {
      server.stop()
    }
  })

  it('reports servedFrom:"vite-dev" in dev mode without bundleBuiltAt', async () => {
    const server = await startServer(
      { port: 0, host: '127.0.0.1', dev: true },
      minimalDeps,
    )
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/healthz`)
      expect(resp.status).toBe(200)
      const body = (await resp.json()) as {
        ok: boolean
        servedFrom?: string
        bundleBuiltAt?: string
      }
      expect(body.ok).toBe(true)
      expect(body.servedFrom).toBe('vite-dev')
      expect(body.bundleBuiltAt).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})

// ── /rebuild admin route ──────────────────────────────────────────────────────

describe('/rebuild admin route', () => {
  it('returns { action: "fresh" } when the bundle is up to date', async () => {
    mkdirSync(join(tmpSrc, 'src'), { recursive: true })
    writeFileSync(join(tmpSrc, 'src', 'main.ts'), 'export const x = 1')
    utimesSync(join(tmpSrc, 'src', 'main.ts'), OLD_TIME, OLD_TIME)

    writeFileSync(join(tmpDist, 'index.html'), '<html>fresh</html>')
    utimesSync(join(tmpDist, 'index.html'), NEW_TIME, NEW_TIME)

    const server = await startServer(
      { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
      minimalDeps,
    )
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/rebuild`, { method: 'POST' })
      expect(resp.status).toBe(200)
      const body = (await resp.json()) as { ok: boolean; action: string }
      expect(body.ok).toBe(true)
      expect(body.action).toBe('fresh')
    } finally {
      server.stop()
    }
  })

  it('returns { action: "rebuilt" } and invokes the build when stale', async () => {
    mkdirSync(join(tmpSrc, 'src'), { recursive: true })
    writeFileSync(join(tmpSrc, 'src', 'main.ts'), 'export const x = 1')
    utimesSync(join(tmpSrc, 'src', 'main.ts'), NEW_TIME, NEW_TIME)

    // dist is older than src so the rebuild should trigger
    writeFileSync(join(tmpDist, 'index.html'), '<html>stale</html>')
    utimesSync(join(tmpDist, 'index.html'), OLD_TIME, OLD_TIME)

    let buildCalled = false
    const server = await startServer(
      // srcDir omitted at startup so the server boots without a build;
      // the /rebuild route still uses it when it's provided via server rebuild.
      // Use a fresh dist that is newer than src at startup to avoid boot rebuild.
      { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
      { ...minimalDeps, _runBuild: async () => { buildCalled = true } },
    )
    // At startup src is stale → build called once already; reset for the route test.
    buildCalled = false

    // Rewind dist/index.html so the route sees staleness.
    utimesSync(join(tmpDist, 'index.html'), OLD_TIME, OLD_TIME)

    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/rebuild`, { method: 'POST' })
      expect(resp.status).toBe(200)
      const body = (await resp.json()) as { ok: boolean; action: string }
      expect(body.ok).toBe(true)
      expect(body.action).toBe('rebuilt')
      expect(buildCalled).toBe(true)
    } finally {
      server.stop()
    }
  })
})

// ── Vite port collision protection ────────────────────────────────────────────

describe('Vite port collision protection', () => {
  it('vite.config.ts has strictPort:true so a port collision is a fatal error', () => {
    // When strictPort is false (the Vite default), Vite silently moves to the
    // next free port when 5173 is taken. The Bun server then falls back to the
    // prebuilt bundle while the user's browser sees an unrelated service on
    // 5173. With strictPort:true, Vite exits non-zero when the port is occupied;
    // mars-ui.mjs propagates the exit code, so the failure is explicit.
    const viteConfig = readFileSync(join(__dirname, '..', 'vite.config.ts'), 'utf8')
    expect(viteConfig).toContain('strictPort: true')
  })
})
