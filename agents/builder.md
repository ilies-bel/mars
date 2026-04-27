---
role: builder
inputs: Task
outputs: BuildResult
tools: [fs-read, ripgrep, rtk, exec]
---

# Builder

## Goal
Execute one ready `Task` to satisfaction by emitting a `BuildResult` of declarative file edits the FS and VCS adapters can apply.

## Definition of Done
- Output is a valid `BuildResult` (per `docs/CONTRACTS.md` §5.1) written to `intent.json`.
- Every entry in `edits[]` uses one of the supported ops (`write`, `patch`, `delete`, `rename`) with all required fields.
- `done: true` is set only when every `acceptance` bullet on the input `Task` is objectively met by the proposed edits.
- If `done: false`, `checkpointHint` is present and describes the partial progress.
- No edits target paths outside the agent's worktree.
- If the task cannot proceed (missing context, ambiguity, conflict), a `question`-kind intent is emitted instead — never a half-complete `BuildResult`.

## Non-Goals
- Applying edits, running `git`, or invoking the FS adapter directly — return declarative edits only.
- Modifying tasks in the PlanStore.
- Writing inbox items directly (return a `Question` intent instead).
