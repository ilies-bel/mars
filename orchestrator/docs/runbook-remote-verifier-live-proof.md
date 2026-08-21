# Runbook: Prove the Verifier Port against a real CI runner

**Purpose:** one-time operator procedure for PRD `ae17340a-modular-core-program-make-every-mars-mod`
slice 22. Configures the `remote-http` Verifier Port implementation
(`src/core/ports/verifier/remote-http.ts`) against a live, hosted CI
system and runs one passing and one deliberately failing Mars task
through it — the proof that the Verifier Port supports a genuinely
remote implementation, not just the `local` in-process one or a stub.

This is a manual, credentialed operator action. It cannot be performed
by an unattended coding agent: it requires a real CI endpoint reachable
from the daemon host, and a secret token, neither of which exist in an
automated worktree.

**ADR reference:** `docs/knowledge/decisions/0097-every-seam-is-a-cordis-service-port-with-serializable-contra.md`
— "Every swappable module boundary is a Port... Remote implementations
are ordinary services filling the same slot; the wire protocol lives
entirely inside that one adapter."

---

## 0. The wire contract the remote endpoint must implement

`remote-http.ts` POSTs the serializable half of a verify run
(`VerifierRunArgs` — see `src/core/ports/verifier/types.ts`) as JSON to
the configured URL and expects a **synchronous** JSON response body
shaped like `VerifierRunResult`:

```json
{
  "passed": true,
  "verdict": "PASS",
  "steps": [{ "name": "...", "passed": true, "output": "..." }],
  "modelAttribution": { "provider": "...", "model": "..." }
}
```

- Request: `POST <url>`, header `content-type: application/json`, plus
  `authorization: Bearer <token>` when a token is configured. Body is
  `VerifierRunArgs` (`cwd`, `steps`, `branch`, `integrationBranch`,
  `changedFiles`).
- Response: any non-2xx, a non-JSON body, or a body that fails the
  `VerifierRunResult` structural check is treated as an **adapter
  failure**, not a verdict — see §5 below for why that distinction
  matters for the "deliberately failing" step.
- `verdict` must be one of `PASS`, `FAIL`, `"CAN'T-VERIFY"`.

Most hosted CI systems (GitHub Actions included) are asynchronous —
triggering a run does not hand you a verdict inline. This endpoint is
therefore almost always a **thin relay**, not the CI system itself:
something that (a) triggers the real CI run (e.g. a GitHub Actions
`workflow_dispatch`), (b) polls until it finishes, and (c) translates
the result into the JSON shape above before responding to Mars's POST.
A minimal relay can be a small server (Cloudflare Worker, Lambda, or a
plain Node process) that:

1. Receives the POST, extracts what it needs from `VerifierRunArgs`.
2. Calls `POST /repos/<owner>/<repo>/actions/workflows/<id>/dispatches`
   with a `ref` and `inputs`.
3. Polls `GET /repos/<owner>/<repo>/actions/runs?...` until the run
   reaches a terminal `status`.
4. Maps the GitHub Actions `conclusion` (`success` → `PASS` /
   `passed: true`, anything else → `FAIL` / `passed: false`) and
   summarizes per-job output into `steps[]`.
5. Responds 200 with the `VerifierRunResult` JSON.

Build and deploy that relay before starting §2 — this runbook assumes
it already exists and is reachable from the Mars daemon host.

---

## 1. Configure Mars to select `remote-http`

Three separate knobs, two different mechanisms — do not conflate them:

- **`MARS_VERIFIER_KIND`** — the Port *selector*. This is read only
  from the daemon process's real environment
  (`src/core/config/registry.ts`'s `resolvePortKind`, called with
  `process.env`) — **it cannot be set via `.mars/daemon.json`.** Export
  it in whatever shell/service manager launches the daemon:

  ```sh
  export MARS_VERIFIER_KIND=remote-http
  ```

- **`MARS_VERIFIER_REMOTE_URL`**, **`MARS_VERIFIER_REMOTE_TOKEN`**,
  **`MARS_VERIFIER_REMOTE_TIMEOUT_MS`** — typed `MarsConfig` value
  knobs (`src/core/config/env-registry.ts`). These *can* be set either
  as env vars, or as JSON under a `verifier` key in `.mars/daemon.json`
  — env wins if both are present (`defaults ← daemon.json ← env`, see
  `src/core/config/load.ts`):

  ```jsonc
  // .mars/daemon.json
  {
    "verifier": {
      "remoteUrl": "https://<your-relay-host>/verify",
      "remoteAuthToken": "<token>",       // omit or leave unset to skip the auth header
      "remoteTimeoutMs": 30000             // optional, defaults to 30000
    }
  }
  ```

  **Do not commit the token.** Prefer the env var
  `MARS_VERIFIER_REMOTE_TOKEN` over writing `remoteAuthToken` into
  `.mars/daemon.json` on disk, since `.mars/` is gitignored but still
  sits in a working tree that gets read by other tooling. If you do
  write it to `daemon.json`, treat that file as a secret and keep it
  out of any backup that leaves the host.

---

## 2. Smoke-test the endpoint before trusting it in production

