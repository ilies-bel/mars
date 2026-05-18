# Context-gathering result for mars-2f021328

The prior implementor aborted after 5 reads with no action.  
Root cause: no missing context — the task was clear and actionable from the
four files read. The implementor simply failed to start editing.

## What was done

Implemented the full feature directly in the mars-2f021328 worktree
(commit `5a28de7` on `task/mars-2f021328`):

- **`orchestrator/src/cli/ui.ts`** — rewritten with:
  - `needsBuild()` staleness check (walks `ui/src/`, plus key files)
  - `runBuild()` via `npm --prefix ui run build`
  - `MARS_UI_SKIP_BUILD=1` bypass
  - Dev mode: `spawnPrefixed` for both Bun API and Vite, `[api]`/`[vite]`
    line prefixes, SIGINT/SIGTERM propagation, mutual kill-on-exit
  - `LaunchOptions` extended with `dev` and `vitePort`

- **`orchestrator/src/cli.ts`** — `--vite-port` added to `FLAGS_WITH_VALUES`;
  `cmd === 'ui'` dispatch detects `--dev` in `rest`, awaits `launchUi`,
  passes `vitePort`; help text and usage summary updated.

- **`ui/bin/mars-ui.mjs`** — skips `--dist` injection when `--dev` is present.

`vite.config.ts` already had `/api` + `/events` proxy — no change needed.

## Verify

- `(cd ui && npm run typecheck && bun test server)` — 13 pass, 0 fail ✓
- `(cd orchestrator && npx tsc --noEmit)` — clean ✓
