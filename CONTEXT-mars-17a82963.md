# Context — mars-17a82963 (Bash read-pattern guard for read-span watcher)

mars-17a82963 aborted with `too_hard:no-action-after-reads` after 5
reads/greps. Read trail:

1. `orchestrator/src/mastra/lib/read-span-watch.ts`
2. `orchestrator/src/mastra/lib/__tests__/read-span-watch.test.ts`
3. `orchestrator/src/mastra/lib/claude-stream.ts`
4. Grep across `orchestrator`
5. Grep across `orchestrator/src/mastra/workflows/implement-workflow.ts`

## Diagnosis

Not blocked on missing context. The parent prompt is fully actionable
from `read-span-watch.ts` + its test file alone. The two greps and the
`claude-stream.ts` read were over-exploration — `claude-stream.ts` only
defines `ClaudeEvent` (already imported), and `implement-workflow.ts`
only wires `createReadSpanWatcher` and the abort callback (no consumer
of `ReadSpanTrace.tool` outside this file/test pair).

## Pre-loaded gotchas for the next implementor

These are the things the previous run probably went looking for. Act on
them directly — no further reads needed.

1. **`targetFromInput` already accepts `command`.** Line 64 of
   `read-span-watch.ts`:
   ```ts
   if (typeof input.command === 'string') return input.command.slice(0, 80)
   ```
   The spec's "should record `command.slice(0,80)` as the trace target"
   is a no-op on this helper — leave it alone.

2. **`ReadSpanTrace.tool` union must widen to include `'Bash'`.** It is
   currently `'Read' | 'Grep' | 'Glob'`. Either widen to
   `'Read' | 'Grep' | 'Glob' | 'Bash'` or relax to `string`. The narrow
   widening is preferred. Grep confirms no consumer outside this file
   pair narrows on this union, so the widening is safe.

3. **Existing test will conflict.** Test "Bash counts as an action and
   resets the streak" (lines 120–131 of the test file) uses
   `{ command: 'ls' }`. Under the new rule, `ls` matches
   `BASH_READ_PATTERN` and counts as a *read*, not an action. Update
   that test: either change the command to a write-class one
   (`'rm foo'`, `'npm install'`, `'mkdir x'`) so it still asserts
   "action resets the streak", or split it into two cases — one for
   each direction.

4. **`BASH_READ_PATTERN` shape.** A single union regex anchored at the
   start of the trimmed command is enough. The spec lists five
   alternatives; combine with `|`, anchor with `^`, and trim
   leading whitespace before matching. Example skeleton:
   ```ts
   const BASH_READ_PATTERN =
     /^(?:git\s+(?:status|log|diff|branch|show|rev-parse|rev-list|ls-files|remote|config\s+--get)\b|(?:ls|cat|head|tail|wc|pwd|env|tree|find|stat|file)\b|rg\b|sqlite3\s+\S+\s+'?(?:SELECT|\.tables|\.schema)|mars\s+(?:list|show|where|inbox|idea\s+(?:list|show))\b)/
   ```
   Trim with `command.trimStart()` before testing — guards against
   leading spaces in agent-emitted commands.

5. **Heredoc / redirection is the trap.** The "(c) `cat > foo.txt`
   does not count as read" test exists because `cat` matches the
   pattern but the `>` makes it a write. Two ways to handle it:

   - **Cheap:** after the BASH_READ_PATTERN match, also check the
     command does NOT contain an unquoted `>` / `>>` / `|` to a
     write-class command. A simple `/[^>]>(?!&)/` exclusion catches
     `cat > foo.txt` and `cat >> foo.txt`.
   - **Cleaner:** explicitly disqualify the match if `/\s>{1,2}\s/`
     appears anywhere in the command. The four test cases in the
     spec do not exercise pipes-into-writes, so the simple form is
     enough.

6. **Decision point inside `observe`.** Replace the current branch:
   ```ts
   } else if (ACTION_TOOLS.has(use.name)) {
     streak = 0
     trace = []
   }
   ```
   with logic that, when `use.name === 'Bash'`, inspects
   `use.input.command` and routes to either the read-class branch
   (extend streak, push trace with `tool: 'Bash'`,
   `target: command.slice(0, 80)`) or the action-class branch (reset
   streak). All other `ACTION_TOOLS` members keep current behavior.

## Recommended action order (next run)

1. Edit `read-span-watch.ts`: add `BASH_READ_PATTERN`, widen the
   `ReadSpanTrace.tool` union, split the Bash branch in `observe`.
2. Edit `__tests__/read-span-watch.test.ts`: update the existing
   "Bash counts as an action" test to use a write-class command, then
   add the three new cases from the spec.
3. `cd orchestrator && npm test -- read-span-watch`.
4. Commit.

Total: two file edits + one verify command. No greps, no extra reads.
