# ci-listener

Push-based bridge from GitHub Actions → Mars task queue. No polling.

```
GitHub workflow_run event
   → smee.io channel
   → smee-client (local)
   → Bun server (verifies HMAC)
   → mars task add
```

## Setup

1. **Create a smee channel** at https://smee.io/new — copy the URL.

2. **Generate a webhook secret**:
   ```bash
   openssl rand -hex 32
   ```

3. **Add a GitHub webhook** on the repo whose pipeline you want to track:
   - Settings → Webhooks → Add webhook
   - Payload URL: your smee URL
   - Content type: `application/json`
   - Secret: the value from step 2
   - Events: "Let me select" → check **Workflow runs**

4. **Copy `.env.example` to `.env`** and fill in:
   - `GH_WEBHOOK_SECRET` — same secret as GitHub
   - `MARS_REPO` — absolute path to the local repo whose `.mars/queue.db` receives tasks
   - `SMEE_URL` — your smee channel
   - `ONLY_FAILURES=1` to skip enqueueing on green runs (optional)

5. **Run**:
   ```bash
   ./start.sh
   ```

   Two processes start: the Bun server on `localhost:$PORT` and `smee-client`
   forwarding webhook deliveries to it. Hit `localhost:7878/health` to sanity-check.

## Auto-start on macOS (launchd)

```bash
# substitute the absolute path of this directory
ABS=$(pwd)
sed "s|__ABS_PATH__|$ABS|g" com.mars.ci-listener.plist > ~/Library/LaunchAgents/com.mars.ci-listener.plist
launchctl load ~/Library/LaunchAgents/com.mars.ci-listener.plist
```

Logs land in `ci-listener.out.log` / `ci-listener.err.log` next to `start.sh`.
Unload with `launchctl unload ~/Library/LaunchAgents/com.mars.ci-listener.plist`.

## What gets enqueued

On every completed `workflow_run`, the listener calls:

```
mars --repo $MARS_REPO task add "<self-contained prompt with run url, branch, sha, conclusion>"
```

The prompt tells the dispatched agent to investigate failures, run verify,
commit the fix, and close as no-op on success. Customize the prompt template
in `server.ts` if you want a different default behavior.
