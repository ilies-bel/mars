import type {
  InboxItem,
  InboxItemCategory,
  InboxItemKind,
  InboxItemState,
  Priority,
  RootCause,
} from '../contract/inbox-item.ts';
import type { TaskId } from '../contract/task.ts';

// `ResolutionNote` is not currently exported from the contract module; pull
// the inferred shape off `InboxItem` so the interface stays in sync without
// duplicating the schema.
type ResolutionNote = NonNullable<InboxItem['resolutionNote']>;

/**
 * Filter for {@link InboxStore.list}.
 *
 * All fields are optional and AND-combined: passing `{ state: 'open',
 * kind: 'question' }` matches only open question items.
 */
export interface InboxQuery {
  state?: InboxItemState;
  kind?: InboxItemKind;
  category?: InboxItemCategory;
  priority?: Priority;
  taskId?: TaskId;
}

/**
 * Shape accepted by {@link InboxStore.append}.
 *
 * The store fills in:
 *   - `id` — unique inbox item id
 *   - `state` — always `'open'` for newly appended items
 *   - `raisedAt` — ISO timestamp at append time
 *   - `priority` — computed from referenced tasks (see CONTRACTS §6.4)
 */
export type InboxItemDraft = Omit<InboxItem, 'id' | 'state' | 'raisedAt' | 'priority'>;

/**
 * Persistence boundary for the Mars HumanInbox.
 *
 * Implementations adapt Mars to a concrete storage backend (a JSONL file,
 * SQLite, an external tracker, in-memory, ...). The interface deliberately
 * exposes only what Mars commands and the orchestrator need; backend-specific
 * niceties stay inside the adapter.
 *
 * Mars CLI and runtime code MUST depend on this interface, never on a
 * concrete adapter. Mirrors the precedent set by {@link FeatureStore} (see
 * `framework/store/feature-store.ts`).
 */
export interface InboxStore {
  /**
   * List inbox items matching the optional query. Returns all items when no
   * query is provided. The order is implementation-defined but stable across
   * calls when the underlying state has not changed.
   */
  list(query?: InboxQuery): Promise<InboxItem[]>;

  /**
   * Look up a single inbox item by id. Resolves to `null` when no item with
   * that id exists.
   */
  get(id: string): Promise<InboxItem | null>;

  /**
   * Append a new inbox item. The store assigns the id, sets `state` to
   * `'open'`, stamps `raisedAt`, and computes the initial `priority`.
   *
   * Returns the persisted item (with all store-assigned fields populated).
   */
  append(draft: InboxItemDraft): Promise<InboxItem>;

  /**
   * Resolve a `question`-kind item with a free-text answer. Implementations
   * MUST throw if the referenced item is missing, not a question, or already
   * closed (resolved/dismissed).
   */
  answer(
    id: string,
    answer: string,
    rootCause?: RootCause,
    resolutionNote?: ResolutionNote,
  ): Promise<void>;

  /**
   * Resolve an `action`-kind item: the human has done the thing. The note
   * is recorded as the resolution. Implementations MUST throw if the
   * referenced item is missing, not an action, or already closed.
   */
  resolve(id: string, note: string, rootCause?: RootCause): Promise<void>;

  /**
   * Resolve a `decision`-kind item by selecting one of its options.
   * Implementations MUST throw if the referenced item is missing, not a
   * decision, already closed, or if `optionId` is not one of the offered
   * options.
   */
  decide(id: string, optionId: string, rootCause?: RootCause): Promise<void>;

  /**
   * Dismiss any open item. The reason is required and recorded as the
   * resolution. Implementations MUST throw if the referenced item is
   * missing or already closed.
   */
  dismiss(id: string, reason: string, rootCause?: RootCause): Promise<void>;

  /**
   * Recompute priorities for all items referencing the given task. Called
   * by the orchestrator on every task state change (see CONTRACTS §6.4).
   * Items whose computed priority is unchanged are left untouched.
   */
  recomputePriorities(taskId: TaskId): Promise<void>;
}
