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
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
