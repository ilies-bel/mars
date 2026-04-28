import { describe, expect, it } from 'bun:test';
import type { Feature } from '../contract/feature.ts';
import { MemoryStore } from './memory-store.ts';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'a1b2c3d4-mvp-bootstrap',
    goal: 'Bootstrap Mars MVP',
    status: 'draft',
    origin: 'user',
    taskCount: 0,
    readyTaskCount: 0,
    createdAt: '2026-04-27T10:00:00.000Z',
    updatedAt: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('MemoryStore.create', () => {
  it('returns a storeId ref on first create', async () => {
    const store = new MemoryStore();
    const ref = await store.create(makeFeature());
    expect(ref.storeId).toBe('mem-1');
  });

  it('increments storeId monotonically across multiple creates', async () => {
    const store = new MemoryStore();
    const ref1 = await store.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    const ref2 = await store.create(makeFeature({ id: 'a1b2c3d4-feat-two' }));
    const ref3 = await store.create(makeFeature({ id: 'a1b2c3d4-feat-three' }));
    expect(ref1.storeId).toBe('mem-1');
    expect(ref2.storeId).toBe('mem-2');
    expect(ref3.storeId).toBe('mem-3');
  });

  it('each MemoryStore instance has its own counter', async () => {
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    await storeA.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    await storeA.create(makeFeature({ id: 'a1b2c3d4-feat-two' }));
    const refB = await storeB.create(makeFeature({ id: 'a1b2c3d4-feat-three' }));
    expect(refB.storeId).toBe('mem-1');
  });

  it('stores the feature with the generated storeId', async () => {
    const store = new MemoryStore();
    const feature = makeFeature();
    const ref = await store.create(feature);
    const stored = await store.get(ref.storeId);
    expect(stored?.storeId).toBe(ref.storeId);
  });

  it('does not mutate the caller-supplied feature object', async () => {
    const store = new MemoryStore();
    const feature = makeFeature();
    await store.create(feature);
    // The input object should not gain a storeId from the store
    expect((feature as Partial<Feature>).storeId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('MemoryStore.get', () => {
  it('returns the stored feature for a known storeId', async () => {
    const store = new MemoryStore();
    const feature = makeFeature();
    const { storeId } = await store.create(feature);
    const result = await store.get(storeId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(feature.id);
    expect(result?.goal).toBe(feature.goal);
  });

  it('returns null for an unknown storeId', async () => {
    const store = new MemoryStore();
    const result = await store.get('mem-999');
    expect(result).toBeNull();
  });

  it('returns a copy so callers cannot mutate internal state', async () => {
    const store = new MemoryStore();
    const { storeId } = await store.create(makeFeature());
    const copy1 = await store.get(storeId);
    // Mutate the returned copy
    if (copy1) {
      (copy1 as Partial<Feature>).goal = 'mutated externally';
    }
    const copy2 = await store.get(storeId);
    expect(copy2?.goal).toBe('Bootstrap Mars MVP');
  });

  it('returns null for an empty storeId string', async () => {
    const store = new MemoryStore();
    const result = await store.get('');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

describe('MemoryStore.updateStatus', () => {
  it('updates the status of a stored feature', async () => {
    const store = new MemoryStore();
    const { storeId } = await store.create(makeFeature({ status: 'draft' }));
    await store.updateStatus(storeId, 'in_progress');
    const result = await store.get(storeId);
    expect(result?.status).toBe('in_progress');
  });

  it('bumps updatedAt to a new ISO timestamp', async () => {
    const store = new MemoryStore();
    const originalUpdatedAt = '2026-04-27T10:00:00.000Z';
    const { storeId } = await store.create(makeFeature({ updatedAt: originalUpdatedAt }));
    await store.updateStatus(storeId, 'done');
    const result = await store.get(storeId);
    expect(result?.updatedAt).not.toBe(originalUpdatedAt);
    // Must be a valid ISO datetime string
    expect(() => new Date(result?.updatedAt ?? '').toISOString()).not.toThrow();
  });

  it('throws a descriptive error when storeId is unknown', async () => {
    const store = new MemoryStore();
    await expect(store.updateStatus('mem-999', 'done')).rejects.toThrow('mem-999');
  });

  it('throws for an empty storeId', async () => {
    const store = new MemoryStore();
    await expect(store.updateStatus('', 'done')).rejects.toThrow();
  });

  it('does not affect the status of other features', async () => {
    const store = new MemoryStore();
    const { storeId: id1 } = await store.create(
      makeFeature({ id: 'a1b2c3d4-feat-one', status: 'draft' }),
    );
    const { storeId: id2 } = await store.create(
      makeFeature({ id: 'a1b2c3d4-feat-two', status: 'ready' }),
    );
    await store.updateStatus(id1, 'done');
    const feature2 = await store.get(id2);
    expect(feature2?.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// addDependency
// ---------------------------------------------------------------------------

describe('MemoryStore.addDependency', () => {
  it('resolves without throwing for two valid storeIds', async () => {
    const store = new MemoryStore();
    const { storeId: idA } = await store.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    const { storeId: idB } = await store.create(makeFeature({ id: 'a1b2c3d4-feat-two' }));
    await expect(store.addDependency(idA, idB)).resolves.toBeUndefined();
  });

  it('throws when the dependent storeId is unknown', async () => {
    const store = new MemoryStore();
    const { storeId: idA } = await store.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    await expect(store.addDependency('mem-999', idA)).rejects.toThrow('mem-999');
  });

  it('throws when the dependency target storeId is unknown', async () => {
    const store = new MemoryStore();
    const { storeId: idA } = await store.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    await expect(store.addDependency(idA, 'mem-999')).rejects.toThrow('mem-999');
  });

  it('throws when both storeIds are unknown', async () => {
    const store = new MemoryStore();
    await expect(store.addDependency('mem-998', 'mem-999')).rejects.toThrow();
  });

  it('allows adding the same dependency edge twice (idempotent)', async () => {
    const store = new MemoryStore();
    const { storeId: idA } = await store.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    const { storeId: idB } = await store.create(makeFeature({ id: 'a1b2c3d4-feat-two' }));
    await store.addDependency(idA, idB);
    await expect(store.addDependency(idA, idB)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('MemoryStore.list', () => {
  it('returns an empty array when the store is empty', async () => {
    const store = new MemoryStore();
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('returns all features when called without a filter', async () => {
    const store = new MemoryStore();
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-one', status: 'draft' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-two', status: 'ready' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-three', status: 'done' }));
    const result = await store.list();
    expect(result.length).toBe(3);
  });

  it('filters by status when provided', async () => {
    const store = new MemoryStore();
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-one', status: 'draft' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-two', status: 'ready' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-three', status: 'draft' }));
    const drafts = await store.list({ status: 'draft' });
    expect(drafts.length).toBe(2);
    expect(drafts.every((f) => f.status === 'draft')).toBe(true);
  });

  it('returns an empty array when filter matches nothing', async () => {
    const store = new MemoryStore();
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-one', status: 'draft' }));
    const result = await store.list({ status: 'done' });
    expect(result).toEqual([]);
  });

  it('preserves insertion order', async () => {
    const store = new MemoryStore();
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-one' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-two' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-three' }));
    const result = await store.list();
    expect(result[0]?.id).toBe('a1b2c3d4-feat-one');
    expect(result[1]?.id).toBe('a1b2c3d4-feat-two');
    expect(result[2]?.id).toBe('a1b2c3d4-feat-three');
  });

  it('returns copies so callers cannot mutate internal state', async () => {
    const store = new MemoryStore();
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-one', goal: 'Original goal' }));
    const [first] = await store.list();
    if (first) {
      (first as Partial<Feature>).goal = 'mutated externally';
    }
    const [again] = await store.list();
    expect(again?.goal).toBe('Original goal');
  });

  it('respects an empty filter object (no status key) as no filter', async () => {
    const store = new MemoryStore();
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-one', status: 'draft' }));
    await store.create(makeFeature({ id: 'a1b2c3d4-feat-two', status: 'ready' }));
    const result = await store.list({});
    expect(result.length).toBe(2);
  });
});
