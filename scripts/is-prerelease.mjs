#!/usr/bin/env node
// Semver-correct prerelease detector used by .github/workflows/release.yml
// to decide whether to attach `--prerelease` when calling
// `gh release create`. A v-prefixed semver tag like `v0.4.2-rc.1` has a
// prerelease segment (everything between `-` and the optional `+build`
// metadata) and is a prerelease; `v1.0.0` has none and is stable. Build
// metadata alone (`v1.0.0+build.123`) is NOT a prerelease per semver.
//
// Usage: node scripts/is-prerelease.mjs <tag>
//
// Output (to stdout):
//   - "prerelease\n" when <tag> is a valid v-prefixed semver tag with a
//     prerelease segment.
//   - "stable\n" when <tag> is a valid v-prefixed semver tag without
//     one.
// Exit code:
//   - 0 on either of the above.
//   - non-zero (with a `::error::`-prefixed line on stderr so the
//     workflow surfaces it in the Actions UI) if <tag> is missing or
//     does not match the v-prefixed semver grammar. The detector
//     refuses to guess on malformed input so the workflow can never
//     mislabel a Release.

// Reference grammar: https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions
// We additionally require a leading `v` because framework tags are
// always v-prefixed (ADR 0005).
const SEMVER_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function fail(message) {
  // `::error::` makes the line render as an annotation in the GitHub
  // Actions UI when this script is invoked from a workflow step.
  console.error(`::error::is-prerelease: ${message}`);
  process.exit(1);
}

const tag = process.argv[2];
if (typeof tag !== "string" || tag.length === 0) {
  fail("missing required <tag> argument");
}

const match = SEMVER_TAG.exec(tag);
if (!match) {
  fail(`tag ${JSON.stringify(tag)} is not a valid v-prefixed semver version`);
}

const prereleaseSegment = match[4];
console.log(prereleaseSegment ? "prerelease" : "stable");
