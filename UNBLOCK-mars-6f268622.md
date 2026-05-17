# Unblock note for mars-6f268622 (Slice 4 — hook-based starting-context capture)

The previous implementor was aborted after 5 reads with no action:

1. `orchestrator/src/init/templates/claude/hooks-notes.md`
2. `orchestrator/src/mastra/lib/deep-reflector.ts`
3. `orchestrator/src/cli.ts`
4. `orchestrator/src/mastra/lib/deep-reflect-query.ts`
5. `Grep orchestrator/src` (looking for `SessionStart` / existing capture
   scaffolding — there is none)

They stalled because the slice's premise — "capture project instructions,
system reminders, deferred-tool list, MCP instructions, and skills list via
hooks" — is broader than what Claude Code's hook surface can actually
deliver, and no scaffolding for any of it exists yet. **Don't burn another
read budget re-discovering this.** Use the punch list below to act
immediately.

## What exists today (do not re-grep)

- **Hook templates.** `orchestrator/src/init/templates/claude/hooks/` has
  only `warn-raw-queue-sql.sh` (PreToolUse Bash matcher). `settings.json`
  in the same dir wires that one hook. There is **no** SessionStart hook,
  no per-event JSON capture script, no record-writing shell glue.
- **Hook docs.** `hooks-notes.md` documents user-level grep/find rewriter
  hooks at `~/.claude/hooks/`. Irrelevant to this slice.
- **DB tables.** `task_signals` (token totals per step) and
  `task_transcripts` (full conversation JSON) live in
  `orchestrator/src/mastra/queue.ts:391+` and `:531+`. There is **no**
  `task_starting_context` (or similarly named) table yet — you create it.
- **Headless dispatch.** `runClaudeCode` in
  `orchestrator/src/mastra/lib/git.ts:558` is the single entry point.
  Sessions get a `sessionId` (caller-supplied or extracted post-hoc from
  the stream). It builds env via `buildWorkerEnv()` — that's the place
  to inject a per-run capture toggle.
- **Toggle precedent.** `MARS_REFLECT_DISABLED=1` is the existing global
  off-switch (see `reflect-signals.ts:4` `isReflectDisabled`). Match the
  shape: a single env var, checked at the capture call site, gated also
  by a per-run override that the orchestrator sets on dispatch.
- **Session-id history.** `tasks.claude_session_ids` already holds the
  append-only history of session ids per task (queue.ts:259). Records
  must key off the session id, not the task id — a task can have several.

## Reality of Claude Code's hook surface (don't promise what can't ship)

Claude Code hooks fire on these events: `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`,
`Notification`. The hook payload contains the event + tool args, **not**
the rendered system prompt or the model's deferred-tool list.

Mapped against the acceptance criteria:

| Context item             | Hook-capturable?                                          |
| ------------------------ | ----------------------------------------------------------|
| Project instructions     | **Yes** — SessionStart hook can read `CLAUDE.md` from `$CLAUDE_PROJECT_DIR` itself. |
| System reminders         | **No.** Injected by the Claude Code runtime; never exposed to hooks. |
| Deferred-tool list       | **No.** Constructed by the SDK; not in any hook payload. |
| MCP instructions         | **Partial.** SessionStart hook can read `.mcp.json` and any project `mcp` config files, but not the resolved server-instructions strings the model actually sees. |
| Skills list              | **Yes** — SessionStart hook can list `~/.claude/skills/` and `$CLAUDE_PROJECT_DIR/.claude/skills/`. |

So three of the five items get real captures; the other two must land
with the explicit "capture not available" marker that AC #5 demands.

## Suggested tracer-bullet vertical (one test → one path end-to-end)

Pick **project instructions** as the central acceptance criterion (it's
the cleanest hook path and it tests every layer):

1. **Schema.** In `queue.ts`, add a `task_starting_context` table:
   ```
   session_id TEXT NOT NULL,
   task_id    TEXT,                 -- nullable: hook may not know it
   kind       TEXT NOT NULL,        -- 'project_instructions' | 'system_reminders' | 'deferred_tools' | 'mcp_instructions' | 'skills_list'
   content    TEXT,                 -- nullable when status='unavailable'
   status     TEXT NOT NULL,        -- 'captured' | 'unavailable'
   recorded_at TEXT NOT NULL,
   PRIMARY KEY (session_id, kind)
   ```
   plus an index on `task_id`.
2. **CLI verb.** Add `mars context capture --session <id> --kind <k>
   [--task <id>] [--from-file <path>|--from-stdin|--unavailable]`. This
   is the supported entry point the hook calls — no raw SQL. The verb
   gates on `isCaptureDisabled()` (mirror `isReflectDisabled`) and on a
   per-session override file written by the dispatcher (see step 4).
3. **Hook script.** `orchestrator/src/init/templates/claude/hooks/
   capture-starting-context.sh` — a SessionStart handler that:
   - exits 0 immediately if `MARS_CAPTURE_CONTEXT_DISABLED=1` **or** the
     per-session override marker is present;
   - calls `mars context capture --kind project_instructions
     --from-file "$CLAUDE_PROJECT_DIR/CLAUDE.md" --session "$session_id"`;
   - calls `mars context capture --kind skills_list --from-stdin` with a
     `find` listing of skills dirs;
   - calls `mars context capture --kind system_reminders --unavailable`
     and same for `deferred_tools` (and `mcp_instructions` until we wire
     `.mcp.json` reading) — these are the "explicit marker" rows AC #5
     requires.
4. **Per-run toggle.** In `runClaudeCode`'s `buildWorkerEnv()` (or a
   sibling), thread an `args.captureContext?: boolean` flag. When false,
   set `MARS_CAPTURE_CONTEXT_DISABLED=1` in the child env so the hook
   no-ops.
5. **Wire into settings.json template.** Add a `SessionStart` hooks
   block referencing the new script. Existing `PreToolUse` block stays.
6. **Test.** One behavioural test: dispatch a `runClaudeCode` against a
   fixture worktree with the templates installed and a stub `mars`
   binary on PATH that just appends its argv to a log file; assert the
   log contains one invocation per kind with the correct
   `--session <sid>`, and that flipping the env off produces an empty
   log. (Avoid mocking `runClaudeCode`; this is the public seam.)

That's the whole vertical. Slices 5/6 of the PRD will deepen it
(per-kind diffing, MCP resolution, etc.) — don't pre-build for them.

## If you decide the slice is still too broad

Don't re-interpret silently. The deviation rules apply: file
`mars task add "<scoped follow-up>" --blocked-by $TASK_ID` with the
narrowest sub-slice you can defend (e.g. "just the schema + the CLI
verb, no hook yet"), commit whatever you have, and exit. Don't loop on
reads.

## Files most likely to change

- `orchestrator/src/mastra/queue.ts` — new table + index + migration row.
- `orchestrator/src/cli.ts` — new `context capture` subcommand.
- `orchestrator/src/mastra/lib/` — new `starting-context.ts` (writer +
  `isCaptureDisabled`), mirroring `reflect-signals.ts`.
- `orchestrator/src/mastra/lib/git.ts` — thread `captureContext` arg
  through `runClaudeCode` / `buildWorkerEnv`.
- `orchestrator/src/init/templates/claude/settings.json` — add
  `SessionStart` block.
- `orchestrator/src/init/templates/claude/hooks/
  capture-starting-context.sh` — new.
- `orchestrator/src/mastra/lib/__tests__/starting-context.test.ts` — new.

## Verify

```
cd orchestrator && npm run build && npm test -- starting-context
```

Save your work.
