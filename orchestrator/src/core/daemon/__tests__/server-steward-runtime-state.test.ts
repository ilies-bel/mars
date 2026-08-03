import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'

let capturedDeps: HttpServerDeps | undefined

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  const { EventEmitter } = await import('node:events')
  class StubServer extends EventEmitter {
    listen(_path: string, callback: () => void): this {
      callback()
      return this
    }

    close(callback: () => void): this {
      callback()
      return this
    }
  }
  return { ...actual, createServer: () => new StubServer() }
})

vi.mock('../http-server', () => ({
  startHttpServer: async (deps: HttpServerDeps) => {
    capturedDeps = deps
    return { port: 0, close: async () => {} }
  },
}))

describe('daemon steward runtime state', () => {
  let repo: string | undefined
  let stop: (() => Promise<void>) | undefined
  let exitSpy: { mockRestore: () => void } | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
    exitSpy?.mockRestore()
    exitSpy = undefined
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = undefined
    capturedDeps = undefined
    delete process.env.MARS_REPO
    delete process.env.MARS_DISABLE_DUCKDB
    delete process.env.MARS_USAGE_SAMPLE_SEC
    delete process.env.MARS_WORKER_PROVIDER
    delete process.env.MARS_CODEX_BIN
    vi.resetModules()
  })

  it('supplies live caps and dispatch pause state to the steward HTTP view', async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-steward-runtime-state-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, '.gitignore'), '.mars/\n')
    execFileSync(
      'git',
      ['-c', 'user.name=Mars Test', '-c', 'user.email=mars@example.test', 'add', '.gitignore'],
      { cwd: repo },
    )
    execFileSync(
      'git',
      ['-c', 'user.name=Mars Test', '-c', 'user.email=mars@example.test', 'commit', '-qm', 'init'],
      { cwd: repo },
    )
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    process.env.MARS_DISABLE_DUCKDB = '1'
    process.env.MARS_USAGE_SAMPLE_SEC = '3600'
    process.env.MARS_WORKER_PROVIDER = 'codex'
    process.env.MARS_CODEX_BIN = '/usr/bin/true'
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const server = await import('../server')
    const daemon = await server.startDaemon()
    stop = async () => { await daemon.stop(true) }

    expect(capturedDeps?.getStewardRuntimeState?.()).toEqual({
      liveCap: expect.any(Number),
      baselineCap: expect.any(Number),
      isPaused: false,
    })
    expect(capturedDeps?.getStewardRuntimeState?.().liveCap).toBeGreaterThanOrEqual(1)
    expect(capturedDeps?.getStewardRuntimeState?.().baselineCap).toBeGreaterThanOrEqual(1)
  })
})
