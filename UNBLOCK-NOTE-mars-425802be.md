# Unblock note for mars-425802be (ui knip cleanup)

The previous implementor was aborted after reading the 5 source files
without acting. They left `ui/src/components/PriorityChip.tsx` deletion
**staged but uncommitted**. Pick up from there.

## Current state

```
git status   # PriorityChip.tsx staged for deletion, nothing else
```

## What knip reports (verified 2026-05-17)

Run `npm --prefix ui run knip` — config is correct (entries cover
Vite client via `index.html` → `src/main.tsx`, server via
`server/index.ts` reachable from `bin/mars-ui.mjs`, plus test files).
**Trust the report** for unused files/exports/types. Do not re-read all
files trying to second-guess it — that's what got the last run aborted.

### Unused files
- `ui/src/components/PriorityChip.tsx` — already staged for deletion.

### Unused dependencies (remove from `ui/package.json`)
- `@fontsource/inter`
- `@fontsource/jetbrains-mono`

### Unused devDependencies
- `tailwindcss` — **FALSE POSITIVE, do NOT remove.** Used via
  `@tailwindcss/vite` plugin and `styles/index.css`. If knip keeps
  flagging it, add to `ignoreDependencies` in `ui/knip.json` with a
  comment.

### Unused exports — drop the `export` keyword (or delete entirely if
the symbol isn't referenced internally either)
- `server/events.ts:17` → `EVENT_FEED_LIMIT`
- `src/lib/schemas.ts:3` → `taskStatusSchema`
- `src/lib/schemas.ts:15` → `ideaSourceSchema`
- `src/lib/schemas.ts:17` → `draftFeatureSchema`
- `src/lib/schemas.ts:29` → `taskPlanSchema`
- `src/lib/schemas.ts:36` → `taskSchema`
- `src/lib/schemas.ts:51` → `staleWorktreeSchema`
- `src/lib/schemas.ts:67` → `agentSchema`
- `src/lib/time.ts:21` → `formatRelativeAge`

### Unused exported types — same: drop `export` or delete
- `server/db.ts:14` → `IdeaSource`
- `server/db.ts:28` → `TaskRow`
- `server/events.ts:3` → `EventKind`
- `src/lib/focusSubgraph.ts:25` → `NodeKind`
- `src/lib/focusSubgraph.ts:26` → `EdgeKind`
- `src/lib/focusSubgraph.ts:28` → `GraphNode`
- `src/lib/focusSubgraph.ts:34` → `GraphEdge`
- `src/lib/schemas.ts:83` → `IdeaSource`
- `src/lib/types.ts:5` → `IdeaSource`
- `src/lib/types.ts:8` → `StaleWorktree`
- `src/lib/types.ts:9` → `TodoPayload`

## Recommended order (each step a separate commit)

1. Commit the already-staged `PriorityChip.tsx` deletion.
2. Drop unused exports in `src/lib/schemas.ts` (largest batch — one
   commit). Run `npm --prefix ui run typecheck && npm --prefix ui run knip`.
3. Drop unused exports in `src/lib/time.ts`, `src/lib/types.ts`,
   `src/lib/focusSubgraph.ts`, `server/events.ts`, `server/db.ts`. One
   commit per file is fine; small is reviewable.
4. Remove the two `@fontsource/*` deps from `ui/package.json` + run
   `npm install --prefix ui` to update the lockfile. Commit.
5. **Delete this UNBLOCK-NOTE.md** in the final commit.
6. Final verify: `npm --prefix ui run knip && npm --prefix ui run
   typecheck && npm --prefix ui run build && npm --prefix ui run test`.

## Important

- Do NOT delete `tailwindcss`.
- Do NOT re-read every export file before acting — the knip report is
  the source of truth. Read a file only if you need to see what's
  *around* the export to decide between "drop `export`" vs "delete the
  whole symbol" (if it's still referenced internally, just drop the
  keyword).
- Commit between steps; don't pile all deletions into one giant change.
