# READ THIS FIRST — Unblock note for mars-ff2348bc

The previous implementor for this task burned its read budget in
`orchestrator/src/mastra/lib/` (resolve-task-cwd, derive-repro-command,
git) and was aborted by the watcher. **None of those files are relevant
to this slice.** Do not re-open them.

This slice is shell-script + a test that spawns it. Nothing else.

## TL;DR — what's already done vs. what's left

| Acceptance criterion | Status |
| --- | --- |
| 1. Supported platforms print `<os>-<arch>` and exit 0 | **DONE** — `get-mars.sh` at repo root, commit `f41f605` |
| 2. Simulated unsupported OS aborts with naming error | **DONE** — same file |
| 3. Simulated unsupported arch aborts with naming error | **DONE** — same file |
| 4. No HTTP requests on the unsupported path | **DONE by construction** — `get-mars.sh` has no network code yet; only `uname` and `echo`. AC re-asserts as a test below. |
| 5. Test harness exercises 4 supported + ≥2 unsupported pairs | **TODO** — this is the entire scope of the redispatch |

`get-mars.sh` already exposes the seams a behavioural test needs:
`GET_MARS_OS` and `GET_MARS_ARCH` env-var overrides on top of `uname -s`
/ `uname -m`. Do **not** modify the script; the test drives it through
its public interface.

## What to do

Add **one** test file, `orchestrator/test/get-mars/platform.test.ts`,
that spawns `get-mars.sh` via `execFile` (no shell) under various
`GET_MARS_OS` / `GET_MARS_ARCH` combinations and asserts on stdout,
stderr, and exit code. Use `vitest` — it is the project's test runner
(`npm test` → `vitest run`) and already covers
`orchestrator/test/git-portability.test.ts`, which is the closest
template to follow.

### Behavioural reference: the salvaged bats spec

A behaviour-equivalent `bats` spec was written previously and parked on
a salvage tag. It is reachable but not on `main`:

```
tag:     salvage/mars-ff2348bc-20260517-141637
commit:  9514c91  test(get-mars): behavioural harness for platform detection
path:    orchestrator/test/get-mars/platform.bats
```

Use it as the *behavioural spec* — not the file to land. Inspect it:

```
git show salvage/mars-ff2348bc-20260517-141637:orchestrator/test/get-mars/platform.bats
```

Port each `@test` block to a `vitest` `it(...)` block in the new
`platform.test.ts`. The cases you must cover (taken from AC + bats
spec):

- All four supported pairs: `Darwin/arm64`, `Darwin/x86_64`,
  `Linux/arm64`, `Linux/x86_64` → exit 0, stdout exactly
  `<darwin|linux>-<arm64|x86_64>`.
- `uname` aliases: `aarch64` → `arm64`, `amd64` → `x86_64`.
- Unsupported OS (e.g. `Windows_NT/x86_64`) → non-zero exit, stderr
  contains `Windows_NT` and `x86_64`.
- Unsupported arch (e.g. `Linux/mips`) → non-zero exit, stderr contains
  `Linux` and `mips`.
- No-network assertion: spawn with `PATH` rewritten to a tmp dir
  containing `curl` and `wget` shell stubs that append to a marker
  file; on the unsupported abort path the marker file must not exist.
- A "harness sweep" `it` (or `it.each`) that iterates the four
  supported pairs and at least two unsupported pairs.

### Skeleton to start from

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
// orchestrator/test/get-mars/ → ../../../get-mars.sh at the worktree root
const SCRIPT = resolve(here, '..', '..', '..', 'get-mars.sh')

async function runPlatform(os: string, arch: string, opts: { stubPath?: string } = {}) {
  const env = {
    ...process.env,
    GET_MARS_OS: os,
    GET_MARS_ARCH: arch,
    ...(opts.stubPath ? { PATH: `${opts.stubPath}:${process.env.PATH ?? ''}` } : {}),
  }
  try {
    const { stdout, stderr } = await exec('bash', [SCRIPT], { env })
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, stdout: (err.stdout ?? '').trim(), stderr: (err.stderr ?? '').trim() }
  }
}
```

The curl/wget stub pattern from the bats spec ports cleanly: make a
tmp dir, write two scripts that append `"$0 $*\n"` to
`$STUB_DIR/network-was-called`, `chmod +x` them, and pass
`stubPath: STUB_DIR` to `runPlatform`. After the unsupported run,
`fs.stat` on the marker should reject with `ENOENT`.

### Verify

```
cd orchestrator && npm test -- get-mars/platform
```

(`npm test` runs the `pretest` chain — `sync-claude-templates` and
`sync-version` — then `vitest run`. The filter pattern just narrows
which suite runs while you iterate; verify should run the full
`npm test` once before commit.)

## Out of scope — do not touch in this slice

- Downloading the prebuilt binary, sha256 verification, install-to-PATH
  — those are slices 2–5 of PRD `054082c9`.
- Any change to `get-mars.sh` itself. The script already meets AC 1–4;
  changing it now would conflate slices.
- Anything under `orchestrator/src/mastra/lib/`. The previous read trail
  through these files was a wrong turn; nothing in this slice depends
  on them.

## Do not bail

If you discover something you can't fit in this scope, **do not exit
silently**. File a `mars task add --blocked-by $TASK_ID` follow-up (for
work that should block this slice) or `mars idea add` (for parked
observations), commit whatever in-scope work is complete, and exit.
The watcher will abort you if you read 5 files in a row without acting
— this note + the salvage commit + the skeleton above should be
enough to start writing the test file on read #2 or #3.
