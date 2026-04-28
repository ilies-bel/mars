import type { Feature, FeatureStatus } from '../contract/feature.ts';
import type { FeatureListFilter, FeatureStore, StoredFeatureRef } from './feature-store.ts';

/**
 * In-memory implementation of {@link FeatureStore}.
 *
 * Intended exclusively for unit tests — no I/O, no external deps. Each
 * instance has its own counter and map; tests that need isolation should
 * create a fresh instance per test.
 */
export class MemoryStore implements FeatureStore {
  private readonly features: Map<string, Feature> = new Map();
  private readonly deps: Map<string, Set<string>> = new Map();
  private counter = 0;

  async create(feature: Feature): Promise<StoredFeatureRef> {
    this.counter += 1;
    const storeId = `mem-${this.counter}`;
    // Store a shallow copy with the generated storeId; caller's object is untouched.
    const stored: Feature = { ...feature, storeId };
    this.features.set(storeId, stored);
    this.deps.set(storeId, new Set());
    return { storeId };
  }

  async get(storeId: string): Promise<Feature | null> {
    const feature = this.features.get(storeId);
    if (feature === undefined) {
      return null;
    }
    // Return a shallow copy so callers cannot mutate internal state.
    return { ...feature };
  }

  async updateStatus(storeId: string, status: FeatureStatus): Promise<void> {
    const feature = this.features.get(storeId);
    if (feature === undefined) {
      throw new Error(`MemoryStore: unknown storeId '${storeId}'`);
    }
    this.features.set(storeId, {
      ...feature,
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  async addDependency(storeId: string, dependsOn: string): Promise<void> {
    if (!this.features.has(storeId)) {
      throw new Error(`MemoryStore: unknown storeId '${storeId}'`);
    }
    if (!this.features.has(dependsOn)) {
      throw new Error(`MemoryStore: unknown storeId '${dependsOn}' (dependsOn)`);
    }
    // deps map is always populated in create, so the non-null assertion is safe.
    // Use a fallback to avoid the noUncheckedIndexedAccess-style gap on Map.get.
    const edgeSet = this.deps.get(storeId) ?? new Set<string>();
    edgeSet.add(dependsOn);
    this.deps.set(storeId, edgeSet);
  }

  async list(filter?: FeatureListFilter): Promise<Feature[]> {
    const features = Array.from(this.features.values());
    const filtered =
      filter?.status !== undefined ? features.filter((f) => f.status === filter.status) : features;
    // Return shallow copies to protect internal state.
    return filtered.map((f) => ({ ...f }));
  }
}
