# Release workflow end-to-end verification runbook

One-shot operator procedure for slice 5/5 of PRD
`2800e23a-add-a-release-yml-github-actions-workflo`. Executes the
end-to-end verification that the `Release` workflow
(`.github/workflows/release.yml`) actually publishes a Bundle when a
real semver tag is pushed against the framework repository.

This is **not** a recurring release-policy doc — that is explicitly
out of scope for this PRD until the workflow has been exercised a few
times. This file documents one maiden exercise: cut a throwaway stable
tag, cut a throwaway prerelease tag, verify the published assets, and
prove the negative path fails closed.

Acceptance criteria covered:

1. A stable `vX.Y.Z` tag publishes a Release with the contracted
   tarball + sha256 sidecar assets.
2. A `vX.Y.Z-<pre>` tag publishes a Release flagged as prerelease,
   same asset shape.
3. The published sha256 sidecar matches the published tarball's
   sha256 byte for byte.
4. The published tarball, when extracted, contains exactly
   `manifest.json` plus the union of `owned[]` and `hybrid[]` paths
   it lists — nothing else.
5. A negative-path run (manifest pointing at a missing path) fails
   the workflow and creates no Release.

All commands assume:

- `gh` authenticated against the framework repository.
- `OWNER/REPO` environment variable set to the framework's GitHub
  slug (`export OWNER_REPO=<owner>/<repo>`).
- `jq` and `sha256sum` available locally.

## 1. Throwaway stable tag — criterion (1)

Pick a tag that does not collide with any planned real release. For
this maiden exercise, use a high patch on a `v0.0.x` line so it can be
deleted afterwards without affecting future `v0.1.0`+ planning:

```sh
TAG=v0.0.99
git checkout main
git pull --ff-only
git tag "$TAG"
git push origin "$TAG"
```

Watch the workflow run:

```sh
gh run watch --repo "$OWNER_REPO" \
  "$(gh run list --repo "$OWNER_REPO" --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')"
```

Expected:

- Workflow concludes `success`.
- `gh release view "$TAG" --repo "$OWNER_REPO"` shows a Release whose
  assets are exactly `mars-bundle-$TAG.tar.gz` and
  `mars-bundle-$TAG.tar.gz.sha256`.
- The Release is **not** marked prerelease (`isPrerelease: false`).

Quick check:

```sh
gh release view "$TAG" --repo "$OWNER_REPO" \
  --json isPrerelease,assets \
  -q '{prerelease: .isPrerelease, assets: [.assets[].name]}'
```

Tick acceptance criterion (1) when both asset names appear and
`prerelease` is `false`.

## 2. Throwaway prerelease tag — criterion (2)

```sh
PRETAG=v0.0.99-rc.1
git tag "$PRETAG"
git push origin "$PRETAG"
gh run watch --repo "$OWNER_REPO" \
  "$(gh run list --repo "$OWNER_REPO" --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')"
```

Expected:

- Workflow concludes `success`.
- `gh release view "$PRETAG"` shows the same two-asset shape with the
  `$PRETAG` substituted into both filenames.
- The Release **is** marked prerelease.

```sh
gh release view "$PRETAG" --repo "$OWNER_REPO" \
  --json isPrerelease,assets \
  -q '{prerelease: .isPrerelease, assets: [.assets[].name]}'
```

Tick acceptance criterion (2) when both asset names appear and
`prerelease` is `true`.

## 3. Download + recompute sha256 — criterion (3)

```sh
mkdir -p /tmp/mars-bundle-verify && cd /tmp/mars-bundle-verify
gh release download "$TAG" --repo "$OWNER_REPO" \
  --pattern "mars-bundle-$TAG.tar.gz" \
  --pattern "mars-bundle-$TAG.tar.gz.sha256"

# Recompute and compare to the published sidecar.
sha256sum -c "mars-bundle-$TAG.tar.gz.sha256"
```

Expected: `mars-bundle-$TAG.tar.gz: OK`.

Repeat for `$PRETAG` if you want both proven.

Tick acceptance criterion (3) when `sha256sum -c` prints `OK`.

## 4. Extract + diff against manifest — criterion (4)

```sh
cd /tmp/mars-bundle-verify
mkdir extracted && tar -xzf "mars-bundle-$TAG.tar.gz" -C extracted

# Actual: every regular file in the tarball, sorted.
( cd extracted && find . -type f | sed 's|^\./||' ) | sort -u > actual.txt

# Expected: manifest.json plus union of owned[] and hybrid[].
jq -r '["manifest.json"] + (.owned // []) + (.hybrid // []) | .[]' \
  extracted/manifest.json | sort -u > expected.txt

diff -u expected.txt actual.txt
```

Expected: `diff` produces no output (exit 0). Any line in `expected`
not in `actual` or vice versa is a contract violation.

Tick acceptance criterion (4) when the diff is empty.

## 5. Negative path: manifest pointing at a missing file — criterion (5)

Do **not** push this from `main`. Use a throwaway branch + tag so the
failure is isolated and easy to clean up.

```sh
git checkout -b release-negative-test main
# Add a path that does not exist anywhere in the worktree.
jq '.owned += ["does-not-exist.txt"]' manifest.json > manifest.json.tmp
mv manifest.json.tmp manifest.json
git add manifest.json
git commit -m "test: manifest entry pointing at a missing file (verify workflow fails closed)"

NEGTAG=v0.0.99-negative
git tag "$NEGTAG"
git push origin release-negative-test
git push origin "$NEGTAG"

gh run watch --repo "$OWNER_REPO" \
  "$(gh run list --repo "$OWNER_REPO" --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')"
```

Expected:

- Workflow concludes `failure` at the "Validate manifest against
  tagged commit" step (or the defense-in-depth check in "Build Bundle
  tarball"), with an `::error::` line naming the missing path.
- `gh release view "$NEGTAG" --repo "$OWNER_REPO"` returns
  `release not found` — no Release was created.

```sh
# Should error with "release not found":
gh release view "$NEGTAG" --repo "$OWNER_REPO" || echo "OK: no Release created"
```

Tick acceptance criterion (5) when the workflow run is red and the
Release lookup fails.

## Cleanup

After ticking every box, delete the throwaway artefacts so they do
not pollute the public release list:

```sh
# Delete Releases (and their assets).
gh release delete "$TAG"      --repo "$OWNER_REPO" --yes --cleanup-tag
gh release delete "$PRETAG"   --repo "$OWNER_REPO" --yes --cleanup-tag

# Negative tag had no Release; delete just the tag + branch.
git push origin :refs/tags/"$NEGTAG"
git push origin :release-negative-test
git tag -d "$NEGTAG"
git branch -D release-negative-test
```

The `--cleanup-tag` flag on `gh release delete` removes both the
Release and the underlying git tag in one step, so the public tag
list is left in the pre-verification state.

## Handing back to Mars

Once every acceptance criterion is ticked, mark this checkpoint task
done (e.g. `mars task complete mars-a1340068`) so the orchestrator
can merge slice 5/5 into `main` and close PRD
`2800e23a-add-a-release-yml-github-actions-workflo`.

If any criterion fails in a way the workflow source is responsible
for (rather than operator error), file a fix as a new Mars task
rather than patching it in-place from this branch.
