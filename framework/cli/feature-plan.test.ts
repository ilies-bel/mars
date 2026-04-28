import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { FeatureSchema } from '../contract/feature.ts';
import { MemoryStore } from '../store/memory-store.ts';
import { featurePlan } from './feature-plan.ts';

describe('mars feature plan', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mars-feature-plan-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a draft user feature persisted as markdown with valid front-matter', async () => {
    const { feature, path } = await featurePlan('Add streaming output to mars build', dir);

    expect(feature.status).toBe('draft');
    expect(feature.origin).toBe('user');
    expect(feature.taskCount).toBe(0);
    expect(feature.readyTaskCount).toBe(0);
    expect(feature.id).toMatch(/^[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,39}$/);
    expect(path).toBe(join(dir, 'features', `${feature.id}.md`));

    const file = await readFile(path, 'utf-8');
    const parsed = matter(file);
    const reconstructed = FeatureSchema.parse({ ...parsed.data, goal: feature.goal });
    expect(reconstructed).toEqual(feature);
    expect(parsed.content).toContain('mars feature refine');
  });

  it('rejects empty goals', async () => {
    await expect(featurePlan('   ', dir)).rejects.toThrow(/non-empty/);
  });

  it('produces unique ids for the same goal', async () => {
    const a = await featurePlan('same goal', dir);
    const b = await featurePlan('same goal', dir);
    expect(a.feature.id).not.toBe(b.feature.id);
  });

  it('falls back to "idea" slug when goal has no alphanumerics', async () => {
    const { feature } = await featurePlan('!!!', dir);
    expect(feature.id.endsWith('-idea')).toBe(true);
  });

  describe('with FeatureStore', () => {
    it('registers the feature in the store and persists storeId in frontmatter', async () => {
      const store = new MemoryStore();
      const { feature, path } = await featurePlan('Add OAuth login', dir, { store });

      // returned feature must have storeId set
      expect(feature.storeId).toBeDefined();
      expect(typeof feature.storeId).toBe('string');
      expect((feature.storeId as string).length).toBeGreaterThan(0);

      // storeId must be written to frontmatter on disk
      const raw = await readFile(path, 'utf-8');
      const parsed = matter(raw);
      expect(parsed.data['storeId']).toBe(feature.storeId);

      // store must contain the feature under that storeId
      const fromStore = await store.get(feature.storeId as string);
      expect(fromStore).not.toBeNull();
      expect(fromStore?.id).toBe(feature.id);
      expect(fromStore?.storeId).toBe(feature.storeId);
    });
  });
});
