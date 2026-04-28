import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Feature } from '../contract/feature.ts';
import { BD_STATUS_BY_MARS, BeadsStore, MARS_STATUS_BY_BD } from './beads-store.ts';

/**
 * Probe the host to see whether `bd` is available. The integration tests in
 * this file rely on shelling out to a real `bd` binary, so when it isn't
 * present (CI without beads installed, contributor machines, etc.) we skip
 * the suite cleanly instead of failing.
 */
async function bdAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['bd', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function bdInit(cwd: string): Promise<void> {
  const proc = Bun.spawn(
    [
      'bd',
      'init',
      '--non-interactive',
      '--skip-agents',
      '--skip-hooks',
      '--quiet',
      '--role=maintainer',
    ],
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BD_NON_INTERACTIVE: '1', CI: '1' },
    },
  );
  const [stderr] = await Promise.all([new Response(proc.stderr).text()]);
  await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`bd init failed in ${cwd}: ${stderr}`);
  }
}

const HEX = '00112233';

function fakeFeatureId(slug: string): string {
  return `${HEX}-${slug}`;
}

function buildFeature(overrides: Partial<Feature> = {}): Feature {
  const now = new Date().toISOString();
  return {
    id: fakeFeatureId('beads-adapter'),
    goal: 'Wire the BeadsStore adapter end to end',
    status: 'draft',
    origin: 'user',
    taskCount: 0,
    readyTaskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('status mapping tables', () => {
  it('maps every Mars status to a bd status', () => {
    const statuses: Array<keyof typeof BD_STATUS_BY_MARS> = [
      'draft',
      'ready',
      'in_progress',
      'done',
      'failed',
      'halted',
    ];
    for (const status of statuses) {
      expect(typeof BD_STATUS_BY_MARS[status]).toBe('string');
      expect(BD_STATUS_BY_MARS[status].length).toBeGreaterThan(0);
    }
  });

  it('round-trips bd statuses through MARS_STATUS_BY_BD', () => {
    expect(MARS_STATUS_BY_BD['open']).toBe('ready');
    expect(MARS_STATUS_BY_BD['in_progress']).toBe('in_progress');
    expect(MARS_STATUS_BY_BD['closed']).toBe('done');
    expect(MARS_STATUS_BY_BD['blocked']).toBe('halted');
  });
});

const bdReady = await bdAvailable();
const integration = bdReady ? describe : describe.skip;

integration('BeadsStore (integration: requires `bd` on PATH)', () => {
  let scratchDir: string;
  let store: BeadsStore;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'mars-beads-store-'));
    await bdInit(scratchDir);
    store = new BeadsStore({ cwd: scratchDir });
  });

  afterAll(async () => {
    if (scratchDir !== undefined) {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('creates an issue, retrieves it, updates status, and lists it', async () => {
    const feature = buildFeature({
      id: fakeFeatureId('crud-flow'),
      goal: 'BeadsStore CRUD flow',
    });

    const ref = await store.create(feature);
    expect(typeof ref.storeId).toBe('string');
    expect(ref.storeId.length).toBeGreaterThan(0);

    const fetched = await store.get(ref.storeId);
    expect(fetched).not.toBeNull();
    if (fetched === null) {
      return;
    }
    expect(fetched.id).toBe(feature.id);
    expect(fetched.goal).toBe(feature.goal);
    // bd default status `open` maps back to Mars `ready`.
    expect(fetched.status).toBe('ready');
    expect(fetched.storeId).toBe(ref.storeId);

    await store.updateStatus(ref.storeId, 'in_progress');
    const afterUpdate = await store.get(ref.storeId);
    expect(afterUpdate?.status).toBe('in_progress');

    const listed = await store.list();
    const ours = listed.find((f) => f.storeId === ref.storeId);
    expect(ours).toBeDefined();
    expect(ours?.id).toBe(feature.id);

    const filteredInProgress = await store.list({ status: 'in_progress' });
    expect(filteredInProgress.some((f) => f.storeId === ref.storeId)).toBe(true);
  });

  it('returns null when looking up an unknown storeId', async () => {
    const result = await store.get('mars-bogus-does-not-exist-99');
    expect(result).toBeNull();
  });

  it('records a dependency edge between two issues', async () => {
    const a = await store.create(
      buildFeature({ id: fakeFeatureId('dep-a'), goal: 'Dependency A' }),
    );
    const b = await store.create(
      buildFeature({ id: fakeFeatureId('dep-b'), goal: 'Dependency B' }),
    );

    await store.addDependency(a.storeId, b.storeId);

    // No throw is the contract; verify both still resolve.
    const aFetched = await store.get(a.storeId);
    const bFetched = await store.get(b.storeId);
    expect(aFetched).not.toBeNull();
    expect(bFetched).not.toBeNull();
  });
});
