/**
 * Tests for staleness detection and bundle provenance in the UI server.
 *
 * These tests verify the behaviours required by mars-06ea190f:
 *
 *   - When ui/dist is older than ui/src, startServer throws a "stale" error
 *     rather than silently serving the outdated bundle.
 *   - When ui/dist is newer than ui/src, startServer starts normally.
 *   - Omitting srcDir skips the staleness check (backward-compatible for tests
 *     that do not care about freshness).
 *   - /healthz reports bundleBuiltAt and servedFrom:'dist' when serving from dist.
 *   - /healthz reports servedFrom:'vite-dev' in dev mode.
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
  it('refuses to start when dist/index.html is older than src/main.ts', async () => {
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
        minimalDeps,
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

    await expect(
      startServer(
        { port: 0, host: '127.0.0.1', distDir: tmpDist, srcDir: tmpSrc },
        minimalDeps,
      ),
    ).rejects.toThrow(/stale/i)
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
