import type { Feature, FeatureStatus } from '../contract/feature.ts';
import type { FeatureListFilter, FeatureStore, StoredFeatureRef } from './feature-store.ts';

/**
 * Adapter that persists Mars features in a beads (`bd`) tracker by shelling
 * out to the `bd` binary. All knowledge of the `bd` CLI lives in this file;
 * the rest of Mars must never import or invoke `bd` directly.
 *
 * Process invocation goes through `Bun.spawn`. Each method captures stdout
 * and stderr; non-zero exit codes raise an `Error` whose message includes
 * the command, exit code, and stderr.
 */

/**
 * Map of Mars `FeatureStatus` to its corresponding bd `status` string.
 *
 * Notes on the mapping:
 *   - Mars `draft` and `ready` both collapse to bd `open`. Once a feature
 *     is in the store, the `draft` vs. `ready` distinction is not meaningful
 *     to the tracker; the canonical "available to work" state in bd is `open`.
 *     The reverse mapping picks `ready` (see below) — a feature persisted in
 *     bd is, by definition, no longer just an idea.
 *   - Mars `failed` maps to bd `closed`: the work is over and bd has no
 *     dedicated failure state. The Mars status remains the source of truth
 *     for "this finished badly"; bd just records that it's done.
 *   - Mars `halted` maps to bd `blocked`, which is the closest "stopped but
 *     not done" state in bd's vocabulary.
 */
export const BD_STATUS_BY_MARS: Readonly<Record<FeatureStatus, string>> = {
  draft: 'open',
  ready: 'open',
  in_progress: 'in_progress',
  done: 'closed',
  failed: 'closed',
  halted: 'blocked',
};

/**
 * Map of bd `status` strings back to a Mars `FeatureStatus`.
 *
 * Notes on the mapping:
 *   - bd `open` maps to Mars `ready` (not `draft`). Anything that exists in
 *     the store has already been promoted past the pure-idea stage, so
 *     `ready` is the truthful round-trip target.
 *   - bd `deferred` and `pinned` are not produced by this adapter, but a
 *     human editing the tracker directly could set them; we map them to the
 *     closest Mars status (`halted` and `ready` respectively).
 *   - bd `hooked` (attached to an agent) maps to Mars `in_progress`.
 *   - This mapping is lossy in the reverse direction: a Mars `failed` and a
 *     Mars `done` both come back as `done` because both are bd `closed`.
 */
export const MARS_STATUS_BY_BD: Readonly<Record<string, FeatureStatus>> = {
  open: 'ready',
  in_progress: 'in_progress',
  closed: 'done',
  blocked: 'halted',
  deferred: 'halted',
  pinned: 'ready',
  hooked: 'in_progress',
};

interface BeadsStoreOptions {
  cwd?: string;
  bdPath?: string;
}

interface BdIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: number;
  issue_type?: string;
  created_at?: string;
  updated_at?: string;
}

interface BdErrorPayload {
  error?: string;
}

const STDOUT_TRUNCATE = 2_000;

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function isNotFoundError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes('no issue found') ||
    haystack.includes('no issues found') ||
    haystack.includes('not found')
  );
}

function mapBdToMarsStatus(bdStatus: string): FeatureStatus {
  const mapped = MARS_STATUS_BY_BD[bdStatus];
  if (mapped === undefined) {
    throw new Error(`Unknown bd status: ${bdStatus}`);
  }
  return mapped;
}

function mapMarsToBdStatus(marsStatus: FeatureStatus): string {
  const mapped = BD_STATUS_BY_MARS[marsStatus];
  if (mapped === undefined) {
    throw new Error(`Unknown Mars status: ${marsStatus}`);
  }
  return mapped;
}

function extractMarsId(description: string | undefined): string {
  if (description === undefined || description === '') {
    throw new Error('bd issue description is empty; cannot recover Mars id');
  }
  const match = description.match(/Mars feature:\s*([0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,39})/);
  if (match === null) {
    throw new Error(
      `bd issue description missing "Mars feature: <id>" line: ${truncate(description, 200)}`,
    );
  }
  return match[1] as string;
}

function extractGoal(description: string | undefined, fallbackTitle: string): string {
  if (description !== undefined) {
    const match = description.match(/Goal:\s*(.+?)(?:\n|$)/);
    if (match !== null) {
      const value = match[1]?.trim() ?? '';
      if (value !== '') {
        return value;
      }
    }
  }
  return fallbackTitle;
}

