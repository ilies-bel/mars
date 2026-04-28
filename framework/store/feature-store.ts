import type { Feature, FeatureStatus } from '../contract/feature.ts';

/**
 * Opaque reference to a feature record in the backing store.
 *
 * `storeId` is the store-native identifier (e.g. `bd-42` for beads). Mars
 * never parses or displays this value in primary UX — the public Mars ID
 * (`<hex>-<slug>`) lives on `Feature.id`.
 */
export interface StoredFeatureRef {
  storeId: string;
}

/**
 * Optional filter for {@link FeatureStore.list}.
 */
export interface FeatureListFilter {
  status?: FeatureStatus;
}

/**
 * Persistence boundary for Mars features.
 *
 * Implementations adapt Mars to a concrete tracker (beads, Linear, GitHub
 * Issues, SQLite, in-memory, ...). The interface intentionally exposes only
 * what Mars commands need; tracker-specific niceties (beads' `--design`,
 * `--notes`, labels, etc.) stay inside the adapter.
 *
 * Mars CLI code MUST depend on this interface, never on a concrete adapter
 * or tracker SDK.
 */
export interface FeatureStore {
  /**
   * Persist a new feature and return its store-native reference.
   */
  create(feature: Feature): Promise<StoredFeatureRef>;

  /**
   * Look up a feature by its `storeId`. Returns `null` when no record
   * exists in the backing store.
   */
  get(storeId: string): Promise<Feature | null>;

  /**
   * Update the lifecycle status of a stored feature.
   */
  updateStatus(storeId: string, status: FeatureStatus): Promise<void>;

  /**
   * Record a dependency edge: the feature identified by `storeId` depends
   * on the feature identified by `dependsOn` (also a `storeId`).
   */
  addDependency(storeId: string, dependsOn: string): Promise<void>;

  /**
   * List stored features, optionally narrowed by status.
   */
  list(filter?: FeatureListFilter): Promise<Feature[]>;
}
