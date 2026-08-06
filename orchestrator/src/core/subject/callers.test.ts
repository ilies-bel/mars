/**
 * callers.test.ts — architecture guard and behaviour tests for openSubject().
 *
 * ## Architecture invariant
 *
 * openSubject() is the single validated insertion point for new Subjects. To
 * keep that guarantee enforceable, exactly ONE non-test source file may call
 * it: orchestrator/src/core/subject/card-action.ts (the Card-action module).
 * Any other call site is a constraint violation.
 *
 * The grep-level test below enforces this rule statically, so a future PR that
 * accidentally calls openSubject() directly from a UI handler or an HTTP
 * endpoint will fail CI before it reaches review.
 *
 * ## Behaviour tests
 *
 * The two companion tests verify the database contract:
 *
 *   send free text → 0 new Subject rows
 *   Card action    → exactly 1 Subject row with the Card's objective and
 *                    terminal_condition
 *
 * A "Subject" is defined as a chat_threads row whose terminal_condition column
 * is non-empty. createThread() (the free-text path) never writes
 * terminal_condition, so the column stays at its NOT NULL DEFAULT ''. Only
 * openSubject() writes a non-empty value, so the invariant is observable
 * purely through that column.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ── Type stubs for dynamically-imported modules ──────────────────────────────

interface CardActionModule {
  openSubjectFromCard: typeof import('./card-action').openSubjectFromCard
  CardOpenInput: unknown
}

interface ChatStoreModule {
  createThread: typeof import('../lib/chat-store').createThread
}

interface QueueModule {
  ensureQueueSchema: typeof import('../queue').ensureQueueSchema
}

interface DbClient {
  execute: (sql: string | { sql: string; args?: unknown[] }) => Promise<{ rows: unknown[] }>
}

interface StateClientModule {
  resolveStateClient: () => DbClient
}

// ── Test helpers ─────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-callers-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  cardAction: CardActionModule
  chatStore: ChatStoreModule
  stateClient: StateClientModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../queue.js')) as unknown as QueueModule
  await queue.ensureQueueSchema()
  const [cardAction, chatStore, stateClient] = await Promise.all([
    import('./card-action.js') as Promise<unknown>,
    import('../lib/chat-store.js') as Promise<unknown>,
    import('../store/state-client.js') as Promise<unknown>,
  ])
  return {
    cardAction: cardAction as CardActionModule,
    chatStore: chatStore as ChatStoreModule,
    stateClient: stateClient as StateClientModule,
  }
}

// ── Architecture test ─────────────────────────────────────────────────────────

/**
 * The path to the orchestrator src/ directory, resolved relative to where
 * vitest runs the suite (the orchestrator/ subdirectory).
 */
const SRC_DIR = resolve(process.cwd(), 'src')

/**
 * Find all TypeScript source files (excluding tests and the definition module)
 * that contain a real (non-comment) call to openSubject().
 *
 * Returns src/-relative paths (e.g. 'src/core/subject/card-action.ts').
 *
 * Two-pass approach:
 *  1. grep -rl narrows the file list cheaply.
 *  2. A line-level scan filters out comment-only references so that doc
 *     comments mentioning openSubject() in pg-schema.ts or similar files
 *     do not falsely appear as call sites.
 */
function grepOpenSubjectCallers(): string[] {
  let candidates: string[] = []
  try {
    const raw = execFileSync(
      'grep',
      ['--include=*.ts', '-rl', 'openSubject(', SRC_DIR],
      { encoding: 'utf8' },
    )
    candidates = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    // grep exits 1 when there are no matches — empty result.
    return []
  }

  return candidates
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('openSubject.ts'))
    .filter((absPath) => {
      // Keep the file only if it has at least one non-comment line that calls
      // openSubject(). This excludes doc-comment references in schema files.
      const lines = readFileSync(absPath, 'utf8').split('\n')
      return lines.some((line) => {
        const trimmed = line.trimStart()
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          line.includes('openSubject(')
        )
      })
    })
    .map((abs) => abs.slice(SRC_DIR.length - 'src'.length))
}

describe('architecture: openSubject callers', () => {
  it('only card-action.ts calls openSubject — no other non-test source may call it', () => {
    const callers = grepOpenSubjectCallers()
    expect(callers).toEqual(['src/core/subject/card-action.ts'])
  })
})

// ── Behaviour tests ───────────────────────────────────────────────────────────

describe('openSubject call-site behaviour', () => {
  let repo: string

  afterEach(() => {
    delete process.env.MARS_REPO
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('send free text via createThread inserts 0 Subject rows (terminal_condition stays empty)', async () => {
    repo = setupRepo()
    const { chatStore, stateClient } = await loadModules(repo)

    // Simulate what the main-thread message submit handler does: the user
    // types text, which is sent to an existing thread (no new Subject created).
    // createThread() is the nearest code-level proxy for "new free-text
    // conversation" — it does NOT call openSubject() and does NOT set
    // terminal_condition.
    await chatStore.createThread('some user message')

    const c = stateClient.resolveStateClient()
    const { rows } = await c.execute(
      `SELECT id FROM chat_threads WHERE id != 'main' AND terminal_condition != ''`,
    )
    // No Subjects: terminal_condition was never written with a non-empty value.
    expect(rows).toHaveLength(0)
  })

  it('Card action via openSubjectFromCard inserts exactly 1 Subject row', async () => {
    repo = setupRepo()
    const { cardAction, stateClient } = await loadModules(repo)

    await cardAction.openSubjectFromCard({
      objective: 'Ship the new login flow',
      terminal_condition: 'Login page renders correctly on all devices',
    })

    const c = stateClient.resolveStateClient()
    const { rows } = await c.execute(
      `SELECT id, objective, terminal_condition FROM chat_threads WHERE id != 'main' AND terminal_condition != ''`,
    )
    expect(rows).toHaveLength(1)
    const row = rows[0] as Record<string, unknown>
    expect(row.objective).toBe('Ship the new login flow')
    expect(row.terminal_condition).toBe('Login page renders correctly on all devices')
  })
})