function bdIssueToFeature(issue: BdIssue): Feature {
  const id = extractMarsId(issue.description);
  const goal = extractGoal(issue.description, issue.title);
  const now = new Date().toISOString();
  return {
    id,
    goal,
    status: mapBdToMarsStatus(issue.status),
    origin: 'user',
    taskCount: 0,
    readyTaskCount: 0,
    createdAt: issue.created_at ?? now,
    updatedAt: issue.updated_at ?? now,
    storeId: issue.id,
  };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class BeadsStore implements FeatureStore {
  private readonly cwd: string;
  private readonly bdPath: string;

  constructor(options: BeadsStoreOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.bdPath = options.bdPath ?? 'bd';
  }

  async create(feature: Feature): Promise<StoredFeatureRef> {
    const description = `Mars feature: ${feature.id}\n\nGoal: ${feature.goal}`;
    const result = await this.run([
      '--json',
      'create',
      `--title=${feature.goal}`,
      `--description=${description}`,
      '--type=feature',
      '--priority=2',
    ]);
    const issue = this.parseJson<BdIssue>(result.stdout);
    if (typeof issue.id !== 'string' || issue.id === '') {
      throw new Error(
        `bd create returned no id; stdout: ${truncate(result.stdout, STDOUT_TRUNCATE)}`,
      );
    }
    return { storeId: issue.id };
  }

  async get(storeId: string): Promise<Feature | null> {
    const result = await this.runRaw(['--json', 'show', storeId]);
    if (result.exitCode !== 0) {
      if (isNotFoundError(result.stdout, result.stderr)) {
        return null;
      }
      throw this.spawnError(['--json', 'show', storeId], result);
    }
    const parsed = this.parseJson<BdIssue | BdIssue[] | BdErrorPayload>(result.stdout);
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      if (first === undefined) {
        return null;
      }
      return bdIssueToFeature(first);
    }
    if ('error' in parsed && typeof parsed.error === 'string') {
      if (isNotFoundError(parsed.error, '')) {
        return null;
      }
      throw new Error(`bd show ${storeId} returned error: ${parsed.error}`);
    }
    return bdIssueToFeature(parsed as BdIssue);
  }

  async updateStatus(storeId: string, status: FeatureStatus): Promise<void> {
    const bdStatus = mapMarsToBdStatus(status);
    await this.run(['update', storeId, `--status=${bdStatus}`]);
  }

  async addDependency(storeId: string, dependsOn: string): Promise<void> {
    await this.run(['dep', 'add', storeId, dependsOn]);
  }

  async list(filter?: FeatureListFilter): Promise<Feature[]> {
    const args: string[] = ['--json', 'list'];
    if (filter?.status !== undefined) {
      args.push(`--status=${mapMarsToBdStatus(filter.status)}`);
    }
    const result = await this.run(args);
    const parsed = this.parseJson<BdIssue[]>(result.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `bd list returned non-array JSON: ${truncate(result.stdout, STDOUT_TRUNCATE)}`,
      );
    }
    const features: Feature[] = [];
    for (const issue of parsed) {
      try {
        const feature = bdIssueToFeature(issue);
        if (filter?.status !== undefined && feature.status !== filter.status) {
          continue;
        }
        features.push(feature);
      } catch {
        // Skip bd issues that aren't Mars features (no Mars id in description).
      }
    }
    return features;
  }

  private async run(args: string[]): Promise<SpawnResult> {
    const result = await this.runRaw(args);
    if (result.exitCode !== 0) {
      throw this.spawnError(args, result);
    }
    return result;
  }

  private async runRaw(args: string[]): Promise<SpawnResult> {
    const proc = Bun.spawn([this.bdPath, ...args], {
      cwd: this.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  private spawnError(args: string[], result: SpawnResult): Error {
    const command = `${this.bdPath} ${args.join(' ')}`;
    return new Error(
      `bd command failed: ${command}\n  exit code: ${result.exitCode}\n  stderr: ${truncate(result.stderr, STDOUT_TRUNCATE)}`,
    );
  }

  private parseJson<T>(stdout: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to parse bd JSON output: ${message}\n  raw stdout: ${truncate(stdout, STDOUT_TRUNCATE)}`,
      );
    }
  }
}
