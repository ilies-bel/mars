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
  // Save and restore MARS_PROJECTS_FILE so this describe block never
  // clobbers the redirect established by bun-vitest-setup.ts (or --preload)
  // for the rest of the test run.
  let savedRegistryEnv: string | undefined

  beforeEach(() => {
    savedRegistryEnv = process.env.MARS_PROJECTS_FILE

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
    // Restore rather than delete: deleting removes the redirect established
    // by the test harness setup (bun-vitest-setup.ts / --preload), which
    // would cause subsequent test files in the same process to write to
    // the real ~/.mars/projects.json.
    if (savedRegistryEnv !== undefined) {
      process.env.MARS_PROJECTS_FILE = savedRegistryEnv
    } else {
      delete process.env.MARS_PROJECTS_FILE
    }
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
   * Regression guard: MARS_PROJECTS_FILE must be redirected to a throwaway
   * path before startServer() is called, both under vitest (done by
   * bun-vitest-setup.ts) and under bun test (done by this describe's own
   * beforeEach, since bun-vitest-setup.ts is not loaded by bun test).
   *
   * The test measures the real file's mtime (or notes it absent) before and
   * after spawning a fixture server, asserts no mutation occurred, and
   * confirms the fixture's write went to the redirected path instead.
   */
  let savedRegistryFile: string | undefined
  let tmpRegistry: string
  let tmpRepo: string

  beforeEach(() => {
    // Save whatever MARS_PROJECTS_FILE was (may be set by bun-vitest-setup.ts,
    // or unset when running under bare `bun test`).
    savedRegistryFile = process.env.MARS_PROJECTS_FILE
    // Redirect to an isolated throwaway file for this test.
    tmpRegistry = join(tmpdir(), `mars-isolation-test-${Date.now()}-${process.pid}.json`)
    process.env.MARS_PROJECTS_FILE = tmpRegistry

    tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-isolation-test-'))
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo })
    mkdirSync(join(tmpRepo, '.mars'), { recursive: true })
  })

  afterEach(() => {
    // Restore MARS_PROJECTS_FILE to exactly what it was before this test.
    if (savedRegistryFile !== undefined) {
      process.env.MARS_PROJECTS_FILE = savedRegistryFile
    } else {
      delete process.env.MARS_PROJECTS_FILE
    }
    rmSync(tmpRepo, { recursive: true, force: true })
  })

  it('spawning a fixture server does not touch the real registry', async () => {
    const realRegistry = join(homedir(), '.mars', 'projects.json')

    // Snapshot the real file's state before starting the server.
    const mtimeBefore = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null

    let server: ReturnType<typeof Bun.serve> | null = null
    try {
      server = await startServer({ repo: tmpRepo, port: 0, host: '127.0.0.1' })
      server.stop(true)
      server = null
    } finally {
      if (server) (server as ReturnType<typeof Bun.serve>).stop(true)
    }

    // The real file must be in exactly the same state as before the test.
    const mtimeAfter = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null
    expect(mtimeAfter).toBe(mtimeBefore)

    // The registration must have gone to the redirected temp file instead.
    expect(existsSync(tmpRegistry)).toBe(true)
    const entries = JSON.parse(readFileSync(tmpRegistry, 'utf-8')) as unknown[]
    expect(entries).toHaveLength(1)
  })
})
