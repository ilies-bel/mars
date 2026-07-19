import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface SweepModule {
  detectAndRaiseDaemonDied: typeof import('../daemon-died-sweep').detectAndRaiseDaemonDied
  readCrashMarker: typeof import('../daemon-died-sweep').readCrashMarker
  DAEMON_DIED_ACTION_QUEUE_KIND: typeof import('../daemon-died-sweep').DAEMON_DIED_ACTION_QUEUE_KIND
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-daemon-died-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; actionQueue: ActionQueueModule; sweep: SweepModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const sweep = (await import('../daemon-died-sweep')) as unknown as SweepModule
  return { q, actionQueue, sweep }
}

describe('daemon-died-sweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet ──────────────────────────────────────────────────────────

  it('raises a daemon-died alert when a crash marker file is present', async () => {
    const { actionQueue, sweep } = await loadModules(repo)

    const crashMarkerPath = resolve(repo, '.mars', 'daemon.crash.json')
    writeFileSync(
      crashMarkerPath,
      JSON.stringify({
        pid: 12345,
        startedAt: '2026-07-19T17:33:00.000Z',
        crashDetectedAt: '2026-07-19T18:15:00.000Z',
      }),
    )

    const raised = await sweep.detectAndRaiseDaemonDied(crashMarkerPath)
    expect(raised).not.toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_DIED_ACTION_QUEUE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.title).toBe('Daemon exited unexpectedly')
    expect(ours[0]?.body).toContain('12345')
    expect(ours[0]?.body).toContain('2026-07-19T17:33:00.000Z')
  })

  it('returns null and raises no item when crash marker is absent', async () => {
    const { actionQueue, sweep } = await loadModules(repo)

    const crashMarkerPath = resolve(repo, '.mars', 'daemon.crash.json')
    // File does NOT exist

    const raised = await sweep.detectAndRaiseDaemonDied(crashMarkerPath)
    expect(raised).toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_DIED_ACTION_QUEUE_KIND)
    expect(ours).toHaveLength(0)
  })

  it('deduplicates on re-detection (one row, seen_count bumped)', async () => {
    const { actionQueue, sweep } = await loadModules(repo)

    const crashMarkerPath = resolve(repo, '.mars', 'daemon.crash.json')
    writeFileSync(
      crashMarkerPath,
      JSON.stringify({
        pid: 99,
        startedAt: '2026-07-19T10:00:00.000Z',
        crashDetectedAt: '2026-07-19T10:30:00.000Z',
      }),
    )

    await sweep.detectAndRaiseDaemonDied(crashMarkerPath)
    await sweep.detectAndRaiseDaemonDied(crashMarkerPath)

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_DIED_ACTION_QUEUE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.seenCount).toBeGreaterThanOrEqual(2)
  })

  it('readCrashMarker returns null for absent file', async () => {
    const { sweep } = await loadModules(repo)
    const result = sweep.readCrashMarker(resolve(repo, '.mars', 'does-not-exist.json'))
    expect(result).toBeNull()
  })

  it('readCrashMarker returns null for malformed JSON', async () => {
    const { sweep } = await loadModules(repo)
    const markerPath = resolve(repo, '.mars', 'bad.json')
    writeFileSync(markerPath, 'not-json')
    const result = sweep.readCrashMarker(markerPath)
    expect(result).toBeNull()
  })

  it('readCrashMarker returns null for JSON missing required fields', async () => {
    const { sweep } = await loadModules(repo)
    const markerPath = resolve(repo, '.mars', 'partial.json')
    writeFileSync(markerPath, JSON.stringify({ pid: 1 }))
    const result = sweep.readCrashMarker(markerPath)
    expect(result).toBeNull()
  })

  it('readCrashMarker parses a valid crash marker', async () => {
    const { sweep } = await loadModules(repo)
    const markerPath = resolve(repo, '.mars', 'daemon.crash.json')
    const info = {
      pid: 4242,
      startedAt: '2026-07-01T09:00:00.000Z',
      crashDetectedAt: '2026-07-01T09:45:00.000Z',
    }
    writeFileSync(markerPath, JSON.stringify(info))
    const result = sweep.readCrashMarker(markerPath)
    expect(result).toEqual(info)
  })
})
