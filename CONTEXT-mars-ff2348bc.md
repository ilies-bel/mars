# Unblock note for mars-ff2348bc — bootstrap test harness lives on a salvage tag

Slice 1/5 of PRD `054082c9-add-a-one-liner-bootstrap-installer-e-g`
asks for `get-mars.sh` platform detection + a test harness exercising
four supported and ≥2 unsupported pairs. The implementor agent stalled
because it went hunting in `orchestrator/src/mastra/lib/` (unrelated
to a shell bootstrap installer), and the read-span watcher killed it
after 5 reads.

## State on `main`

- **Feature is shipped.** `get-mars.sh` at the repo root already
  implements platform detection (Darwin/Linux × arm64/x86_64),
  `GET_MARS_OS` / `GET_MARS_ARCH` overrides for tests, no network or
  filesystem side effects on the failure path, and a clear
  unsupported-platform abort. Landed as `f41f605 feat(get-mars): land
  platform-detection bootstrap script on main`. Acceptance criteria 1–4
  are all met by this file as-is.

- **Test harness is NOT on main.** A 134-line bats spec already exists
  but is reachable only from a salvage tag, never merged:

  ```
  tag:      salvage/mars-ff2348bc-20260517-141637
  commit:   9514c91  test(get-mars): behavioural harness for platform detection
  path:     orchestrator/test/get-mars/platform.bats
  ```

  Its commit message lines up exactly with acceptance criterion 5
  ("A test harness exercises all four supported pairs and at least
  two unsupported pairs") — four supported pairs, uname-style alias
  normalisation, unsupported-OS and unsupported-arch abort cases, and
  a curl/wget stub on `PATH` that proves no network call happens on
  the unsupported abort path.

## What the next implementor should do

Bring the existing salvaged spec into the worktree — do not rewrite
from scratch. From the parent worktree root:

```
git show salvage/mars-ff2348bc-20260517-141637:orchestrator/test/get-mars/platform.bats \
  > orchestrator/test/get-mars/platform.bats
mkdir -p orchestrator/test/get-mars   # if needed before the redirect
chmod +x orchestrator/test/get-mars/platform.bats   # optional; bats doesn't require it
```

(or `git cherry-pick 9514c91` if the tree is clean and the commit
applies — it touches only that one new file.)

Then run the spec to confirm green:

```
bats orchestrator/test/get-mars/platform.bats
```

If `bats` is not installed on the host:

```
brew install bats-core      # macOS
# or
npm i -D bats && npx bats orchestrator/test/get-mars/platform.bats
```

Stage and commit (`git add orchestrator/test/get-mars/platform.bats &&
git commit`), then exit. No change to `get-mars.sh` itself is required
— the script already satisfies the behaviour the spec asserts.

## Why this is in scope for slice 1, not a follow-up

The PRD's acceptance criterion 5 is part of *this* slice; it is not a
later thickening. The work is "land one bats file" and is small enough
to fit the tracer-bullet rule. Do not add download, checksum, or
install behaviour — those belong to slices 2–5 and are explicitly out
of scope here.

## Do not re-read these (already triaged)

- `orchestrator/src/mastra/lib/resolve-task-cwd.ts` — unrelated
- `orchestrator/src/mastra/lib/derive-repro-command.ts` — unrelated
- `orchestrator/src/mastra/lib/git.ts` — unrelated

The implementor's previous read trail was wrong: this slice has no
TypeScript surface at all. Everything you need lives at the repo root
(`get-mars.sh`) and at the salvage-tag path above.
