import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { type Plan, PlanSchema } from '../contract/plan.ts';

const SLUG_MAX = 40;

function slugify(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  if (slug === '' || !/^[a-z0-9]/.test(slug)) {
    return 'idea';
  }
  return slug;
}

function newPlanId(goal: string): string {
  const hex = randomBytes(4).toString('hex');
  return `${hex}-${slugify(goal)}`;
}

export interface PlanNewResult {
  plan: Plan;
  path: string;
}

export async function planNew(goal: string, cwd: string = process.cwd()): Promise<PlanNewResult> {
  const trimmed = goal.trim();
  if (trimmed === '') {
    throw new Error('Goal must be non-empty');
  }

  const now = new Date().toISOString();
  const plan: Plan = PlanSchema.parse({
    id: newPlanId(trimmed),
    goal: trimmed,
    status: 'draft',
    origin: 'user',
    taskCount: 0,
    readyTaskCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  const plansDir = resolve(cwd, 'plans');
  await mkdir(plansDir, { recursive: true });
  const path = join(plansDir, `${plan.id}.md`);

  const { id: _id, goal: _goal, ...frontMatter } = plan;
  const body = `# ${trimmed}\n\n_Idea registered. Run \`mars plan refine ${plan.id}\` to expand into tasks._\n`;
  const file = matter.stringify(body, { id: plan.id, ...frontMatter });

  await Bun.write(path, file);
  return { plan, path };
}
