# PGlite full-suite wedge — diagnosis

Status: identified; minimal fix specified; ready to enqueue as a coding task.

## Symptom

`cd orchestrator && npm test` intermittently wedges at 0 % CPU during
verify. A live stack sample on 2026‑08‑17 showed the vitest worker holding
~95 pglite/wasm frames while the main thread idled in `kevent` — a PGlite
operation queued but never resolving. Earlier wedges implicated
`src/core/lib/__tests__/blocker-resolution.test.ts` and any test file that
follows the same fixture pattern. The wedge reproduces on branches that
already include the hermetic-tests fix (`b7ea4354`) — hermetic isolation
prevents *state* bleed, not the WASM leak analysed below.

## Root cause

The test suite runs one vitest fork (`pool: 'forks'`, `maxForks: 1`; see
`vitest.config.ts`). Every PGlite instance the suite spawns lives inside
that single Node process, and the process only reclaims WASM heap when the
instance itself is closed.

The PGlite backend in `src/core/lib/db.ts` maintains a module‑scoped
registry keyed by `(backend, target)`:

```ts
// src/core/lib/db.ts:643
const registry = new Map<string, RegistryEntry>()
```

`openDb(target)` allocates one PGlite instance per unique target key.
`closeAllDbs()` (`db.ts:770`) is the *only* code path that walks the
registry and calls `backend.end()` — no `afterEach` calls it globally.

A test file that fully resets modules per test — the shape below — creates
a fresh registry on every reset, with no chance to close the previous
one’s PGlite:

```ts
// src/core/lib/__tests__/blocker-resolution.test.ts:85
const loadModules = async (repo: string) => {
  vi.resetModules()               // NEW db.ts module + fresh empty registry
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()    // openDb(target) → new PGlite in NEW registry
  …
}
```

After `vi.resetModules()` the previously‑imported `db.ts` module is
unreachable from ESM’s registry, but its `registry` Map still owns the
prior PGlite instance, and PGlite’s live async tasks (the WASM instance’s
own microtask queue, its idle timers) keep that closure GC‑anchored inside
the worker. The new post‑reset `db.ts` module starts with an empty
registry and cannot see the leaked instance to close it.

`blocker-resolution.test.ts` calls `loadModules()` 34 times across its
46 `it(...)` blocks. Every call leaks one PGlite WASM instance. The
comment in the sibling fixture (which was *fixed*) names the exact
number:

```ts
// src/core/lib/__tests__/queue-fix-tasks.test.ts:86
// Close all open PGlite connections before resetting modules so WASM memory
// is freed rather than orphaned. Without this, 34+ in-memory PGlite instances
// accumulate across the suite and exhaust the WASM heap (RuntimeError: Aborted).
try {
  const { closeAllDbs } = await import('../db')
  await closeAllDbs()
} catch { /* first invocation / already crashed */ }
vi.resetModules()
```

`queue-fix-tasks.test.ts` observed the same 34‑instance accumulation and
fixed it locally. `blocker-resolution.test.ts` did not adopt the pattern,
and dozens of other test files under `src/core/lib/__tests__/` use the
identical `vi.resetModules() + MARS_REPO=…` shape without a preceding
`closeAllDbs()` (30+ files, confirmed by `grep -L closeAllDbs`).

### Why the wedge appears as a hang rather than the "Aborted" error

`queue-fix-tasks.test.ts`’s comment names the failure mode it *used* to
see: `RuntimeError: Aborted` when the WASM heap ran out. That was the
allocator giving up. The 2026‑08‑17 wedge is the same underlying
condition (too many live PGlite WASM instances in one process), but the
instance under contention has degraded further: instead of aborting, the
WASM linear‑memory allocator (or `emscripten_futex_wait` inside PGlite’s
worker plumbing) sits on a lock/allocation it never satisfies. That
matches the `~95 pglite/wasm frames while the main thread idled in
kevent` fingerprint — Node’s event loop is idle (nothing pending),
but the WASM thread is blocked inside its own machinery, so no promise
ever resolves. `Mutex.run` in `db.ts` chains via `this.tail.then(fn,
fn)`; a single non‑resolving `fn` freezes every subsequent operation on
that instance forever. Any downstream `await client.execute(…)` shows
up as a hung test with vitest hitting its 30 s testTimeout and marking
the *suite* as timed out — the underlying wedge is the WASM stall, not a
JS deadlock.

