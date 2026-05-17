# CONTEXT: mars-86125365 — release tag-push workflow already on main

**Task**: Slice 2/5 of PRD `2800e23a-add-a-release-yml-github-actions-workflo` —
"Tag-push release workflow publishes a validated Bundle tarball."

**Verdict**: No code change required. The slice's seven acceptance criteria
are already satisfied by `.github/workflows/release.yml`, which landed on
`main` before this task was dispatched. The most recent extension of that
file was `c21c7cb feat(release): semver-correct prerelease flag on Bundle
Releases (slice 4/5)`; the foundational tag-push + validate + package +
publish pipeline described by slice 2 was in place by then.

## Acceptance-criteria walkthrough

Mapping each `<done>` line to the exact location in
`.github/workflows/release.yml` (line numbers as of this commit):

1. **Triggers on `v*` tag pushes** — `on.push.tags: ['v*']`, lines 14-17.
2. **Top-level perms read-only; `contents:write` job-scoped only** —
   workflow-level `permissions: contents: read` (lines 27-28); the
   `release` job adds `permissions: contents: write` (lines 36-37). No
   other job is defined, so write access is confined to that job by
   construction.
3. **`manifest.json` validated against tagged commit; fail before any
   Release** — the "Validate manifest against tagged commit" step
   (lines 68-81) shells out to `scripts/check-manifest.mjs`, which exits
   non-zero on a missing/malformed manifest or any unresolved `owned[]`
   or `hybrid[]` path. The "Build Bundle tarball" step (lines 102-114)
   re-asserts presence per file as defense in depth. Both run before the
   gated `gh release create` step.
4. **On happy path, a Release is created and `mars-bundle-vX.Y.Z.tar.gz`
   is attached** — the "Publish Release" step (lines 183-223) is gated
   on `github.event_name == 'push' && github.ref_type == 'tag'` and
   calls `gh release create "$TAG" "$BUNDLE" ...` where
   `BUNDLE=mars-bundle-${TAG}.tar.gz` (line 65). (A `.sha256` sidecar is
   uploaded in the same call — that is additional integrity material
   landed by a sibling slice; it does not contradict this AC, which
   requires the tarball to be present.)
5. **Tarball = `manifest.json` ∪ `owned[]` ∪ `hybrid[]`, nothing else**
   — the file list is built via `jq -r '(.owned // []) + (.hybrid //
   []) | .[]'` plus `manifest.json`, sorted and de-duplicated (lines
   96-100). After `tar` runs, the archive's contents are diff'd against
   that exact list and the run fails on any drift (lines 132-142).
6. **No PAT or external secret; only the auto-provisioned `GITHUB_TOKEN`**
   — the publish step sets `GH_TOKEN: ${{ github.token }}` (line 191)
   and references no `secrets.*` value anywhere in the file.
7. **Dry-run / PR-validation path proves logic without creating a
   Release** — `workflow_dispatch` is declared (lines 18-23) with a
   `dry_run` input. The publish step's `if:` excludes non-tag/non-push
   events (line 189), so a manual dispatch runs validate + package end
   to end and stops at the "Dry-run summary" step (lines 225-232),
   which prints the tarball contents without calling `gh release
   create`.

## Why this is a "note, don't re-implement"

This repo's convention (see commits `b202a67`, `2bc63cc`, `adb8e52`,
`50f9bb6`, `3b29c6b`, `f03df66`) is that when a slice's deliverables are
already present on `main` because a later or sibling slice subsumed
them, the executing worker records a context note rather than producing
a duplicate or no-op workflow change. The orchestrator can then close
the task cleanly and move on.

No code in `.github/workflows/`, `scripts/`, or `manifest.json` needed
modification to satisfy slice 2's acceptance criteria.
