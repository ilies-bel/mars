import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InboxItemSchema, type InboxItem } from '../contract/inbox-item.ts';
import type { TaskId } from '../contract/task.ts';
import type { InboxItemDraft, InboxQuery, InboxStore } from './inbox-store.ts';

/**
 * JSONL-backed implementation of {@link InboxStore}.
 *
 * Default storage location is `.mars/inbox.jsonl` (per CONTRACTS §6.7).
 * Each line is a JSON-encoded {@link InboxItem}. Mutations rewrite the
 * file; appends shell out to `Bun.file().writer()` in append mode.
 *
 * Concurrency is intentionally naive in M0: a single-writer assumption
 * holds for the CLI. Atomic-write + flock support is tracked separately
 * (mars-framework-m5j).
 */
export class JsonlInboxStore implements InboxStore {
  private readonly path: string;
  private readonly clock: () => Date;
  private readonly idPrefix: string;
  private counter = 0;

  constructor(opts: { path: string; clock?: () => Date; idPrefix?: string }) {
    this.path = opts.path;
    this.clock = opts.clock ?? (() => new Date());
    this.idPrefix = opts.idPrefix ?? '00000000';
  }

  async list(query?: InboxQuery): Promise<InboxItem[]> {
    const items = await this.readAll();
    return items.filter((item) => matchesQuery(item, query));
  }

  async get(id: string): Promise<InboxItem | null> {
    const items = await this.readAll();
    return items.find((item) => item.id === id) ?? null;
  }

  async append(draft: InboxItemDraft): Promise<InboxItem> {
    this.counter += 1;
    const id = `${this.idPrefix}-jsonl-${this.counter}`;
    const item: InboxItem = {
      ...draft,
      id,
      state: 'open',
      raisedAt: this.clock().toISOString(),
      priority: draft.payload.kind === 'question' ? 'blocker' : 'normal',
    };
    await this.appendLine(item);
    return item;
  }

  async answer(
    id: string,
    answer: string,
    rootCause?: InboxItem['rootCause'],
    resolutionNote?: InboxItem['resolutionNote'],
  ): Promise<void> {
    await this.mutate(id, (item) => {
      if (item.kind !== 'question') {
        throw new Error(
          `JsonlInboxStore: answer() requires a question item, got '${item.kind}' for '${id}'`,
        );
      }
      return {
        ...item,
        state: 'resolved',
        resolvedAt: this.clock().toISOString(),
        resolution: answer,
        ...(rootCause !== undefined ? { rootCause } : {}),
        ...(resolutionNote !== undefined ? { resolutionNote } : {}),
      };
    });
  }

  async resolve(id: string, note: string, rootCause?: InboxItem['rootCause']): Promise<void> {
    await this.mutate(id, (item) => {
      if (item.kind !== 'action') {
        throw new Error(
          `JsonlInboxStore: resolve() requires an action item, got '${item.kind}' for '${id}'`,
        );
      }
      return {
        ...item,
        state: 'resolved',
        resolvedAt: this.clock().toISOString(),
        resolution: note,
        ...(rootCause !== undefined ? { rootCause } : {}),
      };
    });
  }

  async decide(id: string, optionId: string, rootCause?: InboxItem['rootCause']): Promise<void> {
    await this.mutate(id, (item) => {
      if (item.kind !== 'decision' || item.payload.kind !== 'decision') {
        throw new Error(
          `JsonlInboxStore: decide() requires a decision item, got '${item.kind}' for '${id}'`,
        );
      }
      const validOptions = item.payload.options.map((o) => o.id);
      if (!validOptions.includes(optionId)) {
        throw new Error(
          `JsonlInboxStore: optionId '${optionId}' is not one of [${validOptions.join(', ')}] for '${id}'`,
        );
      }
      return {
        ...item,
        state: 'resolved',
        resolvedAt: this.clock().toISOString(),
        resolution: optionId,
        ...(rootCause !== undefined ? { rootCause } : {}),
      };
    });
  }

  async dismiss(id: string, reason: string, rootCause?: InboxItem['rootCause']): Promise<void> {
    await this.mutate(id, (item) => ({
      ...item,
      state: 'dismissed',
      resolvedAt: this.clock().toISOString(),
      resolution: reason,
      ...(rootCause !== undefined ? { rootCause } : {}),
    }));
  }

  async recomputePriorities(_taskId: TaskId): Promise<void> {
    // M0: no-op. See MemoryInboxStore.recomputePriorities for rationale.
  }

  private async readAll(): Promise<InboxItem[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) {
      return [];
    }
    const text = await file.text();
    if (text.length === 0) {
      return [];
    }
    const lines = text.split('\n').filter((line) => line.length > 0);
    return lines.map((line, idx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown';
        throw new Error(`JsonlInboxStore: invalid JSON on line ${idx + 1} of ${this.path}: ${msg}`);
      }
      const result = InboxItemSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `JsonlInboxStore: invalid InboxItem on line ${idx + 1} of ${this.path}: ${result.error.message}`,
        );
      }
      return result.data;
    });
  }

  private async appendLine(item: InboxItem): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file = Bun.file(this.path);
    const existing = (await file.exists()) ? await file.text() : '';
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const next = `${existing}${sep}${JSON.stringify(item)}\n`;
    await Bun.write(this.path, next);
  }

  private async mutate(id: string, fn: (item: InboxItem) => InboxItem): Promise<void> {
    const items = await this.readAll();
    const idx = items.findIndex((item) => item.id === id);
    if (idx === -1) {
      throw new Error(`JsonlInboxStore: unknown inbox item '${id}'`);
    }
    // Non-null is safe — idx came from findIndex on this same array.
    const current = items[idx]!;
    if (current.state !== 'open') {
      throw new Error(
        `JsonlInboxStore: item '${id}' is already '${current.state}', cannot mutate`,
      );
    }
    items[idx] = fn(current);
    await mkdir(dirname(this.path), { recursive: true });
    const text = items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
    await Bun.write(this.path, text);
  }
}

function matchesQuery(item: InboxItem, query?: InboxQuery): boolean {
  if (query === undefined) return true;
  if (query.state !== undefined && item.state !== query.state) return false;
  if (query.kind !== undefined && item.kind !== query.kind) return false;
  if (query.category !== undefined && item.category !== query.category) return false;
  if (query.priority !== undefined && item.priority !== query.priority) return false;
  if (query.taskId !== undefined) {
    const related = item.context.relatedTaskIds ?? [];
    if (!related.includes(query.taskId)) return false;
  }
  return true;
}
