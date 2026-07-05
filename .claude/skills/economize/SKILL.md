---
name: economize
description: Token-budget discipline for long coding sessions — replace grep+Read loops with codegraph, read file ranges not whole files, fan breadth exploration out to Explore subagents, and re-orient with a fresh context when the session grows large. Use when the user says "reduce token usage", "I'm hitting context limits", "this session is expensive", "save tokens", or invokes `/mars:economize`.
---

# Mars: token-economy discipline

Apply these rules to cut token spend 60–90 % on typical coding sessions.
They are ordered by impact; start at Rule 1 and work down.

## Rule 1 — codegraph before grep+Read

Every `rg` sweep followed by a `Read` burns context on files that may not
be relevant. Check codegraph first:

```bash
codegraph query <SymbolName>      # definition lookup
codegraph callers <symbol>        # who calls this
codegraph callees <function>      # what it calls
```

A codegraph hit gives you a file + line in one call. Only if codegraph is
absent from PATH should you fall back to `rg`.

## Rule 2 — Read ranges, not whole files

Reading a 400-line file to find a 10-line function wastes ~400 tokens of
context that never leaves. Always:

1. Locate the line with `rg -n` or codegraph.
2. Read a tight range: `offset=<line − 5>`, `limit=40`.

If you genuinely need the whole file, say why before doing it.

## Rule 3 — Fan breadth to Explore subagents

Open-ended questions ("find all usages of X", "which modules touch Y")
should go to an **Explore** subagent, not a loop of Bash + Read calls.
One Explore invocation replaces N Read + grep cycles and returns only the
relevant excerpts — keeping the main context small.

After Explore returns:
- Work from its excerpts only.
- Do **not** Read files the Explore agent already summarised (the only
  exception is an imminent Edit, where a fresh Read immediately precedes
  the write).

## Rule 4 — Trust sub-agent summaries

Sub-agent results are authoritative. Re-reading files the sub-agent covered
is always waste. If the excerpt missed something, ask a sharper Explore
question rather than loading the full file.

## Rule 5 — Re-orient when the session grows long

When you notice the same files have been read several times, or you're
unsure what is still in context, stop and:

1. Summarise where you are in one paragraph.
2. Spawn a fresh Explore subagent with a scoped question rather than
   re-reading from memory.
3. If the session is very long (many turns, many files), consider delegating
   remaining breadth work to a general-purpose subagent with a self-contained
   brief — do not carry a large diff-to-understand in the main context.

## Signals that this skill is needed

The following patterns from `mars arc reflect` / `mars reflect` indicate
token waste that these rules address:

| Pattern | Remedy |
|---|---|
| File Read 3+ times | Rule 4 — trust prior read, skip the re-read |
| Same `rg` command repeated | Rule 1 — codegraph first, one lookup |
| Long grep followed by many Reads | Rule 3 — delegate to Explore subagent |
| Whole-file reads for orientation | Rule 2 — read ranges only |
| Confusion loops across tasks | Rule 5 — re-orient with fresh subagent |
