import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { PlanSchema } from '../contract/plan.ts';
import { planNew } from './plan-new.ts';

describe('mars plan new', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mars-plan-new-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a draft user plan persisted as markdown with valid front-matter', async () => {
    const { plan, path } = await planNew('Add streaming output to mars build', dir);

    expect(plan.status).toBe('draft');
    expect(plan.origin).toBe('user');
    expect(plan.taskCount).toBe(0);
    expect(plan.readyTaskCount).toBe(0);
    expect(plan.id).toMatch(/^[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,39}$/);
    expect(path).toBe(join(dir, 'plans', `${plan.id}.md`));

    const file = await readFile(path, 'utf-8');
    const parsed = matter(file);
    const reconstructed = PlanSchema.parse({ ...parsed.data, goal: plan.goal });
    expect(reconstructed).toEqual(plan);
    expect(parsed.content).toContain('mars plan refine');
  });

  it('rejects empty goals', async () => {
    await expect(planNew('   ', dir)).rejects.toThrow(/non-empty/);
  });

  it('produces unique ids for the same goal', async () => {
    const a = await planNew('same goal', dir);
    const b = await planNew('same goal', dir);
    expect(a.plan.id).not.toBe(b.plan.id);
  });

  it('falls back to "idea" slug when goal has no alphanumerics', async () => {
    const { plan } = await planNew('!!!', dir);
    expect(plan.id.endsWith('-idea')).toBe(true);
  });
});
