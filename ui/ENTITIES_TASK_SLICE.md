# Context note: extracting the `entities/task` slice (for mars-3d67f5db)

The prior implementor stalled because the brief is a clean mechanical move
on every axis **except one**: the "`entities/task` imports only `@/shared/*`"
invariant is currently unsatisfiable (there is no `@/shared`, and several
moved files have real `@/lib/*` dependencies). Below is the full import
graph, the exact ordered edit list, and an explicit decision on the one
contradictory point so the next run can act without re-reading.

## Files actually involved (verified import graph)

Modules to move into `ui/src/entities/task/`:

| from | to |
|---|---|
| `src/components/TaskCard.tsx` | `src/entities/task/TaskCard.tsx` |
| `src/components/StatusChip.tsx` | `src/entities/task/StatusChip.tsx` |
| `src/components/RoleTag.tsx` | `src/entities/task/RoleTag.tsx` |
| `src/components/PriorityChip.tsx` | `src/entities/task/PriorityChip.tsx` |
| `src/hooks/useTasks.ts` | `src/entities/task/useTasks.ts` |
| `src/lib/group.ts` | `src/entities/task/group.ts` |
| (new) | `src/entities/task/types.ts` |

`ui/src/entities/` does **not** exist yet (empty layer dirs are not tracked
by git — the "already exist" claim in the brief is false but harmless;
just `mkdir -p ui/src/entities/task`). The `@/*` alias **does** exist
(tsconfig `paths` + vite `resolve.alias`), so no config change is needed.

### Internal dependency edges (within the moved set)

- `TaskCard.tsx` → `./RoleTag`, `./StatusChip` (sibling), `@/lib/time`
  (`relativeTime`), `@/lib/types` (`UITask`)
- `StatusChip.tsx` → `@/lib/types` (`TaskStatus`)
- `RoleTag.tsx` → `@/lib/types` (`Role`)
- `PriorityChip.tsx` → **no imports, no importers** (dead code; defines its
  own local `Priority`). Move verbatim; nothing to rewrite for it.
- `useTasks.ts` → `@/lib/api` (`fetchTasks`), `@/lib/group` (`groupTasks` →
  becomes `./group`), `@/lib/sseStatus` (`useSseConnected`), `@/lib/types`
  (`Snapshot`)
- `group.ts` → `./types` (`ColumnKey, Role, Snapshot, Task, UITask`)

### External importers that must be rewritten (the full list — there are no others)

- `src/components/Column.tsx` — **not in the move list but it is an
  importer**. Has `import { TaskCard } from './TaskCard'` and
  `import type { UITask } from '@/lib/types'`. Both must be rewritten.
- `src/pages/ProgressPage.tsx` — `import { useTasks } from '@/hooks/useTasks'`.
  (Its `import { Column } from '@/components/Column'` stays — Column does
  not move.)
- `src/pages/AgentsPage.tsx` — **red herring; needs no change.** It imports
  `../lib/schemas` (`Agent`) and `components/agents/*` only. None move.

`git grep` confirms nothing else references the moved modules or the
task-shaped types from `@/lib/types`. Remaining `@/lib/types` consumers
(`useTodo.ts`, `TodoPage.tsx` for `DraftFeature`) keep working: those
re-exports stay in `lib/types.ts`.

## `types.ts` extraction — the one decision point

`UITask`, `ColumnKey`, `Role`, `Snapshot` are defined **inline** in
`lib/types.ts` (lines 12–33) → move the definitions verbatim into
`entities/task/types.ts`.

`Task` and `TaskStatus` are **zod-inferred in `lib/schemas.ts`** and only
re-exported by `lib/types.ts`. `schemas.ts` is NOT in the move list and
the brief says it stays (it also defines `Agent`/`DraftFeature`/etc.).

**The contradiction:** the brief says `Task`/`TaskStatus` "belong in
`entities/task/types.ts`" AND "`entities/task` may import only from
`@/shared/*`" AND verify #4 forbids any non-`@/shared` `@/` import there.
There is no `@/shared` yet and `schemas.ts` is staying in `lib/`. You
cannot satisfy all of these. The same conflict also hits
`@/lib/time` (TaskCard), `@/lib/api` + `@/lib/sseStatus` (useTasks) — the
brief never addressed those at all.

**Decision (do this — do not silently redefine types):**

`entities/task/types.ts` re-exports the schema-owned types and defines the
UI-only ones:

