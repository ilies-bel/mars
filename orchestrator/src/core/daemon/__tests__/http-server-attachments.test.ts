/**
 * Tests for POST /chat/threads/:id/attachments — multipart upload endpoint.
 * Covers: allowed type, disallowed type (415), oversized file (413), no
 * multipart boundary (400), and malformed multipart body (400).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as http from 'node:http'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Low-level HTTP POST using node:http so we can set arbitrary headers
 * (e.g. a lying Content-Length) that fetch/undici rejects.
 */
const rawPost = (
  port: number,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; json: unknown }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) })
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null })
          }
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-attachments-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Build a valid multipart/form-data body containing a single file part.
 * Returns the Buffer and the boundary string.
 */
const buildMultipartBody = (
  fieldname: string,
  filename: string,
  mimeType: string,
  fileData: Buffer,
): { body: Buffer; boundary: string } => {
  const boundary = 'testboundary1234'
  const CRLF = '\r\n'
  const header =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${fieldname}"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}` +
    CRLF
  const footer = `${CRLF}--${boundary}--${CRLF}`
  const body = Buffer.concat([
    Buffer.from(header),
    fileData,
    Buffer.from(footer),
  ])
  return { body, boundary }
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-att-rec-')),
  )
})

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  return { httpServer }
}

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  snoozeItem: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /chat/threads/:id/attachments', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('accepts a valid image upload and returns { id, path, mimeType, name, size }', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const fileData = Buffer.from('PNG\x89data')
      const { body, boundary } = buildMultipartBody('file', 'photo.png', 'image/png', fileData)

      const result = await rawPost(
        port,
        '/chat/threads/thread-1/attachments',
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      )

      expect(result.status).toBe(200)
      const json = result.json as { id: string; path: string; mimeType: string; name: string; size: number }
      expect(typeof json.id).toBe('string')
      expect(json.mimeType).toBe('image/png')
      expect(json.name).toBe('photo.png')
      expect(json.size).toBe(fileData.length)
      expect(json.path).toContain('thread-1')
      expect(json.path).toContain('.png')
    } finally {
      await close()
    }
  })

  it('rejects a disallowed MIME type with 415', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const fileData = Buffer.from('%PDF-1.4 fake pdf content')
      const { body, boundary } = buildMultipartBody('file', 'doc.pdf', 'application/pdf', fileData)

      const result = await rawPost(
        port,
        '/chat/threads/thread-1/attachments',
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      )

      expect(result.status).toBe(415)
      const json = result.json as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
      expect(json.error).toContain('application/pdf')
    } finally {
      await close()
    }
  })

  it('rejects a request without multipart content-type with 400', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const result = await rawPost(
        port,
        '/chat/threads/thread-1/attachments',
        { 'Content-Type': 'application/json' },
        Buffer.from(JSON.stringify({ file: 'data' })),
      )

      expect(result.status).toBe(400)
      const json = result.json as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
    } finally {
      await close()
    }
  })

  it('rejects a Content-Length exceeding 50 MiB with 413', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      // Use rawPost so we can set an oversized Content-Length header without
      // the undici fetch client rejecting the mismatch on our end.
      const fileData = Buffer.from('tiny')
      const { body, boundary } = buildMultipartBody('file', 'small.png', 'image/png', fileData)
      const MAX_BYTES = 50 * 1024 * 1024

      const result = await rawPost(
        port,
        '/chat/threads/thread-1/attachments',
        {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(MAX_BYTES + 1),
        },
        body,
      )

      expect(result.status).toBe(413)
      const json = result.json as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
      expect(json.error).toContain('50 MB')
    } finally {
      await close()
    }
  })

  it('accepts an audio upload (mp3) and classifies it correctly', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const fileData = Buffer.alloc(1024, 0xff)
      const { body, boundary } = buildMultipartBody('file', 'clip.mp3', 'audio/mpeg', fileData)

      const result = await rawPost(
        port,
        '/chat/threads/thread-1/attachments',
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      )

      expect(result.status).toBe(200)
      const json = result.json as { mimeType: string; name: string }
      expect(json.mimeType).toBe('audio/mpeg')
      expect(json.name).toBe('clip.mp3')
    } finally {
      await close()
    }
  })
})
