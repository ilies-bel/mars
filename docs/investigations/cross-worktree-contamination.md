# Cross-Worktree Contamination — Investigation

**Date:** 2026-07-27  
**Task:** mars-5a01feff  
**Observed on:** 2026-07-26

---

## What Was Observed

Four concurrent recovery (`fix-*`) tasks each correctly committed their own
work to the right branch, but also left uncommitted files in a sibling task's
worktree. The contamination appeared in two clean pairwise swaps:

| worktree | correct HEAD | stray uncommitted files | those files belong to |
|---|---|---|---|
| `mars-e43c98cf` | `ced851bf` chat-fork endpoint | `review-packet.ts`, `review-packet.test.ts`, mods to `task-store.ts` | `mars-d02adc25` |
| `mars-d02adc25` | `35a64d8a` persist ReviewPacket | `chat-store.fork.test.ts`, mods to `chat-store.ts`, `http-server.ts` | `mars-e43c98cf` |
| `mars-6f3fd275` | `c29d08d0` deferrable flag | `worktree-ahead-payload.ts` + test, mods to `blocker-resolution.ts`, `phase-recovery.ts`, `restart-task.ts`, `action-queue-recipes.ts` | `mars-2bb05eb7` |
| `mars-2bb05eb7` | `fc30f795` typed WorktreeAheadPayload | mods to `cli/args.ts`, `cli/commands/task.ts`, `core/lib/pg-schema.ts`, `core/queue.ts`, `daemon/protocol.ts`, `daemon/rpc/handlers.ts` | `mars-6f3fd275` |

The dirty worktrees then failed the merge phase with
`vcs-supervisor-aborted / rebase-dirty-worktree: worktree dirty before rebase`,
which cascaded into a recovery chain that hit the same dirty tree, failed
again, and left the origin stranded in `blocked`.

The same swap was observed earlier between `mars-08173f61`
(credential-store) and `mars-069191bf` (context-gathering-brief).

---

## Mechanism — Named to File and Line

### (a) No filesystem-level sandbox

**File:** `orchestrator/src/core/lib/git/claude.ts`  
**Lines:** 384–396, 445–477, 668

The Claude Code subprocess is spawned at line 668 with only a `cwd` argument —
no `--add-dir` flag, no other sandbox mechanism:

```ts
// claude.ts line 645–668
const result = await runSubprocessStreaming(
  resolveClaudeBin(),
  claudeStreamArgs(prompt, { model, systemPrompt, sessionId, ... }),
  cwd,        // ← the worktree path; the ONLY confinement signal
  ...
)
```

`claudeStreamArgs` (lines 445–477) builds the full CLI arg list. There is
no `--add-dir` in it. The full permission mode is
`--dangerously-skip-permissions` (line 428), which disables per-write
approval. The code comment at lines 384–396 documents this explicitly:

```ts
// --add-dir sandbox, so nothing but instruction stops it writing elsewhere on
// disk. Critically, --setting-sources project,local loads the consumer repo's
// CLAUDE.md, which is written for INTERACTIVE humans and says things like
// "cd back to the repo root" / "always operate from the repo root". A worker
// that obeys that literally cd's out of its worktree into the PRIMARY checkout
// (which sits on the integration branch) and edits there…
```

### (b) Instructional-only confinement is not enforced at the filesystem level

**File:** `orchestrator/src/core/lib/git/claude.ts`  
**Lines:** 395–396, 413–418

The countermeasure is `WORKTREE_CONFINEMENT_SYSTEM_PROMPT` (line 395),
which tells the worker to stay in its worktree. This directive is prepended
to every dispatched worker's system prompt via `composeSystemPrompt`
(line 413). However, it is purely instructional; Claude Code respects it
as a soft guideline and can be overridden by other instructions it encounters
at runtime.

### (c) `--setting-sources project,local` loads the primary checkout's CLAUDE.md

**File:** `orchestrator/src/core/lib/git/claude.ts`  
**Lines:** 460–461

```ts
'--setting-sources',
'project,local',
```

This flag causes Claude Code to discover and load the `CLAUDE.md` file
from the consumer project (the primary checkout on `main`). That `CLAUDE.md`
is written for interactive human sessions and contains guidance like
_"Never `cd`"_ (which ironically means the CLAUDE.md itself navigates
users around the repo). The `WORKTREE_CONFINEMENT_SYSTEM_PROMPT` attempts
to countermand this, but both instructions are in the same model context;
under task pressure or confusing error messages, the agent may follow the
CLAUDE.md.

