# UI- and daemon-driven framework self-update from GitHub Releases

# Context

Mars has no in-product update path. The framework version lives in `orchestrator/package.json`, is synced to `MARS_VERSION` (`orchestrator/src/version.ts`), and is inlined into the compiled binary. Releases publish a Bundle tarball tagged `v<version>` to GitHub Releases (`ilies-bel/mars`). Prod consumers upgrade by re-running the curl-pipe-bash bootstrap; dev consumers re-run `install-dev.sh`. Users have no signal that a newer version exists and no in-product way to act on it.

We want: (1) the running daemon to know when a newer release exists, (2) an ambient nudge in the Claude Code status line, (3) a UI panel that surfaces the available update and can trigger it.

# Decision

**Detection — daemon-owned poll, cached to disk.** The daemon polls `https://api.github.com/repos/ilies-bel/mars/releases/latest` on startup and every ~6h (unauthenticated; public-repo rate limits suffice). It compares the release tag to `MARS_VERSION`, and writes a small cache to `.mars/update.json` (`{ installed, latest, available, checkedAt, releaseUrl }`). On any network/rate-limit failure it keeps the last cache and stays silent — never an error nag. The daemon is the sole reader/writer of this state; nothing else calls GitHub.

**Status line — render-only, reads cache.** Mars owns the Claude Code `statusLine` via the bundled template `settings.json`. A new `mars statusline` command reads `.mars/update.json` (never the network — it runs after every assistant message, debounced ~300ms) and renders basic Mars context plus an update nudge. The nudge is silent when current. The command must be fast and degrade to empty output when no daemon/cache exists.

**UI — read the cache via a proxied route; act via a gated privileged action.** New daemon GET `/view/framework-update` serves the cache; ui/server proxies it as `/api/framework-update`; the React app shows a dismissable top banner (installed -> latest, release-notes link, dismissal keyed to the version so it returns on the next release). An "Update now" button is gated on install method.

**Self-update — privileged, prod-binary only, drain-before-swap.** This is the surprising part: it bends the "UI is read-only / mutations are narrow" invariant by letting the UI ask the daemon to replace its own running binary. Mechanics for v1:
- Enabled only for prod-binary installs. Dev installs (tsx wrapper from `install-dev.sh`) get a disabled button with a "dev install — git pull & rebuild" hint; the daemon refuses the action for dev installs.
- Drain first: refuse to self-update while any task is in flight (consistent with the merge-lock/draining model). 
- Download the bundle for the latest tag, verify its published sha256 (abort on mismatch), atomic-swap the binary keeping a `.bak` aside, then re-exec the daemon.
- No automatic rollback in v1: the `.bak` is retained for manual restore. Health-check-driven auto-rollback is a deliberate fast-follow, not part of this decision.

# Consequences

- The daemon gains an outbound network dependency (GitHub) and a new privileged, self-mutating action — the largest trust surface added to the UI so far. It is deliberately fenced: prod-only, drain-gated, checksum-verified, single-shot.
- The status line is now Mars-owned in Mars repos; a consumer's pre-existing custom status line is overridden by the bundled template. Accepted as an opinionated first-party default.
- Failure is biased toward silence: an unreachable GitHub or a missing cache shows nothing rather than erroring.
- No auto-rollback means a bad release that starts but misbehaves requires manual `.bak` restoration; this is the explicit v1 trade-off to keep the surface small.
- Template changes must pass the `template-sync-check` CI gate (run `npm run mars:bundle:refresh`).
