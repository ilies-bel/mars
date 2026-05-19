#!/usr/bin/env node
// Computes the next semver tag from a stream of conventional-commit subjects.
// Used by .github/workflows/autobump.yml to decide what tag to cut on every
// push to main.
//
// Usage:
//   git log --format="%s" "$PREV_TAG..HEAD" | \
//     node scripts/compute-next-tag.mjs <current-tag>
//
//   # If no previous tag exists yet, pass "none":
//   git log --format="%s" | node scripts/compute-next-tag.mjs none
//
// Arguments:
//   <current-tag>  A v-prefixed semver tag (e.g. v0.1.0) or the literal
//                  string "none" when no previous tag exists.
//
// Input (stdin):
//   Commit subjects, one per line. Lines that are empty or do not match a
//   conventional-commit prefix are silently skipped.
//
// Output (stdout):
//   The next tag (e.g. v0.2.0) when at least one relevant commit is found,
//   or an empty line when no conventional commits warrant a bump.
//   The script always exits 0 on success, non-zero only on bad arguments.
//
// Bump rules:
//   <type>!: or <type>(<scope>)!:  → breaking change
//     • If MAJOR > 0: major bump (v1.2.3 → v2.0.0)
//     • If MAJOR = 0: treated as minor (v0.1.0 → v0.2.0) — the v0 rule
//   feat: / feat(<scope>):         → minor bump (v0.1.0 → v0.2.0)
//   fix: / perf: / refactor: / … → patch bump (v0.1.0 → v0.1.1)
//   Unrecognised prefixes          → ignored (no bump contribution)
//
// The highest bump level found across all commits wins.

import { createInterface } from "node:readline";

// Strict semver tag: vMAJOR.MINOR.PATCH with no pre-release or build metadata.
// The autobump workflow only reads and writes clean release tags.
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Conventional commit patterns (https://www.conventionalcommits.org/en/v1.0.0/).
// The breaking-change pattern matches any type followed by ! before the colon.
const BREAKING = /^[a-z]+(\([^)]+\))?!:/;
const FEAT = /^feat(\([^)]+\))?:/;
const PATCH_TYPES =
  /^(fix|perf|refactor|style|test|chore|docs|ci|build|revert)(\([^)]+\))?:/;

function fail(message) {
  // `::error::` surfaces the message as an annotation in the GitHub Actions UI.
  console.error(`::error::compute-next-tag: ${message}`);
  process.exit(1);
}

// ── Parse <current-tag> ───────────────────────────────────────────────────

const rawTag = process.argv[2];
if (!rawTag) {
  fail('missing required <current-tag> argument (use "none" if no previous tag exists)');
}

let major, minor, patch;
if (rawTag === "none") {
  major = 0;
  minor = 0;
  patch = 0;
} else {
  const m = SEMVER_TAG.exec(rawTag);
  if (!m) {
    fail(
      `${JSON.stringify(rawTag)} is not a valid v-prefixed semver tag (expected vMAJOR.MINOR.PATCH, e.g. v0.1.0)`,
    );
  }
  major = parseInt(m[1], 10);
  minor = parseInt(m[2], 10);
  patch = parseInt(m[3], 10);
}

// ── Read commit subjects from stdin ───────────────────────────────────────

// Bump levels: 0 = nothing seen yet, 1 = patch, 2 = minor, 3 = breaking
let level = 0;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const subject = line.trim();
  if (!subject) return;

  if (BREAKING.test(subject)) {
    level = 3; // Can't go higher — short-circuit scanning would be an optimisation but correctness is clearer this way.
  } else if (FEAT.test(subject)) {
    if (level < 2) level = 2;
  } else if (PATCH_TYPES.test(subject)) {
    if (level < 1) level = 1;
  }
  // Anything else (merge commits, non-conventional subjects, etc.) is ignored.
});

rl.on("close", () => {
  if (level === 0) {
    // No conventional commits found — emit an empty line so the caller can
    // detect "no bump" without special exit codes.
    console.log("");
    return;
  }

  // Apply the bump.  The v0 rule: a breaking change while MAJOR=0 is treated
  // as a minor bump rather than a major bump, so users stay in a pre-1.0
  // series until they explicitly cut a v1.0.0 tag by hand.
  if (level === 3) {
    if (major === 0) {
      minor += 1;
      patch = 0;
    } else {
      major += 1;
      minor = 0;
      patch = 0;
    }
  } else if (level === 2) {
    minor += 1;
    patch = 0;
  } else {
    // level === 1
    patch += 1;
  }

  console.log(`v${major}.${minor}.${patch}`);
});