### (d) The recovery prompt path resolves correctly; the write path diverges

**File:** `orchestrator/src/workflows/primitives/index.ts`  
**Lines:** 481–560 (`attachOriginWorktreeForFix`), 844–850, 940

Recovery (`kind=fix`) tasks attach to their origin's worktree via
`attachOriginWorktreeForFix` (line 481). This reads the origin task row from
the DB (line 488), fetches `origin.worktreePath` (line 490), and calls
`attachToOriginWorktree` (line 499). The fix task's own DB row is then
updated to the same path (lines 606–609). The in-memory `worktreeCache`
WeakMap (line 466) is also keyed on the fix task's `ctx` and correctly
points to the origin's worktree.

In `runAgent`:
- Line 844: `resolveWorktree` returns the origin's path (from cache or DB)
- Line 850: `worktreePath = worktree.path`
- Line 940: `cwd: worktreePath` — subprocess is **started** in the correct
  origin worktree

The DB assignment and the `cwd` are both correct. The contamination happens
after the subprocess starts: git operations use absolute `git -C <abs-path>`
flags (which land in the right tree), but `Edit`/`Write` tool calls are
relative to the process CWD. If the agent navigates away from its starting
CWD (e.g. by following a `cd` command in a `Bash` tool call), all subsequent
`Edit`/`Write` calls resolve against the new directory.

### (e) How an agent reaches a sibling worktree

Once an agent navigates to the primary repo root (following CLAUDE.md's
"operate from the repo root" guidance), the directory `.mars/worktrees/` is
fully visible and traversable. Sibling worktrees appear as peer directories
alongside the agent's own:

```
<repo-root>/.mars/worktrees/
  mars-e43c98cf/   ← agent A's tree
  mars-d02adc25/   ← sibling tree
  mars-6f3fd275/   ← another sibling
  mars-2bb05eb7/   ← another sibling
```

A recovery prompt includes the full original task prompt plus a failure
excerpt (from `failureExcerpt` in shared.ts lines 353–360). Under concurrent
recovery the failure output may contain file paths, task IDs, or branch names
from other concurrent tasks visible in log output. An agent that constructs
an absolute path from one of these cross-task references, or that accidentally
processes a path from a concurrent task's output, will write into the wrong
worktree without any filesystem-level rejection.

