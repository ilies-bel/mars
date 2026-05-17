# mars-bab6909a — slice already complete on main

Slice 5 of 6 for PRD 1bf05375 ("Build self-contained mars binaries with…
ship multi-OS prebuilt `mars` binaries on every release") was already
landed by commit `ab6907c` ("Rename install.sh → install-dev.sh").

## State at re-dispatch

Acceptance criteria, verified against the worktree:

- [x] `install.sh` no longer exists at the repo root
  - `test -e ./install.sh` exits non-zero
- [x] `install-dev.sh` exists at the repo root and is executable
  - `test -x ./install-dev.sh` exits 0 (mode `-rwxr-xr-x`)
- [x] The script's own banner/help text describes it as the developer
      install (edits go live, requires Bun)
  - Header comment block (lines 1–10) labels it the "CONTRIBUTOR install
    path" and spells out the tsx-from-source / edits-go-live behaviour
    and the Bun requirement
  - Runtime banner on line 14 prints
    `mars: developer install (install-dev.sh) — edits to orchestrator/src/** go live; requires Bun.`
- [x] All in-repo references to `install.sh` (READMEs, scripts, CI, docs
      other than CLAUDE.md/ADRs which route through the structured-write
      path) point at `install-dev.sh`
  - `README.md` references `install-dev.sh`
  - `.github/workflows/ci.yml` smoke-test job + step renamed and runs
    `./install-dev.sh`
  - The three remaining `install.sh` mentions are in `CLAUDE.md`,
    `docs/adr/0005-…md`, and `orchestrator/src/init/templates/CLAUDE.md`
    — all three are CLAUDE.md / ADR surfaces which the brief explicitly
    excludes from this slice (they route through `mars glossary` /
    `mars adr`, not direct edits)
- [x] Running `install-dev.sh` on a clean checkout produces a working
      `mars` symlink as before
  - Script flow is unchanged: ensure `tsx` is installed in
    `orchestrator/`, pick a writable bin dir, write a tsx-wrapper to
    `$BIN_DIR/mars`, chmod +x. Only the filename and banner copy
    changed; the rest is byte-for-byte the prior `install.sh`.

Verify command (`test -x ./install-dev.sh && ! test -e ./install.sh`)
exits 0 against the worktree.

## Why this file exists

The rename, the README update, the CI update, and the script-header
rewrite were already on `main` when this task was re-dispatched, so
there is no working-tree diff to land. The orchestrator's merge gate
(`verify:has-diff/no-commits-ahead`) nevertheless requires at least one
commit on the task branch.

This context note exists solely to give the orchestrator a commit to
merge so the re-dispatched run is not parked in `blocked`, and to record
the gap transparently rather than papering over it with an empty
commit.
