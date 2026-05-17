# Finding — root @mastra/* deps audit (mars-79217a43)

## Status

**No-op investigation.** The 7 deps the brief flagged (`@mastra/core`,
`@mastra/duckdb`, `@mastra/evals`, `@mastra/libsql`, `@mastra/memory`,
`@mastra/observability`, `mastra`) were **already removed** from the
root `package.json` in commit `803705f` ("chore(root): drop unused
@mastra/* + mastra root deps per knip"), which is in the ancestry of
this task branch (`task/mars-79217a43` branched from `33a6015`, and
`803705f` lands earlier on `main`).

## Current root `package.json`

```json
{
  "scripts": {
    "validate-manifest": "node scripts/check-manifest.mjs",
    "knip": "knip --no-progress --no-exit-code"
  },
  "devDependencies": {
    "knip": "^6.14.0"
  }
}
```

No `dependencies` block. Nothing to remove.

## Investigation (re-run for confirmation)

1. **Grep for `@mastra/` or `from 'mastra'` imports outside `orchestrator/`
   and `ui/`:**

   ```
   grep -rn '@mastra/\|from .mastra.' --include='*.ts' --include='*.mjs' \
     --include='*.js' . | grep -v node_modules | grep -v /orchestrator/ \
     | grep -v /ui/
   ```

   → zero hits. All mastra imports live under `orchestrator/src/**`,
   which declares its own deps in `orchestrator/package.json`.

2. **Root scripts / bootstrap / CI references:**

   - Root `package.json` scripts: only `validate-manifest` (runs
     `scripts/check-manifest.mjs`, plain Node, no mastra) and `knip`.
   - `install-dev.sh`, `get-mars.sh`: no mastra references.
   - `.github/`: no mastra references.
   - `skills-lock.json`: contains a `"mastra"` entry, but it points to
     `mastra-ai/skills` → `skills/mastra/SKILL.md`. This is a **Claude
     Code skill** lockfile entry, NOT the `mastra` npm package. Unrelated.

3. **Manifest validator still works:**

   ```
   $ node scripts/check-manifest.mjs
   ✓ manifest.json OK — schemaVersion 1, 15 owned + 2 hybrid = 17 paths, all resolve
   ```

   `scripts/validate-manifest.ts` no longer exists — it was retired in
   commit `8d50b01` ("Retire manifest.toml and validate-manifest.ts").
   The current `validate-manifest` script in `package.json` shells out
   to `scripts/check-manifest.mjs`, which has no mastra dependency.

## Conclusion

Nothing to do. The audit confirms the prior cleanup is correct and
complete; no consumer at the repo root needs any of the 7 packages, and
no bootstrap / CI / skills tooling relies on them either. Closing as
no-op with this finding committed for the orchestrator to see > 0
commits ahead of `main`.
