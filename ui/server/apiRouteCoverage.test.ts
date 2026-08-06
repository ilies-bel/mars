/**
 * Route-coverage smoke tests — every /api/* path that the frontend builds
 * (ui/src/shared/api.ts + ui/src/entities/alerts/api.ts) must resolve to a
 * registered server route.
 *
 * The server returns `{ error: "no route for /api/…" }` with status 404 when a
 * path is unhandled. A 503 (daemon unavailable), 400 (missing param), or 200
 * all indicate the route IS registered. This class of test caught the
 * /api/chat/subjects → /api/chat/subthreads rename drift that broke the chat
 * composer.
 *
 * Parameterised paths use a placeholder value ("x"); the server will still
 * route to the registered handler (returning 503/400 rather than 404).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startServer } from './index.ts'

// ---------------------------------------------------------------------------
// Static list of (method, path) pairs from ui/src/shared/api.ts and
// ui/src/entities/alerts/api.ts. Update this list whenever a new /api/*
// path is added to the frontend — the test will then enforce that the server
// registers the matching route.
// ---------------------------------------------------------------------------
const FRONTEND_ROUTES: Array<{ method: string; path: string }> = [
  // Tasks & progress
  { method: 'GET', path: '/api/tasks' },
  { method: 'GET', path: '/api/progress' },
  { method: 'GET', path: '/api/proposals' },
  { method: 'GET', path: '/api/stale-worktrees' },
  { method: 'GET', path: '/api/framework-update' },
  // Action queue
  { method: 'GET',  path: '/api/action-queue' },
  { method: 'GET',  path: '/api/action-queue/history' },
  { method: 'POST', path: '/api/action-queue/dismiss' },
  { method: 'POST', path: '/api/action-queue/ack' },
  { method: 'POST', path: '/api/action-queue/resolve' },
  // KPIs
  { method: 'GET', path: '/api/kpis' },
  { method: 'GET', path: '/api/kpis/x/arcs' },
  // Projects
  { method: 'GET',  path: '/api/projects' },
  { method: 'POST', path: '/api/projects/x/start' },
  { method: 'POST', path: '/api/projects/x/restart' },
  // Release notes
  { method: 'GET',  path: '/api/release-notes' },
  { method: 'GET',  path: '/api/release-notes-cursor' },
  { method: 'POST', path: '/api/release-notes-cursor' },
  // Trace / events / origins
  { method: 'GET', path: '/api/trace-events' },
  { method: 'GET', path: '/api/origins/x' },
  // Chat threads & messages
  { method: 'GET',  path: '/api/chat/threads' },
  { method: 'POST', path: '/api/chat/threads' },
  { method: 'POST', path: '/api/chat/subthreads' },   // formerly /api/chat/subjects — the bug this test guards
  { method: 'GET',  path: '/api/chat/thread/x' },
  { method: 'GET',  path: '/api/chat/threads/x/tasks' },
  { method: 'POST', path: '/api/chat/threads/x/message' },
  { method: 'POST', path: '/api/chat/threads/x/title' },
  { method: 'POST', path: '/api/chat/threads/x/stop' },
  { method: 'POST', path: '/api/chat/threads/x/end' },
  { method: 'GET',  path: '/api/chat/conversation' },
  { method: 'GET',  path: '/api/chat/history' },
  { method: 'GET',  path: '/api/chat/config' },
  // Message feedback
  { method: 'POST', path: '/api/chat/messages/x/feedback' },
  { method: 'POST', path: '/api/chat/messages/x/feedback/clear' },
  // Codex auth
  { method: 'GET',  path: '/api/codex-auth' },
  { method: 'POST', path: '/api/codex-auth/refresh' },
  // Context rail
  { method: 'GET', path: '/api/glossary' },
  { method: 'GET', path: '/api/skills' },
  { method: 'GET', path: '/api/adrs' },
  { method: 'GET', path: '/api/project/context' },
  { method: 'GET', path: '/api/vision' },
  // Learned recipes
  { method: 'GET',    path: '/api/failure-kinds/learned-recipes' },
  { method: 'POST',   path: '/api/failure-kinds/x/recipe' },
  { method: 'DELETE', path: '/api/failure-kinds/x/recipe' },
  // Steward / wywa / auto-recipe
  { method: 'GET', path: '/api/auto-recipe-runs' },
  { method: 'GET', path: '/api/steward-ledger' },
  { method: 'GET', path: '/api/wywa-delta' },
  // Alerts
  { method: 'GET',  path: '/api/alerts' },
  { method: 'POST', path: '/api/alerts/x/thread' },
  // Levers
  { method: 'POST', path: '/api/levers/x' },
]

let repo: string
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl: string

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-route-coverage-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // No daemon — proxy routes return 503, local routes return 200/400.
  server = await startServer({ repo, port: 0, host: '127.0.0.1' })
  baseUrl = `http://${server!.hostname}:${server!.port}`
})

afterAll(() => {
  if (server) server.stop(true)
  server = null
  rmSync(repo, { recursive: true, force: true })
})

describe('API route coverage — every frontend /api/* path is registered', () => {
  for (const { method, path } of FRONTEND_ROUTES) {
    it(`${method} ${path} → not 404 "no route"`, async () => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: ['POST', 'PUT', 'DELETE'].includes(method)
          ? JSON.stringify({})
          : undefined,
      })
      // The server's catch-all unregistered-route handler returns status 404
      // with `{ error: "no route for /api/…" }`. Any other 404 body — e.g.
      // "project not found", "message id is required" — means the route IS
      // registered and the handler returned a legitimate not-found / bad-input.
      // A 503 means the route is registered and reached the daemon proxy.
      if (res.status === 404) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        expect(body.error ?? '', `${method} ${path} returned 404 with "no route" fingerprint — route is not registered`).not.toMatch(/^no route for/)
      }
    })
  }
})
