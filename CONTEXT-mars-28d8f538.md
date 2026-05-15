# Context-gathering: why mars-28d8f538 aborted on `too_hard:no-action-after-reads`

- **Parent task:** `mars-28d8f538` — "mars version reads installed release from lockfile" (Slice 1 of 7).
- **Parent PRD:** `51bf3204-version-management-commands-for-the-cons`.
- **This task:** `mars-a21d0cec`, dispatched as the context-gathering child to
  unblock `mars-28d8f538`.

## Read trail recap

The implementor agent for `mars-28d8f538` made 4 consecutive `Grep` calls
plus 1 `Read` against `orchestrator/src/cli.ts` and produced no edit —
the read-span watcher SIGKILLed the session and parked the parent in
`blocked` with this follow-up as its blocker.

## Root cause: the slice's prerequisite foundation does not exist yet

The slice asks the implementor to:

> Print the version recorded in **`mars.lock`** on stdout … or print an
> error mentioning the **missing lockfile** to stderr and exit non-zero.

But the consumer-side install model that defines `mars.lock` — the
framework manifest, the `mars install` writer, and the lockfile schema
itself — has **not landed**. It is tracked separately as idea
`9f87da30-introduce-a-consumer-side-framework-inst`. The parent PRD's
own `notes:` field is explicit:

> Blocked on idea 9f87da30 (consumer-side framework install model:
> manifest + mars.lock + asset-deployment mechanism). **This PRD cannot
> be sliced into tasks until that foundation lands.**

Verification on this worktree:

- `rg -l "mars\.lock|marsLock|MarsLock" --type ts` returns only
  `orchestrator/src/mastra/lib/__tests__/git.test.ts` (a test fixture
  unrelated to a real lockfile reader).
- `rg -i "manifest" --type ts -l` returns init-time stack manifests
  (`package.json` detection), not the framework asset manifest the PRD
  needs.
- No `mars.lock` file or lockfile-shaped module exists anywhere in
  `orchestrator/src/**`.
- No completed or in-flight task in `mars list` corresponds to
  9f87da30's foundation slices.

So when the implementor went looking in `orchestrator/src/cli.ts` for an
existing `readMarsLock` / `loadLockfile` / `resolveInstalledVersion`
helper to wire into a new `version` subcommand, it found nothing — and
correctly refused to invent the schema from thin air, because doing so
would (a) freeze the lockfile shape inside the consumer-facing
`version` command before the install command exists to write a matching
file, and (b) violate the slice's "thinnest path through every layer
needed to satisfy the acceptance criteria" instruction by inventing
*two* new layers (lockfile schema + reader) instead of consuming an
existing one.

## What the implementor needs before this slice can proceed

The foundation from idea `9f87da30` must land first. Concretely:

1. The framework asset manifest (a checked-in file at the framework
   repo root naming every framework-owned file and its consumer-side
   destination).
2. A consumer-side `mars install` writer that copies/symlinks those
   files and writes `mars.lock` with at minimum:
   - `version` — the framework version string
   - `installedAt` — ISO timestamp
   - `mode` — `release` or `dev`
   - `files` — the list of destination paths
3. A library at, e.g., `orchestrator/src/install/lockfile.ts` exporting
   a typed reader (`readMarsLock(repoRoot): MarsLock | null`) plus the
   `MarsLock` type, so that `mars version`, `mars update`, and `mars
   uninstall` can share one source of truth.

Only then can `mars-28d8f538` implement its trivial slice: call the
reader, print `lock.version` on stdout (zero) or write
`"error: mars is not installed in this repo (no mars.lock)"` to stderr
(non-zero).

## Recommendation

- **Do not retry `mars-28d8f538` as-is.** It will keep aborting on
  reads because there is nothing to wire into.
- **Surface the dependency to the operator.** The parent PRD already
  states this dependency in its notes; the slicer that emitted these 7
  slices for PRD `51bf3204` ignored the "cannot be sliced until 9f87da30
  lands" precondition. That precondition should be enforced by the
  slicer (refuse to slice an idea whose `notes:` declares a hard
  upstream dependency on another idea that has no completed slices),
  not absorbed silently by dispatched coders.
- **Next concrete step:** slice idea `9f87da30` into its foundation
  tasks (manifest + writer + lockfile lib), land those, then re-dispatch
  `mars-28d8f538` against a tree that actually has a lockfile to read.

## Why this file exists

The context-gathering follow-up `mars-a21d0cec` was dispatched expecting
either a concise note describing the missing context or a small surgical
edit. A small edit is not appropriate here: the missing piece is an
entire install-model foundation, not a one-line helper. This note is the
artifact, and committing it gives `task/mars-a21d0cec` a non-empty diff
so its own `verify:has-diff` clears and the orchestrator can move on.
