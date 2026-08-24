# arc→task-store cycle: accept as baseline debt (ADR-0101 item 2 amendment)

# arc→task-store cycle: accept as baseline debt (ADR-0101 item 2 amendment)

## Status

Accepted.

## Context

ADR-0101 item 2 proposed extracting `getDefaultTaskStore` / `getDefaultDomainTaskStore`
from `core/store/task-store.ts` into a new `core/store/task-store-default.ts` leaf so
`arc.ts` could drop its value-level import from `task-store.ts`.

Analysis before implementation shows this does not eliminate the cycle:

- `arc.ts` → `task-store-default.ts` (value — the two accessor functions)
- `task-store-default.ts` → `task-store.ts` (value — imports `createTaskStore`)
- `task-store.ts` → `arc.ts` (value — `Arc.createOrigin`, `Arc.load(...)`, ADR-0052)

All three hops are value edges, so dep-cruiser's `no-circular` rule (which excludes
only cycles that exist solely through type-only edges) would flag the longer 3-hop
cycle instead of the current 2-hop one. The extraction relocates the violation without
removing it.

The deeper issue: `task-store.ts → arc.ts` is **correct** per ADR-0052 (Arc is the
sole task-table writer; the task-store facade delegates write verbs to it). And
`arc.ts → task-store.ts` is equally necessary because arc.ts uses
`getDefaultTaskStore`/`getDefaultDomainTaskStore` as its injected persistence seam
throughout the aggregate. These two directions are each justified; neither can be
removed without a structural inversion (e.g. dependency injection at the
composition root) that is out of scope for this slice.

The ADR-0101 "cheap first check" note already hinted at this: "if arc.ts's remaining
need from task-store.ts is only the DomainTaskStore type, write that one import as
`import type`". After the extraction, arc.ts's remaining value import would still be
`getDefaultTaskStore`/`getDefaultDomainTaskStore` — now from `task-store-default.ts` —
so the cycle re-appears at distance 3 instead of distance 2.

## Decision

Accept the `arc.ts → store/task-store.ts` `no-circular` violation as permanent
baseline debt (1 entry in `.dependency-cruiser-known-violations.json`). ADR-0101
items 1 and 3 were completed successfully — the baseline shrank from 201 to 199
entries by removing the `arc→queue` and `arc→queue-retry` cycles. Item 2 is closed
as "accepted debt" rather than "fixed".

A future refactor could eliminate the cycle by inverting the seam: arc.ts receives
its default-store as a parameter at composition time (e.g. via a `setDefaultStore`
initializer called by the daemon startup path) rather than importing the memoised
singleton directly. That refactor touches the daemon startup sequence and is an
architectural concern that warrants its own slice.

## Consequences

- `.dependency-cruiser-known-violations.json` retains exactly 1 `no-circular` entry
  for `arc.ts → store/task-store.ts`. The ratchet mechanism prevents any new entry
  from being added silently.
- ADR-0101 is amended: item 2 is resolved as accepted debt, not as a code change.
- The `arc-sole-writer` allowlist and test suite are unaffected.
