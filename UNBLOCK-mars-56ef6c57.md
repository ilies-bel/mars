# Unblock note — mars-56ef6c57

**Task:** Add `--limit N` and `--group-by kind` flags to `mars inbox list`.

The previous implementor aborted after 5 reads with no action. Root
cause: the parent prompt's suggested paths (`src/cli/inbox.ts`,
`src/db/inbox.ts`) **do not exist**. There is no top-level `src/`. The
`mars` CLI lives in a single ~2600-line file. Below is the exact map so
you can go straight to editing.

## Where everything lives (verified file:line, all in worktree)

| What | Location |
|---|---|
| `mars inbox` command block | `orchestrator/src/cli.ts` — `if (cmd === 'inbox')` at **line 2245** |
| `inbox list` dispatch (state parse → query → print) | `orchestrator/src/cli.ts` **lines 2513–2569** (`if (sub === undefined \|\| sub === 'list')`) |
| `printList()` (per-item rows) | `orchestrator/src/cli.ts` **lines 2259–2278** |
| Existing grouping helpers you can reuse | `groupBlockers()` 2328–2356, `normalizeKind()` 2308–2311, `extractSignature()` 2317–2326 — used today only by `printLean()` (2357–2406) |
| DB query backing the list | `inbox.listInboxItems(state, opts)` in `orchestrator/src/mastra/lib/inbox.ts` **lines 399–426**; options interface `ListInboxOptions` **lines 394–397** |
| `InboxItem` row shape | exported from `orchestrator/src/mastra/lib/inbox.ts` (fields used: `id, state, priority, seenCount, kind, signature, title, raisedAt, payload`) |
| Tests for the query layer | `orchestrator/src/mastra/lib/inbox.test.ts` (see `describe('inbox')` line 40; existing `listInboxItems` tests at 115, 140) |
| Help text (TWO blocks — update both) | `orchestrator/src/cli.ts` **lines 269–285** (top-level usage) and **lines 631–636** (`inbox:` subcommand help) |

## CRITICAL landmine — flag parsing (this is why naive code fails)

`parseArgs()` (lines 45–77) only treats `--foo bar` as a value flag if
`--foo` is in the **`FLAGS_WITH_VALUES`** set (`orchestrator/src/cli.ts`
**lines ~16–43**). Flags NOT in that set are pushed to `positional` and
their value is treated as a separate positional arg — so
`flags['--limit']` would be `undefined` and `5` would land in
`subRest`, silently breaking the existing `[state]` positional too.

**You must add `'--limit'` and `'--group-by'` to the `FLAGS_WITH_VALUES`
set** (around line 33, near `'--kind'`). After that, inside the list
dispatch you read them as `flags['--limit']` and `flags['--group-by']`
(same pattern as the existing `const kind = flags['--kind']` at line
2529). `--limit` arrives as a string — parse with `Number.parseInt`,
validate `> 0`, reject non-numeric the same way the `state` allowlist
rejects bad input (lines 2520–2526: `console.error(usage); process.exit(1)`).

## Suggested implementation shape

1. Add the two flags to `FLAGS_WITH_VALUES`.
2. In the list dispatch (after `const rows = await inbox.listInboxItems(...)`,
   ~line 2530), branch on `flags['--group-by'] === 'kind'`:
   - **group-by kind:** reuse/extend the existing `groupBlockers()` +
     `normalizeKind()`. The parent wants one row per distinct kind
     prefix: `<kind>  <count>  <max_priority>  <max_seen_count>`, drafts
     collapsed to a single `draft(<source>)` row per source. Sort by
     count desc. `--limit` caps the number of *groups*. Note
     `groupBlockers()` today keys on `kind|signature` and tracks
     `latestTaskId` — for this task you want a simpler kind-only
     aggregation that also tracks max priority and max seenCount, so
     write a small dedicated grouping pass rather than overloading
     `groupBlockers()`.
   - **no group-by:** call `printList(rows, drafts)` as today, but slice
     `rows`/`drafts` to `--limit` first when set.
3. Default (no `--limit`, no `--group-by`) MUST be byte-identical to
   current output — back-compat is explicit in the brief. Keep the
   existing code path untouched when both flags are absent.
4. Update **both** help blocks (lines 269–285 and 631–636).
5. Output stays plain text, one row per line — no JSON mode. The
   `--lean` path is unrelated; do not touch `printLean`.

## Tests

Add to `orchestrator/src/mastra/lib/inbox.test.ts` only if you push
grouping into the query layer. If grouping stays in the CLI (recommended
— it's presentation), there is no existing CLI-level test harness for
`inbox list` (the `orchestrator/src/cli/__tests__/` dir only covers
`inbox-raise-schema`). Cleanest: keep the grouping logic in a small
pure exported helper (e.g. export a `summariseByKind(rows, drafts)` from
a module) and unit-test that helper directly — covering `--limit`,
`--group-by kind`, and the composition (≤N groups, count-desc order).

## Verify (from the `orchestrator/` subdir — never `cd` globally)

```
cd orchestrator && bun test
cd orchestrator && bun run build
```

Manual smoke (the brief's acceptance):
- `mars inbox list open --group-by kind --limit 5` → ≤5 cluster summary lines
- `mars inbox list open --limit 3` → ≤3 raw rows
- `mars inbox list open` → identical to pre-change output

## Verdict

The parent task is well-scoped and actionable — it does **not** need
architectural changes or a `mars idea` split. It only needed
orientation, which this note provides. Re-dispatch mars-56ef6c57 with
this note in the worktree and the implementor can edit immediately.
