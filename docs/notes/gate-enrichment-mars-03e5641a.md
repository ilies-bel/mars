# Gate Enrichment: verify:typecheck/typecheck-property-not-exist

**Origin task:** mars-50e6ad62  
**Enrichment task:** mars-03e5641a  
**Date:** 2026-07-26

## Candidate check

```json
{"cmd":"npx","args":["tsc","-p","tsconfig.server.json","--noEmit"],"dir":"ui"}
```

**Rationale:** The failure `TS2353: Object literal may only specify known
properties, and 'budgetStatus' does not exist in type 'AppServices'` appears in
`server/kpis.test.ts` which is compiled by `tsconfig.server.json`.  Scoping the
check to the server tsconfig alone (rather than the full `npm run typecheck`
which runs both client and server passes) is faster and pinpoints exactly the
failure class without false positives from unrelated client-side errors.

The check exits non-zero whenever a property is added to an object literal that
does not exist in `AppServices`; it exits 0 once the type or the literal is
corrected.

**Status:** candidate (pending human approval via action queue + shadow burn-in)
