# Feature Store

Mars decouples feature persistence from any specific tracker. The Mars ID
(`<hex>-<slug>`) stays the public handle; an opaque `storeId` points to the
backing record in whatever store is configured.

## Goals

- Mars CLI never imports `bd` (or any tracker SDK) directly.
- Tests run without shelling out.
- Swapping the backing store is a new adapter class, not a refactor.

## Identity

| Field     | Owner | Stable | Public | Example                |
| --------- | ----- | ------ | ------ | ---------------------- |
| `id`      | Mars  | yes    | yes    | `a1b2c3d4-add-oauth`   |
| `storeId` | Store | yes    | no     | `bd-42` (beads today)  |

`storeId` is opaque to Mars: never parsed, never displayed in primary UX.

## Interface (sketch)

`framework/store/feature-store.ts`:

```typescript
export interface StoredFeatureRef {
  storeId: string;
}

export interface FeatureStore {
  create(feature: Feature): Promise<StoredFeatureRef>;
  get(storeId: string): Promise<Feature | null>;
  updateStatus(storeId: string, status: FeatureStatus): Promise<void>;
  addDependency(storeId: string, dependsOn: string): Promise<void>;
  list(filter?: { status?: FeatureStatus }): Promise<Feature[]>;
}
```

The interface exposes only what Mars commands need. Store-specific niceties
(beads' `--design`, `--notes`, labels) stay inside the adapter.

## Adapters

- `framework/store/memory-store.ts` — in-memory, used by unit tests.
- `framework/store/beads-store.ts` — shells out to `bd`, parses `-j` output.

Adapter selection is config-driven (default: beads). For the first cut,
selection happens at the call site; a `mars.config.ts` lookup comes later.

## Schema change

`FeatureSchema` gains:

```typescript
storeId: z.string().min(1).optional()
```

Optional so file-only flows (no store configured) keep working and existing
fixtures don't need backfill.

## Open questions (track in beads, not here)

- Where does the Mars↔store map live for lookup by Mars ID? Frontmatter scan
  on demand vs. a `features/.index.json`. Default: frontmatter scan, optimize
  later if it bites.
- Reconciliation: what if a feature exists in the store but not on disk, or
  vice versa? Out of scope for this cut.
- Direct-store creates (someone runs `bd create` themselves): ignored — Mars
  only sees features it created.

## Out of scope

- Migrating existing draft features into the store.
- Tasks (handled in a follow-up; same pattern, separate `TaskStore`).
- Event/audit log.