The "pairwise swap" pattern (each worktree ends up with the other's files) is
consistent with two concurrent agents that each navigated to the repo root and
each erroneously wrote into the other's directory — plausibly because each
agent's context contained a reference to the sibling task's files (e.g. in
error messages that mentioned file paths from parallel runs that logged to a
shared stdout).

### (f) No module-level mutable state is involved

**File:** `orchestrator/src/workflows/primitives/index.ts`  
**Lines:** 262, 287

The `traceCache` (line 262) and `worktreeCache` (line 287) are both
`WeakMap<object, …>` keyed on `ctx`, a fresh object per workflow run.
They cannot bleed between concurrent tasks.

**File:** `orchestrator/src/core/context.ts`  
**Line:** 81 (`let cached: OrchestratorContext | null = null`)

The `resolveContext` singleton holds the primary repo root and state dir —
constant across the daemon's lifetime. It does not hold a per-task worktree
path and is not a factor in the contamination.

---

## Answers to the Four Questions

### (a) Mechanism, named to file and line

The contamination occurs because `claudeStreamArgs` in
`orchestrator/src/core/lib/git/claude.ts` (lines 445–477) does **not**
include an `--add-dir <worktreePath>` flag (or equivalent filesystem
sandbox). The subprocess is started with `cwd: worktreePath` (primitives
line 940), which is the correct worktree root, but nothing at the filesystem
level prevents the Claude Code process from writing to paths outside that
directory. The only confinement mechanism is the `WORKTREE_CONFINEMENT_SYSTEM_PROMPT`
(claude.ts lines 395–396), which is purely instructional. When the agent
follows conflicting guidance from `--setting-sources project,local`'s
`CLAUDE.md` (claude.ts line 460), it may navigate to the repo root, where
all concurrent worktrees are visible under `.mars/worktrees/`, and write
to a sibling.

**Primary defect site:** `orchestrator/src/core/lib/git/claude.ts`, the
`claudeStreamArgs` function at lines 445–477 — specifically, the absence
of `--add-dir <worktreeRoot>` before the `-p` argument.

### (b) Normal coder runs or only recovery runs?

**Both paths are affected in principle.** The missing `--add-dir` sandbox
applies to every dispatched worker, coder and fixer alike. Normal coder runs
are lower-risk because their task prompts do not typically contain file paths
from concurrent tasks. Recovery runs are higher-risk because:

1. The recovery prompt embeds the origin task's failure output via
   `failureExcerpt` (shared.ts lines 353–360), which may contain file paths,
   branch names, or task IDs from other concurrently running tasks that
   appeared in shared log output.
2. Multiple recovery tasks were dispatched simultaneously in the observed
   incident, making cross-contamination more likely.

The earlier swap between `mars-08173f61` and `mars-069191bf` (also recovery
runs) confirms this is a repeatable recovery-run pattern, not a one-off.

### (c) Concurrency-dependent?

**Yes, strictly concurrency-dependent.** The contamination requires at
minimum two tasks with open worktrees simultaneously. A single running task
cannot contaminate a nonexistent sibling. The pairwise swap pattern (each of
two concurrent tasks lands the other's files) is the signature of two agents
that each exited their own worktree and wrote into the other's directory
while both were running in parallel.

### (d) Minimal fix and merge-phase handling

**Minimal fix:** Pass `--add-dir <worktreeRoot>` to the Claude Code subprocess.
This is a one-line change to `claudeStreamArgs` in
`orchestrator/src/core/lib/git/claude.ts`:

```ts
// Proposed addition — insert after the session-id flags:
...(options.addDir ? ['--add-dir', options.addDir] : []),
```

…and thread `addDir: worktreePath` from `runAgent` through
`runWorkerWithSpan` → `worker.run` → `runClaudeCode` → `claudeStreamArgs`.

With `--add-dir` set, the Claude Code process's `Edit`/`Write` tools would
reject any path outside the worktree root at the filesystem-access layer,
making the confinement structural rather than instructional-only. This
prevents contamination even if the agent follows a `cd` to the repo root.

> **Caveat:** confirm the `--add-dir` flag is available in the pinned Claude
> Code CLI version before shipping. If it is not available, a short-term
> workaround is to strip the `--setting-sources project,local` flag for
> dispatched workers so the primary checkout's `CLAUDE.md` is not loaded
> (losing project-level context), or to mount each worktree under a
> per-agent `HOME` with symlinks so the repo root is not reachable.

**Should the merge phase treat "stray unrelated files" as a recoverable
condition rather than a hard abort?**

Currently the merge step aborts with `rebase-dirty-worktree` whenever the
worktree is dirty, regardless of whose files those are. The stricter failure
cascades into a recovery task that hits the same dirty tree, fails again,
and strands the origin in `blocked`.

An improvement would be a pre-rebase contamination check:

1. Enumerate the dirty files (`git status --porcelain`).
2. Cross-reference against the task's declared `spec.files` (from the DB).
3. If all dirty files are absent from `spec.files`, classify as
   _contamination_ rather than _incomplete work_ and auto-clean them
   (`git checkout -- <files>` or `git clean -f`) before proceeding with
   the rebase.

This makes the merge phase self-healing for the contamination class, prevents
the false-positive recovery cascade, and preserves the existing hard abort
for genuinely dirty worktrees (i.e., where the dirty files ARE related to
the task's spec and may represent real uncommitted work). This secondary
fix is useful but should be pursued as a follow-up task; it is not a
substitute for the `--add-dir` structural fix.

---

## Summary Table

| Question | Answer |
|---|---|
| Defect site | `orchestrator/src/core/lib/git/claude.ts` lines 445–477: `claudeStreamArgs` omits `--add-dir <worktreeRoot>` |
| Affects normal coders? | Yes in principle; lower-risk because prompts lack cross-task paths |
| Affects recovery coders? | Yes, higher-risk; failure excerpts can embed sibling-task paths |
| Concurrency-dependent? | Strictly yes — requires ≥2 open worktrees simultaneously |
| Minimal fix | Add `--add-dir <worktreePath>` to `claudeStreamArgs`; thread path from `runAgent` line 940 through the call stack |
| Merge phase hardening | Pre-rebase contamination check: auto-clean stray files not in task's `spec.files` instead of hard-aborting (follow-up task) |