```ts
// entities/task/types.ts
export type { Task, TaskStatus } from '@/lib/schemas'

export type ColumnKey = 'backlog' | 'in_progress' | 'done'
export type Role = 'planner' | 'builder' | 'reviewer' | 'orchestrator'

export interface UITask {
  id: string
  shortId: string
  title: string
  status: TaskStatus   // import the type locally for this usage
  role: Role
  failed: boolean
  dropReason: string | null
  recoverySpawnedCount: number
  blockerTaskId: string | null
  createdAt: string
  updatedAt: string
}

export interface Snapshot {
  columns: Record<ColumnKey, UITask[]>
  counts: { inProgress: number; todo: number; done: number }
}
```

(Use `import type { TaskStatus } from '@/lib/schemas'` at the top so
`UITask.status` resolves; re-export it as shown.)

Rationale: keeping `schemas.ts` as the single source of truth (brief's
explicit instruction) **wins over** the not-yet-achievable `@/shared`
purity rule. The `@/shared` layer does not exist and moving the zod
schemas is a *later* FSD task (the brief itself defers the
`DraftFeature/StaleWorktree/TodoPayload` cleanup to "task 3"). The
`@/lib/{schemas,time,api,sseStatus}` references from `entities/task` are
**sanctioned temporary exceptions** until a later task introduces
`@/shared`. Redefining `Task`/`TaskStatus` by hand would create silent
drift from the zod schemas and is an architectural decision the
implementor must not make alone.

**Verify check #4 is broken as written.** The literal command
`git grep -nE "from '@/(?!shared)" ui/src/entities/task` uses a PCRE
negative-lookahead under POSIX-ERE (`git grep -E`) and **errors with
exit 128** ("repetition-operator operand invalid") — it can never
"return no matches" regardless of code. Treat its *intent* ("no
unexpected `@/non-shared` imports in `entities/task`") as satisfied by
the sanctioned exceptions above. A correct form would be
`git grep -nP "from '@/(?!shared)" ui/src/entities/task` or
`git grep -nE "from '@/" ui/src/entities/task | grep -v "@/shared"`.
This is filed as a Mars idea (see below) — do not block on it.

## Exact edit list (ordered)

1. `mkdir -p ui/src/entities/task`.
2. Create `entities/task/types.ts` with the block above.
3. `git mv` the 6 files to `entities/task/` (preserves history).
4. Rewrite imports **inside** the moved files (pick relative siblings for
   intra-slice — consistent and short):
   - `TaskCard.tsx`: `./RoleTag`, `./StatusChip` unchanged;
     `@/lib/types` → `./types`; `@/lib/time` unchanged.
   - `StatusChip.tsx`, `RoleTag.tsx`: `@/lib/types` → `./types`.
   - `group.ts`: `./types` unchanged (still resolves post-move).
   - `useTasks.ts`: `@/lib/group` → `./group`; `@/lib/types` → `./types`;
     `@/lib/api` + `@/lib/sseStatus` unchanged.
   - `PriorityChip.tsx`: no change.
5. Rewrite external importers:
   - `Column.tsx`: `from './TaskCard'` → `from '@/entities/task/TaskCard'`;
     `from '@/lib/types'` → `from '@/entities/task/types'`.
   - `ProgressPage.tsx`: `from '@/hooks/useTasks'` →
     `from '@/entities/task/useTasks'`.
6. Trim `lib/types.ts`: drop `ColumnKey`, `Role`, `UITask`, `Snapshot`
   definitions and the `TaskStatus`/`Task` entries from the re-export
   block; **keep** `IdeaSource`, `DraftFeature`, `StaleWorktree`,
   `TodoPayload` re-exports (still consumed by `useTodo`/`TodoPage`).
   Note `lib/types.ts` line 1 (`import type { TaskStatus } from
   './schemas'`) is only needed if something in the trimmed file still
   uses it — after trimming, nothing does, so remove that import too to
   keep `noUnusedLocals` happy.
7. No barrel; old files deleted by `git mv`, not re-exported.
8. Verify from `ui/`: `npm run typecheck`, `npm run build`, and the two
   `git grep` no-match checks for old `@/components|hooks|lib/group`
   paths. Skip/disregard the broken check #4 per above.
9. Commit: `refactor(ui): extract entities/task slice`.

## Net effect

Progress view is visually identical (no behavioural code touched, only
module locations + import specifiers). `ui/` stays buildable.
