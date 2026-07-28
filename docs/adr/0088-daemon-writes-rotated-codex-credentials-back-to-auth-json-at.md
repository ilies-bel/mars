# Daemon writes rotated Codex credentials back to auth.json atomically (supersedes ADR-0087)

After the daemon exchanges a Codex refresh token for a new access token via
`refreshCodexAuth`, it persists the rotated credentials back to `auth.json`
using an atomic rename and only writes tokens explicitly returned by the server.

**Supersedes ADR-0087** ("Daemon never writes back to ~/.codex/auth.json after
token refresh"), which was authored under a previous task before the operator
had made a decision. The operator has since chosen option (a): write-back is
permitted and required, with the guards documented below.

## Context

ADR-0087 identified two failure modes from writing back to `auth.json`:

1. **Race with the `codex` CLI**: if both parties refresh concurrently, whichever
   write lands last invalidates the other's new token.
2. **Partial write**: a crash mid-write leaves `auth.json` broken.

ADR-0087 resolved these by dropping the write-back entirely. The operator has
reconsidered this trade-off: in-memory-only refresh means that after a daemon
restart the fresh token is gone and a 401 on the pre-refresh token triggers the
re-authenticate banner, forcing `codex login` even though the refresh succeeded.
Persisting the result avoids that unnecessary re-login, and both failure modes
can be mitigated with targeted guards rather than full omission.

## Decision

The daemon persists rotated credentials back to `auth.json` under three guards:

1. **Atomic write**: credentials are written to a temp file (`.auth-tmp-<uuid>.json`)
   in the same directory, then `rename()`d over `auth.json`. A crash or concurrent
   write can never leave a half-written file; `rename(2)` is atomic on POSIX.

2. **Server-issued tokens only**: when the OAuth response omits `refresh_token`,
   the in-memory fallback (`auth.refreshToken`) is still used for the current
   process, but the on-disk `refresh_token` is left exactly as it was. We never
   write a value the server did not just issue.

3. **Best-effort**: a failed write (unwritable path, full disk, concurrent rename
   collision with the CLI) is silently swallowed. The in-memory tokens remain
   valid for the run; the worst case is a re-auth banner after the next daemon
   restart, not a broken login.

Guard (1) eliminates ADR-0087's partial-write risk. Guard (2) reduces — though
cannot fully eliminate — the concurrent-refresh race: if the CLI refreshes
simultaneously and both parties `rename` atomically, whichever rename lands last
wins, but neither side observes an incomplete file. Guard (3) ensures that the
mitigations failing gracefully does not surface as a user-visible error.

## Consequences

- `refreshCodexAuth` returns the refreshed `CodexAuth` and also attempts to
  persist it; callers do not need to handle the write themselves.
- After a daemon restart following a mid-session token refresh, `loadCodexAuth`
  reads the updated `auth.json` — the fresh access token is available without
  requiring the user to run `codex login`.
- A simultaneous `codex` CLI refresh can still invalidate the daemon's on-disk
  token (or vice versa); the surviving process falls back to the re-auth banner.
  This is an acceptable residual risk given the rarity of simultaneous refreshes.
