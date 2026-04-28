import type { InboxItem } from '../contract/inbox-item.ts';
import type { TaskId } from '../contract/task.ts';
import type { InboxItemDraft, InboxQuery, InboxStore } from './inbox-store.ts';

/**
 * In-memory implementation of {@link InboxStore}.
 *
 * Intended exclusively for unit tests — no I/O, no external deps. Each
 * instance has its own counter and map; tests that need isolation should
 * create a fresh instance per test.
 *
 * Priority computation is intentionally trivial: the priority assigned at
 * append time is preserved until a future `recomputePriorities` wiring
 * lands. M0 is about the swappable interface, not the scheduler.
 */
export class MemoryInboxStore implements InboxStore {
  private readonly items: Map<string, InboxItem> = new Map();
  private readonly insertionOrder: string[] = [];
  private counter = 0;
  private readonly idPrefix: string;
  private readonly clock: () => Date;

  constructor(opts: { idPrefix?: string; clock?: () => Date } = {}) {
    this.idPrefix = opts.idPrefix ?? '00000000';
    this.clock = opts.clock ?? (() => new Date());
  }

  async list(query?: InboxQuery): Promise<InboxItem[]> {
    const ordered = this.insertionOrder
      .map((id) => this.items.get(id))
      .filter((item): item is InboxItem => item !== undefined);

    const filtered = ordered.filter((item) => matchesQuery(item, query));
    return filtered.map(cloneItem);
  }

  async get(id: string): Promise<InboxItem | null> {
    const item = this.items.get(id);
    return item === undefined ? null : cloneItem(item);
  }

  async append(draft: InboxItemDraft): Promise<InboxItem> {
    this.counter += 1;
    const id = `${this.idPrefix}-mem-${this.counter}`;
    const item: InboxItem = {
      ...draft,
      id,
      state: 'open',
      raisedAt: this.clock().toISOString(),
      priority: draft.payload.kind === 'question' ? 'blocker' : 'normal',
    };
    this.items.set(id, item);
    this.insertionOrder.push(id);
    return cloneItem(item);
  }

  async answer(
    id: string,
    answer: string,
    rootCause?: InboxItem['rootCause'],
    resolutionNote?: InboxItem['resolutionNote'],
  ): Promise<void> {
    const item = this.requireOpen(id);
    if (item.kind !== 'question') {
      throw new Error(
        `MemoryInboxStore: answer() requires a question item, got '${item.kind}' for '${id}'`,
      );
    }
    this.items.set(id, {
      ...item,
      state: 'resolved',
      resolvedAt: this.clock().toISOString(),
      resolution: answer,
      ...(rootCause !== undefined ? { rootCause } : {}),
      ...(resolutionNote !== undefined ? { resolutionNote } : {}),
    });
  }

  async resolve(id: string, note: string, rootCause?: InboxItem['rootCause']): Promise<void> {
    const item = this.requireOpen(id);
    if (item.kind !== 'action') {
      throw new Error(
        `MemoryInboxStore: resolve() requires an action item, got '${item.kind}' for '${id}'`,
      );
    }
    this.items.set(id, {
      ...item,
      state: 'resolved',
      resolvedAt: this.clock().toISOString(),
      resolution: note,
      ...(rootCause !== undefined ? { rootCause } : {}),
    });
  }

  async decide(id: string, optionId: string, rootCause?: InboxItem['rootCause']): Promise<void> {
    const item = this.requireOpen(id);
    if (item.kind !== 'decision') {
      throw new Error(
        `MemoryInboxStore: decide() requires a decision item, got '${item.kind}' for '${id}'`,
      );
    }
    if (item.payload.kind !== 'decision') {
      throw new Error(`MemoryInboxStore: item '${id}' has mismatched payload kind`);
    }
    const validOptions = item.payload.options.map((o) => o.id);
    if (!validOptions.includes(optionId)) {
      throw new Error(
        `MemoryInboxStore: optionId '${optionId}' is not one of [${validOptions.join(', ')}] for '${id}'`,
      );
    }
    this.items.set(id, {
      ...item,
      state: 'resolved',
      resolvedAt: this.clock().toISOString(),
      resolution: optionId,
      ...(rootCause !== undefined ? { rootCause } : {}),
    });
  }

  async dismiss(id: string, reason: string, rootCause?: InboxItem['rootCause']): Promise<void> {
    const item = this.requireOpen(id);
    this.items.set(id, {
      ...item,
      state: 'dismissed',
      resolvedAt: this.clock().toISOString(),
      resolution: reason,
      ...(rootCause !== undefined ? { rootCause } : {}),
    });
  }

  async recomputePriorities(_taskId: TaskId): Promise<void> {
    // M0: no-op. Wired up once the orchestrator surfaces task state to the store.
    // The interface is intentionally stable so a future implementation can drop
    // in without churning every adapter.
  }

  private requireOpen(id: string): InboxItem {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new Error(`MemoryInboxStore: unknown inbox item '${id}'`);
    }
    if (item.state !== 'open') {
      throw new Error(
        `MemoryInboxStore: item '${id}' is already '${item.state}', cannot mutate`,
      );
    }
    return item;
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

function cloneItem(item: InboxItem): InboxItem {
  // Structured-clone-equivalent for plain JSON shape — protects the store's
  // internal map from caller mutation.
  return JSON.parse(JSON.stringify(item)) as InboxItem;
}
