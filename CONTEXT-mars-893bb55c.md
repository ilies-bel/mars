# Context for mars-893bb55c — Rename idea→proposal (UI, skills, docs, glossary)

The first dispatch of mars-893bb55c aborted with `too_hard:no-action-after-reads`
after 5 identical Globs of the worktree root produced no actionable file list.
The task is broad but tractable once you have the inventory below. **Read this
note first, then act — do not re-discover the file set.**

## Worktree

When dispatched, you will be inside
`/Users/ib472e5l/project/perso/mars-framework/.mars/worktrees/mars-893bb55c`
on branch `task/mars-893bb55c`. The file paths below are relative to that
worktree root.

## Out-of-scope (do NOT touch in this slice)

- The `mars` CLI binary itself (orchestrator/CLI source under
  `orchestrator/src/` other than the init templates listed below). CLI
  renaming is a different slice of PRD 208a283c — slice 3 (this one) only
  covers operator-visible surfaces *outside* the CLI binary.
- Historical ADRs. Leave **every** existing file under `docs/adr/`
  untouched — they are historical record. The spec calls out
  `0001/0006/0008/0010` explicitly; the same principle applies to
  `0015-idea-task-block-edges-allowed-task-idea-still-rejected.md` and
  any other existing ADR that mentions "idea".
- `VISION.md`, archived `UNBLOCK-mars-*.md`, `CONTEXT-mars-*.md`,
  `NOTE-mars-*.md`, `NO-DIFF-mars-*.md`, `HITL-CHECKPOINT-*.md`,
  `docs/diagnostics/*` — all historical artifacts.

## In-scope file inventory

### 1. UI (`ui/src/**`) — must show "Proposal"/"proposals" in operator text

- `ui/src/pages/TodoPage.tsx` — headings, labels, body copy.
- `ui/src/lib/types.ts` — rename TS types/fields that surface as labels
  (e.g. an `Idea` interface → `Proposal`); leave wire fields that map to
  the SQLite schema alone unless the schema itself was already renamed
  by an earlier slice. If the schema still has `idea` columns, leave
  the type field names alone and only rename the operator-facing
  display strings. Verify with `git log --oneline -- .mars/state.db` /
  the slicer migration files before touching field names.
- `ui/src/lib/schemas.ts` — same caveat as `types.ts`.
- `ui/src/lib/focusSubgraph.ts` and `ui/src/lib/focusSubgraph.test.ts` —
  rename local identifiers and test descriptions that refer to "idea"
  conceptually; keep test behaviour identical.

Verify the UI compiles after edits: `cd ui && npm run build` (or whatever
the worktree's `ui/package.json` defines — check `scripts` first).

### 2. Skills under `.claude/skills/` — body text + embedded CLI calls

All six SKILL.md files reference "idea(s)" in their prose **and** contain
embedded shell snippets calling `mars idea …`. Rewrite both:

- `.claude/skills/mars:unblock/SKILL.md`
- `.claude/skills/mars:to-prd/SKILL.md`
- `.claude/skills/mars:reflect/SKILL.md`
- `.claude/skills/mars:inbox/SKILL.md`
- `.claude/skills/mars:grill/SKILL.md`
- `.claude/skills/mars:deep-reflect/SKILL.md`

Apply the same rewrite to the **template copies** under
`orchestrator/src/init/templates/claude/skills/<same six>/SKILL.md` so
fresh `mars init` runs ship the renamed terminology.

The PRD also names `/mars:next` as in-scope — search for a
`mars:next/SKILL.md`; if it doesn't exist in either the live skills dir
or the templates dir, treat that bullet as N/A and note it in the
commit message rather than inventing a new skill.

Embedded CLI calls inside skill bodies should read `mars proposal …`.
Note: the CLI binary itself is renamed in a different slice; these
skill bodies will be stale until that slice lands. That is acceptable —
do not block on it.

### 3. Documentation prose

- `CLAUDE.md` (root) — "idea" references in the Loose-ends section and
  elsewhere become "proposal".
- `README.md` (root)
- `orchestrator/README.md`
- `orchestrator/src/mastra/daemon/SHUTDOWN.md`
- `orchestrator/src/init/templates/CLAUDE.md`
- `design/dependency-graph/ia-decision.md`

For each: rewrite prose mentions of "idea(s)" to "proposal(s)". Leave
any quoted command names (`mars idea add`) until/unless the CLI rename
slice has landed — if the doc embeds a literal CLI invocation, switch
it to `mars proposal …` to match the renamed skills, accepting the same
temporary staleness.

### 4. Glossary (`CONTEXT.md`)

**Do not edit `CONTEXT.md` directly** — use the CLI:

```
mars glossary remove "Idea"
mars glossary set "Proposal" "A draft of work to do, persisted in
.mars/state.db, regardless of who proposed it; every Proposal carries a
source — reflection (synthesized by mars reflect / deep-reflect from past
task signals), human (created by the user), or planner (raised by the
planner agent when it spots a gap while refining another Proposal)." \
  --avoid "idea, suggestion"
```

Other glossary entries that mention "idea" inside their definition body
(e.g. **TODO page**, **originId**, **Arc**, **draft (idea)**,
**prd-ready (idea)**, **sliced (idea)**, **dismissed (idea)**,
**Idea dependency**) should be rewritten too via `mars glossary set` —
each one re-set with the body using "proposal". The parenthetical
qualifiers like `(idea)` in entry names also change to `(proposal)`.

After all glossary edits, sanity-check with `mars glossary list` and
diff `CONTEXT.md` to confirm the changes landed.

### 5. New ADR

Add a single ADR documenting the rename:

```
mars adr add "Rename the idea domain term to proposal" \
  --context "<one paragraph: ideas were structured, lifecycle-tracked entities; the noun should match>" \
  --decision "<one paragraph: all operator surfaces read 'proposal'; historical ADRs preserved>" \
  --consequences "<short list>"
```

Read `mars adr add --help` first — the flag names may differ; match
what the binary actually accepts. Do not create the file by hand under
`docs/adr/`.

## Suggested order

1. Glossary edits via `mars glossary` (smallest blast radius, easiest to verify).
2. New ADR via `mars adr add`.
3. Skills rewrites (live + templates) — one file at a time.
4. Docs prose rewrites.
5. UI rewrites + `npm run build` check.
6. `git add -A && git commit -m "rename idea→proposal across operator surfaces (slice 3/4 PRD 208a283c)"`.
7. Self-check commit count per the brief's tail.

## When to bail out

If after working through items 1–4 the UI rename in step 5 turns out to
require renaming SQLite-backed types/fields (i.e. the underlying schema
still uses `idea`), STOP. File `mars task add "Rename idea→proposal in
ui/src TS types backed by SQLite schema (waits on schema rename slice)"
--blocked-by $TASK_ID` and commit whatever non-schema-coupled work is
already complete. Do not attempt the schema rename here — that is a
separate slice of PRD 208a283c.
