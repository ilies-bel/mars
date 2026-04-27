import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { type Feature, FeatureSchema } from '../contract/feature.ts';

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

function newFeatureId(goal: string): string {
  const hex = randomBytes(4).toString('hex');
  return `${hex}-${slugify(goal)}`;
}

export interface FeaturePlanResult {
  feature: Feature;
  path: string;
}

export async function featurePlan(
  goal: string,
  cwd: string = process.cwd(),
): Promise<FeaturePlanResult> {
  const trimmed = goal.trim();
  if (trimmed === '') {
    throw new Error('Goal must be non-empty');
  }

  const now = new Date().toISOString();
  const feature: Feature = FeatureSchema.parse({
    id: newFeatureId(trimmed),
    goal: trimmed,
    status: 'draft',
    origin: 'user',
    taskCount: 0,
    readyTaskCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  const featuresDir = resolve(cwd, 'features');
  await mkdir(featuresDir, { recursive: true });
  const path = join(featuresDir, `${feature.id}.md`);

  const { id: _id, goal: _goal, ...frontMatter } = feature;
  const body = `# ${trimmed}\n\n_Idea registered. Run \`mars feature refine ${feature.id}\` to expand into tasks._\n`;
  const file = matter.stringify(body, { id: feature.id, ...frontMatter });

  await Bun.write(path, file);
  return { feature, path };
}
