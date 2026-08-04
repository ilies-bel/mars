# Daemon never writes back to ~/.codex/auth.json after token refresh

When the daemon exchanges a Codex refresh token for a new access token via
`refreshCodexAuth`, it updates credentials **in memory only** and leaves
`auth.json` untouched.

## Context

`auth.json` is written and owned by the user's `codex` CLI (`codex login`).
The daemon reads it at startup via `loadCodexAuth` to get the initial bearer
token. When that token expires mid-run the daemon can exchange the refresh
token for a fresh one using the ChatGPT OAuth endpoint.

A prior implementation wrote the rotated tokens back to `auth.json`.
A deliberate counter-design in the merged-away `feat/chat-codex-oauth` branch
refused to write back at all; neither path documented why it made that choice,
leaving the disagreement unresolved.

## Decision

The daemon refreshes in memory for the current process lifetime and does not
write the rotated tokens back to `auth.json`.

Two concrete failure modes justify this:

1. **Race with the user's CLI.** The ChatGPT auth server rotates the
   `refresh_token` on each exchange. If the daemon and the `codex` CLI
   concurrently refresh, whichever write lands second overwrites the other
   party's new token with the old one — invalidating the survivor's next
   request. The race is racy by construction and cannot be made safe with
   advisory file locks because the CLI does not participate in the same
   locking protocol.

2. **Partial write leaves auth broken.** A crash between read-parse-mutate-write
   (or a partial `writeFile` against a full disk) leaves `auth.json` in an
   unreadable or incomplete state even though the token exchange itself
   succeeded. The user's login is broken through no fault of their own.

Access tokens issued by the ChatGPT auth service are long-lived (~8 days), so
expiry during a single daemon lifetime is uncommon. When it does occur the 401
surfaces via the existing re-authenticate action-queue banner and the user runs
`codex login` once. That is a worse experience than silent persistence, but a
better outcome than silently corrupting their CLI login.

In-memory refresh still provides meaningful value: if a token expires while the
daemon is running, the refreshed token carries the session for the rest of the
process lifetime without requiring a manual re-login mid-session.

## Consequences

- `refreshCodexAuth` returns the new `CodexAuth` value but never touches disk.
- After a daemon restart following a mid-session refresh the fresh token is gone;
  the daemon will reload from `auth.json` (still the pre-refresh token) and hit a
  401 if the old token has also expired, triggering the re-auth banner.
- If in the future a write-back is reconsidered, it must be: (a) atomic
  (write-to-temp then `rename(2)`), and (b) must only update `access_token` —
  never update `refresh_token` with a value not explicitly returned by the server.
  Skipping either guard re-introduces the failure modes above.
