---
name: discover
description: Codegraph-first codebase exploration — locate symbols, trace call chains, and read only confirmed-relevant ranges instead of grep+Read sweeps. Use when the user asks "find where X is defined", "what calls Y", "explore Z", "show the call chain for W", or invokes `/mars:discover`.
---

# Mars: codegraph-first exploration

Locate code efficiently. The rules below prevent context-bloating grep+Read
loops. Apply them in order; stop as soon as a step gives you the answer.

## Step 1 — Query codegraph first

If `codegraph` is on PATH, always reach for it before any other tool:

```bash
codegraph query <SymbolName>          # find where a symbol is defined
codegraph callees <functionName>      # what a function calls (trace inward)
codegraph callers <symbolName>        # who calls this (trace outward / impact)
```

If `codegraph` is not on PATH, fall back silently to `rg`:

```bash
rg -n "def <symbol>|function <symbol>|class <symbol>|const <symbol>" --type ts
```

Do **not** combine both: codegraph result → stop. `rg` fallback → stop.

## Step 2 — Delegate breadth to an Explore subagent

When the question is open-ended ("find all places that use X", "which files
reference Y"), use an **Explore** subagent rather than running many `rg`
invocations yourself. Give it a precise target and a breadth hint:

> "Quick: find all call sites of `processTask` in orchestrator/src/**"

Trust Explore's excerpts. Do **not** Read any file the Explore agent already
summarised — the only escape hatch is an imminent Edit, where you Read the
file immediately before writing.

## Step 3 — Read ranges, not whole files

Once you know the file and approximate location:

```bash
# Read only the relevant block, not the whole file
```

Pass `offset` + `limit` to the Read tool. A class is rarely more than 80
lines; a function rarely more than 30. If you don't know the line number,
use `rg -n <pattern> <file>` to find it first, then Read a tight range.

## Step 4 — Stop re-reading

If you already Read a file (or an Explore subagent summarised it), do **not**
Read it again unless you are about to Edit it. Re-reads are a signal the
session is hoarding context — fan out to a fresh Explore instead.

## Rules

- One Explore subagent per question, not per file.
- codegraph result → act on it. `rg` only as fallback.
- Read ranges, never whole-file reads for orientation.
- Trust Explore summaries; Re-reading == waste.
- If codegraph + Explore together don't answer the question in two turns,
  the question is too broad — break it into smaller targeted lookups.