Run the dependency-free smoke script from the framework root (not
`orchestrator/`) with the same env the daemon will use:

```sh
MARS_VERIFIER_KIND=remote-http \
MARS_VERIFIER_REMOTE_URL=https://<your-relay-host>/verify \
MARS_VERIFIER_REMOTE_TOKEN=<token> \
node scripts/verify-remote-verifier.mjs
```

It resolves the Port config through the real registry (never
hardcoding the env var names), POSTs a synthetic no-op
`VerifierRunArgs`, and validates the response against
`VerifierRunResult`. Exit codes: `0` PASS **or SKIP**, `1` CONFIG
(remote-http selected but its URL env var unset), `2` TRANSPORT, `3`
AUTH (401/403), `4` HTTP (other non-2xx), `5` SCHEMA (bad JSON /
shape).

**Check the last line of stdout, not just the exit code.** Exit `0`
covers two different outcomes:

| Last stdout line | Meaning |
| --- | --- |
| `verify-remote-verifier: PASS — verdict=…` | The endpoint was contacted and its response matched the contract. |
| `verify-remote-verifier: SKIP — Verifier Port kind is "local", …` | `MARS_VERIFIER_KIND` did not resolve to `remote-http`, so **nothing was contacted**. |

A `SKIP` almost always means the env vars did not reach the process —
a typo, a missing `export`, or a shell that dropped them. Re-run with
the three variables set on the same command, as above.

The skip exists so the script is safe to wire in as an unattended
verify command on a repo running the default `local` Verifier; it is
never a valid outcome for this runbook. Do not proceed to §3 until you
see the `PASS` line.

---

## 3. Restart the daemon

`resolveVerifier()` is called fresh on each verify run, but
`MARS_VERIFIER_KIND` is read from the process's environment at
resolution time — export it in the daemon's environment and restart so
the running process actually has it set:

```sh
mars daemon restart
mars daemon status
```

(A daemon restart hard-stops any in-flight tasks; they re-queue.)

---

## 4. Run one passing task end-to-end

Enqueue any small, genuinely-passing task (a docs tweak is fine) and
let it run to completion:

```sh
mars task add "Passing-case proof for the remote Verifier Port: no-op docs tweak" \
  --verify "true"
```

Wait for it to reach `done`, then record its id — this satisfies the
first acceptance criterion ("pasted the resulting task id").

```sh
mars list --status done | head -5
```

---

## 5. Run one deliberately failing task

Enqueue a task whose `--verify` command is guaranteed to fail (e.g.
`exit 1`), and confirm the failure is attributed to the **CI verdict**,
not a transport/adapter error:

```sh
mars task add "Failing-case proof for the remote Verifier Port: forced verify failure" \
  --verify "exit 1"
```

Inspect the failure reason once it lands in `failed`:

```sh
mars diagnose <task-id>
```

The distinguishing signal is in the verify step output:

- **CI verdict failure (what you want to see):** a step whose `output`
  is whatever your relay/CI produced for a real failing run — anything
  *not* prefixed with `remote-http verifier adapter failure`.
- **Transport/adapter failure (not what this proves):** a single
  synthetic step named `remote-http-verifier` whose output starts with
  the literal string `remote-http verifier adapter failure:` (see
  `REMOTE_HTTP_ADAPTER_FAILURE_MARKER` in `remote-http.ts`) — this
  means Mars never got a trustworthy verdict from the endpoint (network
  error, non-2xx, bad JSON, or a malformed body). If you see this,
  the relay is broken, not proven; fix it and re-run this step.

---

## 6. Inspect `GET /events?taskId=<id>` for both tasks

The daemon's HTTP port is OS-assigned — read it, never guess it:

```sh
PORT=$(cat .mars/http.port)
node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/events?taskId=<task-id>').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))"
```

Verify steps are not their own event kind — they appear as
`tool_invoked` events with `phase: 'verify'` in the response's
`events[]` array (`src/tools/verify/review.ts` builds the phase ctx
before calling `verifier.run()`). Confirm both the passing-task and
failing-task ids show a `phase: 'verify'` event whose content reflects
the remote endpoint's response (not a transport-error marker, for the
passing case; the CI-reported failure, for the failing case).

---

## 7. Record the outcome

Close the loop with a task note on each task id, satisfying the last
acceptance criterion:

```sh
mars task note <passing-task-id> "Remote Verifier Port proof: verify verdict sourced from <relay/CI name> at <URL, redacted>. PASS confirmed, see GET /events?taskId=<passing-task-id>."
mars task note <failing-task-id> "Remote Verifier Port proof: deliberate failure sourced from CI verdict (not a transport error — no remote-http verifier adapter failure marker). See GET /events?taskId=<failing-task-id>."
```

---

## Rollback

Revert to the in-process `local` implementation and restart:

```sh
unset MARS_VERIFIER_KIND   # or: export MARS_VERIFIER_KIND=local
mars daemon restart
```

`.mars/daemon.json`'s `verifier.remoteUrl` / `remoteAuthToken` /
`remoteTimeoutMs` keys are harmless to leave in place — they are only
read when `MARS_VERIFIER_KIND=remote-http` is active.
