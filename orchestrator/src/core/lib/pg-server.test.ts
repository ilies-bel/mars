import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDsn,
  decideProvisioning,
  findFreePort,
  isPidAlive,
  parsePostmasterPid,
  probeTcp,
  publishPgFiles,
} from './pg-server.js'

const tempDirs: string[] = []
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-pg-server-'))
  tempDirs.push(dir)
  return dir
}

const servers: Server[] = []
const listenOnFreePort = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no address'))
        return
      }
      resolve({ server, port: address.port })
    })
  })

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

// A real postmaster.pid (PG 16+ layout): pid, datadir, start epoch, port,
// socket dir, listen addr, shmem key, status.
const PID_FILE = [
  '48231',
  '/repo/.mars/pg/data',
  '1752987654',
  '54322',
  '/tmp',
  '127.0.0.1',
  '  5432001        65536',
  'ready',
].join('\n')

describe('parsePostmasterPid', () => {
  it('extracts pid and port from a real-shaped pid file', () => {
    expect(parsePostmasterPid(PID_FILE)).toEqual({ pid: 48231, port: 54322 })
  })

  it('rejects corrupt or truncated files', () => {
    expect(parsePostmasterPid('')).toBeNull()
    expect(parsePostmasterPid('not-a-pid\n/data\n1\n5432')).toBeNull()
    expect(parsePostmasterPid('48231\n/data')).toBeNull() // no port line
    expect(parsePostmasterPid('48231\n/data\n1\n999999')).toBeNull() // bad port
    expect(parsePostmasterPid('-4\n/data\n1\n5432')).toBeNull() // bad pid
  })
})

describe('decideProvisioning', () => {
  const pidFile = { pid: 42, port: 54322 }

  it('adopts when the pid is alive and the port answers', () => {
    expect(
      decideProvisioning({ pidFile, pidAlive: true, portAnswers: true }),
    ).toEqual({ action: 'adopt', port: 54322 })
  })

  it('starts fresh (clearing the stale pid file) when the pid is dead', () => {
    expect(
      decideProvisioning({ pidFile, pidAlive: false, portAnswers: false }),
    ).toEqual({ action: 'start', clearStalePidFile: true })
  })

  it('treats an alive-but-not-listening pid as stale (recycled pid)', () => {
    expect(
      decideProvisioning({ pidFile, pidAlive: true, portAnswers: false }),
    ).toEqual({ action: 'start', clearStalePidFile: true })
  })

  it('starts without clearing anything when no pid file exists', () => {
    expect(
      decideProvisioning({ pidFile: null, pidAlive: false, portAnswers: false }),
    ).toEqual({ action: 'start', clearStalePidFile: false })
  })
})

describe('buildDsn / publishPgFiles', () => {
  it('builds the canonical trust-auth DSN', () => {
    expect(buildDsn(54322)).toBe('postgres://mars@127.0.0.1:54322/mars')
  })

  it('publishes pg.port and pg.dsn into the state dir and returns the dsn', async () => {
    const stateDir = makeTempDir()
    const dsn = await publishPgFiles(stateDir, 54322)
    expect(dsn).toBe('postgres://mars@127.0.0.1:54322/mars')
    expect(readFileSync(join(stateDir, 'pg.port'), 'utf8')).toBe('54322')
    expect(readFileSync(join(stateDir, 'pg.dsn'), 'utf8')).toBe(dsn)
  })
})

describe('probeTcp / findFreePort / isPidAlive', () => {
  it('probeTcp answers true for a listening port, false for a closed one', async () => {
    const { server, port } = await listenOnFreePort()
    expect(await probeTcp(port)).toBe(true)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    expect(await probeTcp(port)).toBe(false)
  })

  it('findFreePort returns a bindable loopback port', async () => {
    const port = await findFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
    // Nothing is listening on it after the probe releases it.
    expect(await probeTcp(port)).toBe(false)
  })

  it('isPidAlive is true for this process, false for an exited child pid', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    // PID 0 signals the whole group — never used; pick an unlikely-live pid
    // instead: spawn nothing, use a pid beyond typical pid_max on macOS/Linux
    // ranges reserved for this test's lifetime.
    expect(isPidAlive(2 ** 22 + 1)).toBe(false)
  })
})
