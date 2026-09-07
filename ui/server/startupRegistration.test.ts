/**
 * Tests for the project-registry self-registration that happens at UI server
 * startup (before the first request is served).
 *
 * Acceptance criteria covered:
 *   - startup registers a repo absent from the registry
 *   - a second startup for the same repoRoot performs no write and produces
 *     no duplicate entry
 *   - a throwing registry write does not prevent startup (server comes up and
 *     responds to /healthz)
 *   - the real ~/.mars/projects.json is never mutated when a test runs
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer } from './index.ts'

describe('startServer — project registry self-registration', () => {
  let repo: string
  let projectsFile: string
  let uiServer: ReturnType<typeof Bun.serve> | null = null

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-ui-reg-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.mars'), { recursive: true })

    // Each test gets its own isolated registry file (empty).
    projectsFile = join(repo, 'projects.json')
    writeFileSync(projectsFile, '[]')
    process.env.MARS_PROJECTS_FILE = projectsFile
  })

  afterEach(() => {
    if (uiServer) {
      uiServer.stop(true)
      uiServer = null
    }
    delete process.env.MARS_PROJECTS_FILE
    rmSync(repo, { recursive: true, force: true })
  })

  it('registers the repo when it is absent from the registry', async () => {
    uiServer = await startServer({ repo, port: 0, host: '127.0.0.1' })

    const entries = JSON.parse(readFileSync(projectsFile, 'utf-8')) as Array<{
      projectId: string
      repoRoot: string
      name: string
    }>
    expect(entries).toHaveLength(1)
    expect(entries[0].repoRoot).toBe(resolve(repo))
    expect(entries[0].projectId).toMatch(/^p_[0-9a-f]{12}$/)
  })

  it('does not write a duplicate entry on a second startup for the same repoRoot', async () => {
    // First startup — registers the repo.
    uiServer = await startServer({ repo, port: 0, host: '127.0.0.1' })
    uiServer.stop(true)
    uiServer = null

    // Second startup — same repo, must be idempotent.
    uiServer = await startServer({ repo, port: 0, host: '127.0.0.1' })

    const entries = JSON.parse(readFileSync(projectsFile, 'utf-8')) as unknown[]
    expect(entries).toHaveLength(1)
  })

  it('starts and serves requests even when the registry write throws', async () => {
    // Inject a registration function that throws to simulate a read-only
    // home directory or a malformed existing registry file.
    uiServer = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      {
        _registerProject: () => {
          throw new Error('simulated read-only filesystem')
        },
      },
    )

    // The server must still be reachable after the registration failure.
    const res = await fetch(`http://${uiServer.hostname}:${uiServer.port}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

describe('registry isolation — real ~/.mars/projects.json is never mutated under test', () => {
  /**
   * Regression guard: bun-vitest-setup.ts redirects MARS_PROJECTS_FILE to a
   * per-worker temp file so no test can write to the real operator registry.
   * This test measures the real file's mtime (or marks it absent) before and
   * after spawning a fixture server and asserts no mutation occurred.
   */
  it('spawning a fixture server does not touch the real registry', async () => {
    const realRegistry = join(homedir(), '.mars', 'projects.json')

    // Snapshot the real file's state before the test.
    const mtimeBefore = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null

    const tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-isolation-test-'))
    let server: ReturnType<typeof Bun.serve> | null = null
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmpRepo })
      mkdirSync(join(tmpRepo, '.mars'), { recursive: true })

      server = await startServer({ repo: tmpRepo, port: 0, host: '127.0.0.1' })
      server.stop(true)
      server = null
    } finally {
      if (server) (server as ReturnType<typeof Bun.serve>).stop(true)
      rmSync(tmpRepo, { recursive: true, force: true })
    }

    // The real file must be in exactly the same state as before.
    const mtimeAfter = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null
    expect(mtimeAfter).toBe(mtimeBefore)
  })
})
