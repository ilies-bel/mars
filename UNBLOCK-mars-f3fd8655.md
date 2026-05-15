# Unblock note for mars-f3fd8655

- **Parent task:** `mars-f3fd8655` — "Re-land the JSONL transcript loader
  infrastructure that task mars-eaedd84c was supposed to ship."
- **This task:** `mars-71fb349c`, the context-gathering child dispatched
  after the implementor for `mars-f3fd8655` was killed with
  `too_hard:no-action-after-reads` (trace: Read+Read+Read+Grep+Grep).

## Why the implementor stalled

The parent brief is **one task masquerading as six**. The implementor
read `reflect-query.ts`, `deep-reflect-query.ts`, `deep-reflector.ts`,
then grepped for `claudeSessionIds` and `claude_session_ids` — at which
point the read-span watcher fired. With this much surface to cover, that
was inevitable. The brief packs:

1. A streaming JSONL reader + path resolution
   (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`).
2. Token-usage aggregation + >2σ outlier detection per turn.
3. Tool-call counting + waste flags (same tool >3× on same path,
   identical args repeated, Read→Read without intervening Edit).
4. Error/retry-pattern extraction from `tool_result.is_error` entries.
5. Transcript-window extraction (turn before / trigger / turn after) on
   every fired flag.
6. Wiring all of the above into `reflect-query.ts`, `deep-reflect-query.ts`,
   `deep-reflector.ts`, `cli.ts` help blocks, and two skill docs
   (`mars:reflect`, `mars:deep-reflect`).

That is ~500 LOC of new code (extractor + types + tests), plus six
distinct edit sites. No serious implementor will fit it inside the
read-span budget without context-juggling that trips the watcher.

## What is actually in place

The prerequisite — `mars-5ba9684d` (persist `claude_session_ids` as a
JSON array on the task row) — *is* landed on `main`, despite its task
row showing `status=dropped`:

| Symbol / column | Location |
| --- | --- |
| `tasks.claude_session_ids TEXT NOT NULL DEFAULT '[]'` | `orchestrator/src/mastra/queue.ts:260` (ALTER inside `ensureSchema`) |
| Backfill from `claude_session_id` | `orchestrator/src/mastra/queue.ts:264` |
| `Task.claudeSessionIds: string[]` | `orchestrator/src/mastra/queue.ts:123` |
| `rowToTask` parse | `orchestrator/src/mastra/queue.ts:645` (also mirrored in `lib/origin-timeline.ts:66`) |
| Append-on-update SQL (json_each dedup) | `orchestrator/src/mastra/queue.ts:872` |
| Tests | `orchestrator/src/mastra/lib/__tests__/queue-claude-session-ids.test.ts` |

So the *data the extractor needs to read* is already being persisted.
The blocker is purely the size of the extractor work itself.

## What the parent task DID NOT ship

`rg 'extractTranscriptSignals|transcript-extract' orchestrator/src`
returns zero hits. The file does not exist. `mars-eaedd84c`'s `done`
status is a false positive (worktree gone, no commit on main, no entry
in reflog). The parent brief's diagnosis ("either the merge was lost or
the task completed without actually creating the file") is correct —
the second branch is the truth.

## CLI-line drift in the brief

The parent brief points at `cli.ts ~1726` and `~1797`. Current line
numbers (cli.ts on this worktree):

- `if (cmd === 'reflect')` — line **2065**
- The `deep-reflect` handler is below that (search for
  `cmd === 'deep-reflect'`).

Not a blocker; just FYI so the next implementor doesn't waste a Read on
the wrong region.

## Recommended way forward — slice into three tasks

I am filing three follow-ups as ideas (not blocking tasks — the
user/orchestrator can promote them in order). Each is sized to fit
inside the read-span budget:

Filed idea IDs (see `mars idea list --source human`):
`9916805b` (Slice A), `49ecee76` (Slice B), `775f9a27` (Slice C).

1. **Slice A — Extractor skeleton + path resolution + token usage.**
   Adds `orchestrator/src/mastra/lib/transcript-extract.ts` exporting
   `extractTranscriptSignals(claudeSessionIds: string[])` returning a
   typed struct with token aggregates and an empty `flags` array.
   Streams JSONL via `readline` on `fs.createReadStream`. Resolves
   path via the `/`→`-` encoded-cwd heuristic with a directory-scan
   fallback. Ships with unit tests on a fixture JSONL.

2. **Slice B — Tool-pattern + error signals on top of Slice A.** Adds
   waste/confusion flags (>3× same tool on same path, repeated identical
   args, Read→Read without Edit), error-retry pattern extraction, and
   `extractTranscriptWindows(...)` for the 3-turn verbatim window
   capture.

3. **Slice C — Wiring + docs.** Calls `extractTranscriptSignals` from
   `reflect-query.loadRecentTaskCorpus`, surfaces signals in the
   `deep-reflector` agent prompt, persists windows into
   `.mars/deep-reflections/<task-id>-<iso>.json`, updates `cli.ts` help
   blocks, and updates the two skill docs.

After Slice C lands, the parent (`mars-f3fd8655`) is satisfied and
downstream `mars-28e44c86` ("flag unused initial-context injections")
can be re-queued with `mars retry mars-28e44c86`.

## Why this isn't being done as the surgical-change option

A no-op stub of `transcript-extract.ts` would unblock downstream
*compilation* but would not satisfy the parent brief's "surface
actionable signals" intent — Slice C wiring would have nothing real to
surface, leaving the user with a misleading "feature shipped" signal in
the reports. Better to slice honestly than fake it.
