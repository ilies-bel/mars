/**
 * Tests for GET /mockups/<id>.html — the UI server's static mockup route.
 *
 * The mockup workflow writes a self-contained HTML file to
 * <stateDir>/mockups/<proposalId>.html via `finalizeMockup`.  The UI server
 * then serves it under `/mockups/<id>.html` so the ProposalDetailDrawer can
 * link to it.
 *
 * These tests start a real UI server on port 0 (OS-assigned) and exercise the
 * route with `fetch`.  No daemon is needed — the route is purely file-system
 * based.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startServer } from './index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-mockup-route-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /mockups/<id>.html — serve generated mockup file', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with Content-Type text/html when the mockup file exists', async () => {
    // Write the mockup HTML to the location finalizeMockup would produce.
    const mockupsDir = resolve(repo, '.mars', 'mockups')
    mkdirSync(mockupsDir, { recursive: true })
    const HTML = '<!DOCTYPE html><html><body><h1>Mockup</h1></body></html>'
    writeFileSync(resolve(mockupsDir, 'prop-abc.html'), HTML, 'utf8')

    const res = await fetch(`${baseUrl}/mockups/prop-abc.html`)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const text = await res.text()
    expect(text).toBe(HTML)
  })

  it('returns 404 when the mockup file does not exist', async () => {
    const res = await fetch(`${baseUrl}/mockups/prop-does-not-exist.html`)
    expect(res.status).toBe(404)
  })

  it('returns 400 (or 404) on a path-traversal attempt', async () => {
    // A path like /mockups/../../etc/passwd.html must not escape the mockupsDir.
    const res = await fetch(`${baseUrl}/mockups/../../etc/passwd.html`, {
      redirect: 'manual',
    })
    // Could be 400 (invalid path) or 404 (normalised path not found).
    expect([400, 404]).toContain(res.status)
  })

  it('serves different proposals from the same directory', async () => {
    const mockupsDir = resolve(repo, '.mars', 'mockups')
    mkdirSync(mockupsDir, { recursive: true })
    writeFileSync(resolve(mockupsDir, 'prop-alpha.html'), '<html>alpha</html>', 'utf8')
    writeFileSync(resolve(mockupsDir, 'prop-beta.html'), '<html>beta</html>', 'utf8')

    const [resAlpha, resBeta] = await Promise.all([
      fetch(`${baseUrl}/mockups/prop-alpha.html`),
      fetch(`${baseUrl}/mockups/prop-beta.html`),
    ])

    expect(resAlpha.status).toBe(200)
    expect(await resAlpha.text()).toBe('<html>alpha</html>')

    expect(resBeta.status).toBe(200)
    expect(await resBeta.text()).toBe('<html>beta</html>')
  })
})
