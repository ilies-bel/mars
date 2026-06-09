# Slice 1 of PRD 2b8e1d21 — stale premise, schema mismatch

**Task:** `mars-b44a45fc` — *Agent registry foundation* (Slice 1 of 6 for
PRD `2b8e1d21-implement-the-agent-live-board-in-pencil`).

**Status:** The previous dispatch was aborted with
`too_hard:no-action-after-reads` after grepping for
`WRITER_SYSTEM_PROMPT|getAgentSpec|from '.*agents'` and reading
`implement-workflow.ts` three times. The grep nominally matches but the
implementor stalled because the slice text contradicts the codebase in
three ways. This note resolves all three so the next dispatch can act.

## What's already on `main`

The typed agent registry already exists at
`orchestrator/src/core/agents/index.ts`. It exports:

- `AgentSpec` — the record interface
- `agents` — the readonly map
- `getAgentSpec(name)` — lookup-by-name, throws on unknown
- A single entry: `vcs-supervisor` (landed by PRD `4c078ac3`, see the
  sibling note `MARS-8d598c58-CONTEXT.md` in this directory).

`vcs-supervisor` is **not** stale work to remove. Leave it in place.

## Where the Writer's "previously inlined prompt constant" lives

The slice acceptance criteria call for "the previously inlined writer
prompt constant" to be replaced by a reference into the registry. That
constant is:

- `WRITER_SYSTEM_PROMPT` — exported from
  `orchestrator/src/core/workflows/implement-workflow.ts` (around line
  182).
- It is the system prompt injected when the implement workflow dispatches
  a `writer`-tagged task (see the same file's `codeStep`, around line
  669: `systemPrompt: tag === 'writer' ? WRITER_SYSTEM_PROMPT : undefined`).

There is also `WRITER_FOOTER` (line 164 of the same file). That one is a
**user-prompt footer**, not a system prompt, and is *not* what the slice
is asking about. Leave `WRITER_FOOTER` alone.

The grep for `WRITER_SYSTEM_PROMPT` matches *this file* literally; if a
previous dispatch missed it, it was scoped to `**/agents/**` or similar.
Search the whole `orchestrator/src` tree.

## Workers vs. agents — disambiguation

The existing capital-W `Writer` in
`orchestrator/src/core/workers/index.ts` (`WorkerName = ... | 'Writer'`)
is a different thing: a Worker is the pinned `claude -p` configuration
(model / effort / permissionMode / disallowedTools) used by
the implement workflow to dispatch a stage. It carries **no** system
prompt — that comes from `WRITER_SYSTEM_PROMPT` injected per-invocation.

This slice is about the **AgentSpec registry** (system prompts, tools,
model — the data the Agent Live Board UI will render), not the Worker
config registry. The two are deliberately separate; do not merge them.

The Writer's allow/deny posture in the AgentSpec entry should mirror the
Worker config:

- `allowedTools`: everything except the denied set (the framework
  enforces denial; the allow list is informational for the UI). A
  reasonable shape is `['Read', 'Grep', 'Glob', 'Bash']`.
- `deniedTools`: `WRITER_DENIED_TOOLS` from `workers/index.ts`
  (`['Edit', 'Write', 'NotebookEdit']`).
- `model`: `'claude-haiku-4-5-20251001'` (the Writer Worker's pinned
  model — see `CLAUDE_HAIKU_MODEL` in `workers/index.ts`).

## Schema mismatch — `id`/`displayName` vs. `name`/`description`

The slice's acceptance criteria say:

> The writer agent's record exposes id, displayName, and a non-empty
> systemPrompt string …

The existing `AgentSpec` interface uses `name` (typed as `AgentName`,
the stable identifier) and `description` (optional human label). To
satisfy the slice without breaking the existing `vcs-supervisor` consumer
and tests, do **one** of:

1. **(Recommended)** Add an optional `displayName?: string` field to
   `AgentSpec`, leaving `name` as the stable id. Treat `name` as the
   `id` for the UI. Update the `vcs-supervisor` entry to set
   `displayName: 'Vega (VCS Supervisor)'` (or similar) so both entries
   render uniformly.
2. Rename `name` → `id` and add `displayName`. This is a wider blast
   radius — every `agents['vcs-supervisor']` / `getAgentSpec` call site
   and the tests in `agents/__tests__/` would need to move too. Per
   CLAUDE.md "every change is a hard cut", that's fine, but it's more
   churn than the slice needs.

Pick option 1 unless you have a reason to pick option 2.

The "tools" field the slice mentions is already covered by
`allowedTools`/`deniedTools`. You can either expose those directly or
add a derived getter; the slice doesn't constrain that.

## "Exactly one agent today (the writer)" — read as additive

The slice text says the registry should contain "exactly one agent today
(the writer)". This is stale relative to `main`: `vcs-supervisor` is
already there. **Do not delete `vcs-supervisor`.** Read the criterion as
"the writer entry must be present"; the `agents` array will contain two
entries (vcs-supervisor + writer) after this slice. Update the
acceptance-criteria test to assert presence of both, not "length === 1".

If the orchestrator's verify gate trips on the criterion as literally
worded, note the deviation in the commit message.

## Recap — the path forward for the next dispatch

1. In `orchestrator/src/core/agents/index.ts`:
   - Add optional `displayName?: string` to `AgentSpec`.
   - Add a `writer` entry whose `systemPrompt` is the value of
     `WRITER_SYSTEM_PROMPT` (import from
     `../workflows/implement-workflow.ts`).
   - Set the `writer` entry's `model`, `allowedTools`, `deniedTools` as
     described in the *Workers vs. agents* section above.
   - Extend `AgentName` to `'vcs-supervisor' | 'writer'`.
2. In `orchestrator/src/core/workflows/implement-workflow.ts`:
   - Replace the inlined `WRITER_SYSTEM_PROMPT` constant with a
     reference to `getAgentSpec('writer').systemPrompt` (re-export under
     the old name if call sites need it).
3. In `orchestrator/src/core/agents/__tests__/registry.test.ts`:
   - Add a test asserting the `writer` entry exists and exposes a
     non-empty `systemPrompt`, plus the generic "every entry has id +
     displayName + systemPrompt" test the slice asks for.
4. Verify with the test command the PRD names (typically
   `npm test -- src/core/agents/__tests__/registry.test.ts` from
   `orchestrator/`).

## Implication for sibling slices

Slices 2–6 of PRD `2b8e1d21` likely thicken this registry (more agents)
and wire it into the UI. Re-check each against `main` before dispatch
once this slice lands — the schema shape decided here will ripple.
