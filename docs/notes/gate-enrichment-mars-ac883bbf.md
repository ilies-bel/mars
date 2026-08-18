# Gate Enrichment: verify:build/typecheck-error

**Origin task:** mars-80827dbe  
**Enrichment task:** mars-ac883bbf  
**Date:** 2026-08-18

## Candidate check

```json
{"cmd":"npx","args":["tsc","-p","tsconfig.server.json"],"dir":"ui"}
```

**Rationale:** The failure signature `verify:build/typecheck-error` is produced
by the final stage of `npm run build` in `ui/`: the command sequence is
`tsc -b && vite build && tsc -p tsconfig.server.json`.  The vite build
succeeded; only `tsc -p tsconfig.server.json` exited non-zero, with TS6133
(`'X' is declared but its value is never read`) and TS6196 (`'X' is declared
but never used`) errors in `orchestrator/src/**` files that are transitively
imported by the `server/` tree included in `tsconfig.server.json`.

Scoping the check to `tsc -p tsconfig.server.json` alone (rather than the full
`npm run build`) skips the `tsc -b` client pass and the vite bundle step, making
the check significantly faster while still catching exactly this failure class.
`tsconfig.server.json` already sets `"noEmit": true`, so no output artefacts are
produced.  The check exits non-zero whenever `noUnusedLocals` or
`noUnusedParameters` (both enabled in that tsconfig) are violated in files
reachable from `server/` or `bin/`; it exits 0 once the unused symbols are
removed or used.

**Status:** candidate (pending human approval via action queue + shadow burn-in)
