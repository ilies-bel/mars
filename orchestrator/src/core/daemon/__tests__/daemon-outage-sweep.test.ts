import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface SweepModule {
  detectAndRaiseDaemonOutage: typeof import('../daemon-outage-sweep').detectAndRaiseDaemonOutage
  DAEMON_OUTAGE_KIND: typeof import('../daemon-outage-sweep').DAEMON_OUTAGE_KIND
  DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS: typeof import('../daemon-outage-sweep').DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS
}

interface StateClientModule {
  resolveStateClient: typeof import('../../store/state-client').resolveStateClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-daemon-outage-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{
  q: QueueModule
  actionQueue: ActionQueueModule
  sweep: SweepModule
  stateClient: StateClientModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const sweep = (await import('../daemon-outage-sweep')) as unknown as SweepModule
  const stateClient = (await import('../../store/state-client')) as unknown as StateClientModule
  return { q, actionQueue, sweep, stateClient }
}

/**
 * Seed a daemon_heartbeat row with the given prevGapMs and bootTs.
 * Simulates what startHeartbeatWriter does at daemon boot.
 */
const seedHeartbeat = async (
  stateClient: StateClientModule,
  prevGapMs: number,
  bootTs: Date = new Date(),
): Promise<void> => {
  const c = stateClient.resolveStateClient()
  await c.execute({
    sql: `INSERT INTO daemon_heartbeat (id, pid, boot_ts, last_beat_ts, prev_gap_ms, dispatch_uptime_ms)
          VALUES (1, $1, $2, $2, $3, 0)
          ON CONFLICT (id) DO UPDATE
            SET pid = EXCLUDED.pid,
                boot_ts = EXCLUDED.boot_ts,
                last_beat_ts = EXCLUDED.last_beat_ts,
                prev_gap_ms = EXCLUDED.prev_gap_ms,
                dispatch_uptime_ms = EXCLUDED.dispatch_uptime_ms`,
    args: [process.pid, bootTs.toISOString(), prevGapMs],
  })
}

describe('daemon-outage-sweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_DAEMON_OUTAGE_THRESHOLD_MS
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet ──────────────────────────────────────────────────────────

  it('raises a daemon-outage alert when the outage gap exceeds the threshold', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)
    const THRESHOLD_MS = sweep.DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS

    // Seed a heartbeat row with a gap well above the threshold (4.5 hours)
    const outageMs = THRESHOLD_MS * 9 // 4.5× the threshold
    await seedHeartbeat(stateClient, outageMs)

    const raised = await sweep.detectAndRaiseDaemonOutage()
    expect(raised).not.toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.title).toContain('Daemon was offline')
    expect(ours[0]?.body).toContain('daemon was offline')
    expect(ours[0]?.priority).toBe('high')
  })

  it('returns null and raises no item when the gap is below the threshold', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)

    // Gap of only 10 seconds — well below the 30-minute default threshold
    await seedHeartbeat(stateClient, 10_000)

    const raised = await sweep.detectAndRaiseDaemonOutage()
    expect(raised).toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(0)
  })

  it('returns null and raises no item when no heartbeat row exists', async () => {
    const { actionQueue, sweep } = await loadModules(repo)
    // No heartbeat row seeded — simulates first-ever daemon boot

    const raised = await sweep.detectAndRaiseDaemonOutage()
    expect(raised).toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(0)
  })

  it('returns null and raises no item when prev_gap_ms is null', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)

    // Insert a heartbeat row with NULL prev_gap_ms (clean first-boot scenario)
    const c = stateClient.resolveStateClient()
    await c.execute({
      sql: `INSERT INTO daemon_heartbeat (id, pid, boot_ts, last_beat_ts, prev_gap_ms, dispatch_uptime_ms)
            VALUES (1, $1, $2, $2, NULL, 0)`,
      args: [process.pid, new Date().toISOString()],
    })

    const raised = await sweep.detectAndRaiseDaemonOutage()
    expect(raised).toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(0)
  })

  it('deduplicates on re-detection (one row, seen_count bumped)', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)
    const THRESHOLD_MS = sweep.DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS

    await seedHeartbeat(stateClient, THRESHOLD_MS * 5)

    await sweep.detectAndRaiseDaemonOutage()
    await sweep.detectAndRaiseDaemonOutage()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.seenCount).toBeGreaterThanOrEqual(2)
  })

  it('includes strandedTaskCount in the payload', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)
    const THRESHOLD_MS = sweep.DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS

    await seedHeartbeat(stateClient, THRESHOLD_MS * 6)

    await sweep.detectAndRaiseDaemonOutage()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.payload).toHaveProperty('strandedTaskCount')
    expect(ours[0]?.payload).toHaveProperty('outageMs')
    expect(ours[0]?.payload).toHaveProperty('lastBeatAt')
    expect(ours[0]?.payload).toHaveProperty('detectedAt')
  })

  it('respects the MARS_DAEMON_OUTAGE_THRESHOLD_MS env override', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)

    // Set a custom threshold of 2 minutes (120000 ms)
    process.env.MARS_DAEMON_OUTAGE_THRESHOLD_MS = '120000'

    // Gap of 3 minutes (180000 ms) — above the custom 2-minute threshold
    await seedHeartbeat(stateClient, 180_000)

    const raised = await sweep.detectAndRaiseDaemonOutage()
    expect(raised).not.toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(1)
  })

  it('does not raise when gap is below the custom MARS_DAEMON_OUTAGE_THRESHOLD_MS', async () => {
    const { actionQueue, sweep, stateClient } = await loadModules(repo)

    // Set a custom threshold of 1 hour (3600000 ms)
    process.env.MARS_DAEMON_OUTAGE_THRESHOLD_MS = '3600000'

    // Gap of only 10 minutes (600000 ms) — below the custom 1-hour threshold
    await seedHeartbeat(stateClient, 600_000)

    const raised = await sweep.detectAndRaiseDaemonOutage()
    expect(raised).toBeNull()

    const items = await actionQueue.listActionQueueItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_OUTAGE_KIND)
    expect(ours).toHaveLength(0)
  })
})