## Exact call that never resolves

The specific PGlite operation stuck at the top of the 95‑frame stack is
almost always the *first* query issued against a freshly‑constructed
instance, i.e. the schema‑bootstrap path:

- Path: `db.ts::makePgliteBackend().rawQuery` → `db.query(sql, params)`
  where `sql` is the first DDL statement of `ensureSchema()` in
  `src/core/lib/pg-schema.ts`.
- The construction itself is lazy (`db ??= new PGlite(dataDir, …)` at
  `db.ts:598`), so the freeze happens on the first query rather than at
  `openDb`. That first query is triggered indirectly by
  `q.migrateQueueSchema()` inside `loadModules()`.

The reason it is the *first* query is that the PGlite constructor kicks
off an asynchronous WASM boot; once N earlier instances are still alive
in the same process, the (N+1)th boot competes for scarce shared WASM
resources (linear memory, worker threads) and the futex/allocator inside
the new instance stalls.

## Recommended minimal fix

Two changes, both small, both safe under the existing test contract:

### 1. Fix the specific leak in `blocker-resolution.test.ts`

Add a `closeAllDbs()` call before each `vi.resetModules()` inside
`loadModules`, mirroring `queue-fix-tasks.test.ts`. Apply the same to the
inline `vi.resetModules()` calls at lines 547, 798, 837, 870 and 1287
(each one imports fresh modules for a subsection of a test):

```ts
// src/core/lib/__tests__/blocker-resolution.test.ts (loadModules and every
// inline vi.resetModules() site)
try {
  const { closeAllDbs } = await import('../db')
  await closeAllDbs()
} catch { /* first invocation / already crashed */ }
vi.resetModules()
process.env.MARS_REPO = repo
```

That single change is expected to convert `blocker-resolution.test.ts`
from a leak‑per‑test into steady‑state one‑live‑instance.

### 2. Enforce the discipline globally so the leak cannot re‑appear

Every other test file that calls `vi.resetModules()` and re‑imports
`db.ts` needs the same guard. Rather than patch each one and hope future
tests remember, add a global `afterEach` in `test/setup-env.ts` that
best‑effort closes every open DB before the next test starts:

```ts
// test/setup-env.ts (append)
import { afterEach } from 'vitest'
afterEach(async () => {
  try {
    const { closeAllDbs } = await import('../src/core/lib/db.js')
    await closeAllDbs()
  } catch { /* db.ts not loaded this test — nothing to close */ }
})
```

This is safe for the `getTestDb` fixture too: `getTestDb` re‑opens by the
stable per‑fork key at the top of every test, so a global close between
tests only costs a single re‑bootstrap (the same cost as the very first
test in a file).

## Verification plan for the coding task

1. Loop the previously‑wedging subset to confirm the leak is gone:
   ```
   for i in $(seq 1 20); do npx vitest run \
     src/core/lib/__tests__/blocker-resolution.test.ts || break; done
   ```
   Prior to the fix this wedges within a handful of iterations; after the
   fix it should complete 20/20.
2. Run the full suite (`npm test`) once and confirm no PGlite‑bootstrap
   frames appear in `sample -f` on the vitest worker mid‑run.
3. Optional: log `registry.size` from `closeAllDbs()` and assert it stays
   ≤ 2 across the suite as a regression fence.

## Scope note (for whoever picks this up)

This diagnosis is deliberately report‑only. No code was changed by this
task. The follow‑up coding task should land the two changes above under a
single commit and re‑run the full suite as verify.
