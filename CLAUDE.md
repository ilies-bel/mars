# Mars Framework

Declarative AI coding agents. CLI is `mars` (entry: `framework/cli/main.ts`),
runtime is Bun.

## Plan a feature

Register a new idea as a draft feature. The feature is persisted to disk
(`features/<id>.md`) and registered in the configured backing store (beads
by default).

```bash
mars feature plan "<short goal>"
```

Output:
- `features/<id>.md` — frontmatter (Mars-validated `Feature`) + body
- `id` is `<hex>-<slug>` (Mars-owned, public, stable)
- `storeId` in frontmatter is opaque (today: `mars-framework-NNN` from beads)

The command **fails hard** if the backing store is unavailable (e.g. `bd`
missing or `bd init` not run). No silent file-only fallback — that would
hide drift between the disk and the store.

## Architecture: feature persistence

Mars decouples persistence from any specific tracker via `FeatureStore`
(`framework/store/feature-store.ts`). The CLI never imports `bd` directly;
only `BeadsStore` does.

- `framework/store/feature-store.ts` — interface (`create`, `get`,
  `updateStatus`, `addDependency`, `list`)
- `framework/store/memory-store.ts` — in-memory adapter, used by tests
- `framework/store/beads-store.ts` — production adapter (shells out to `bd`)
- Design notes: `docs/FEATURE_STORE.md`

When writing tests, **inject `MemoryStore`** rather than touching real beads
state:

```typescript
import { MemoryStore } from '../store/memory-store.ts';

const store = new MemoryStore();
const { feature } = await featurePlan(goal, cwd, { store });
```

## Identity rules

| Field     | Owner | Stable | Public | Example                |
| --------- | ----- | ------ | ------ | ---------------------- |
| `id`      | Mars  | yes    | yes    | `a1b2c3d4-add-oauth`   |
| `storeId` | Store | yes    | no     | `mars-framework-abc`   |

`storeId` is opaque to Mars: never parsed, never used as the primary
display handle. If you need a feature, look it up by Mars `id`.

## Common commands

```bash
bun test                              # full suite
bun test framework/store              # store adapters only
bunx tsc --noEmit                     # typecheck (run from framework/)
mars feature plan "<goal>"            # register a draft feature
```

## Conventions

- Bun-style imports: include `.ts` extension
- TS strict mode; explicit types on public APIs
- No `console.log` in library code (`framework/cli/main.ts` is the
  exception — that's the user-facing surface)
- Zod for schemas; infer types from schemas, don't duplicate
- `framework/store/**` and `framework/cli/**` are covered by `tsc --noEmit`
  (see `framework/tsconfig.json`)
