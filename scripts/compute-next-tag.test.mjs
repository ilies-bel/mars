#!/usr/bin/env node
// Behavioural tests for scripts/compute-next-tag.mjs — the conventional-commit
// bump calculator used by .github/workflows/autobump.yml to decide the next
// semver tag. Driven through the process boundary (spawn the script, observe
// exit code + stdout) so the tests survive any internal refactor.
//
// Run: node scripts/compute-next-tag.test.mjs

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "compute-next-tag.mjs",
);

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Invoke the script with a current tag and zero or more commit subjects. */
function run(currentTag, commits = []) {
  return spawnSync(process.execPath, [SCRIPT, currentTag], {
    input: commits.join("\n"),
    encoding: "utf8",
  });
}

// ── Tracer bullet ──────────────────────────────────────────────────────────
// The most central criterion: a feat: commit against a stable tag produces
// a minor-bumped tag.
{
  const r = run("v0.1.0", ["feat: add streaming support"]);
  check(
    "feat commit against v0.1.0 → v0.2.0 (minor bump)",
    r.status === 0 && r.stdout.trim() === "v0.2.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── fix: → patch bump ──────────────────────────────────────────────────────
{
  const r = run("v0.1.0", ["fix: correct off-by-one error"]);
  check(
    "fix commit against v0.1.0 → v0.1.1 (patch bump)",
    r.status === 0 && r.stdout.trim() === "v0.1.1",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── feat!: while major=0 → minor, NOT major ───────────────────────────────
// The v0 rule: a breaking change while the major component is 0 is
// treated as a minor bump rather than a major bump.
{
  const r = run("v0.1.0", ["feat!: redesign public API"]);
  check(
    "feat! against v0.1.0 (major=0) → v0.2.0, not v1.0.0",
    r.status === 0 && r.stdout.trim() === "v0.2.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── feat!: while major>0 → real major bump ────────────────────────────────
{
  const r = run("v1.2.3", ["feat!: drop legacy endpoint"]);
  check(
    "feat! against v1.2.3 (major=1) → v2.0.0 (major bump)",
    r.status === 0 && r.stdout.trim() === "v2.0.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── Scoped conventional commit: feat(ui): → still minor ──────────────────
{
  const r = run("v0.2.0", ["feat(ui): add dark mode toggle"]);
  check(
    "scoped feat(ui): → minor bump",
    r.status === 0 && r.stdout.trim() === "v0.3.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── Scoped breaking change while major=0 → minor ─────────────────────────
{
  const r = run("v0.2.0", ["feat(api)!: redesign task schema"]);
  check(
    "scoped feat(api)!: against v0.2.0 (major=0) → v0.3.0, not v1.0.0",
    r.status === 0 && r.stdout.trim() === "v0.3.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── Mixed commits: highest bump wins ─────────────────────────────────────
{
  const r = run("v0.1.0", [
    "fix: patch a null check",
    "feat: add retry logic",
    "chore: bump deps",
  ]);
  check(
    "mixed fix + feat → minor bump (highest wins)",
    r.status === 0 && r.stdout.trim() === "v0.2.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── No commits → no bump (empty output, exit 0) ───────────────────────────
{
  const r = run("v0.1.0", []);
  check(
    "no commits → empty output (no bump)",
    r.status === 0 && r.stdout.trim() === "",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── Non-conventional commits only → no bump ───────────────────────────────
{
  const r = run("v0.1.0", ["Initial commit", "WIP", "update README"]);
  check(
    "non-conventional commits only → no bump",
    r.status === 0 && r.stdout.trim() === "",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── No previous tag ("none") + feat: → v0.1.0 ────────────────────────────
{
  const r = run("none", ["feat: initial release"]);
  check(
    "feat with no previous tag (none) → v0.1.0",
    r.status === 0 && r.stdout.trim() === "v0.1.0",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── No previous tag ("none") + fix: → v0.0.1 ─────────────────────────────
{
  const r = run("none", ["fix: correct bootstrap path"]);
  check(
    "fix with no previous tag (none) → v0.0.1",
    r.status === 0 && r.stdout.trim() === "v0.0.1",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── patch-class commit types (fix, perf, refactor, chore …) → patch ──────
for (const type of ["perf", "refactor", "style", "test", "chore", "docs", "ci", "build", "revert"]) {
  const r = run("v0.3.0", [`${type}: routine maintenance`]);
  check(
    `${type}: commit → patch bump (v0.3.1)`,
    r.status === 0 && r.stdout.trim() === "v0.3.1",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── Malformed current tag → non-zero exit ────────────────────────────────
for (const bad of ["0.1.0", "vfoo", "v1.0", ""]) {
  const r = run(bad, ["feat: something"]);
  check(
    `malformed current tag ${JSON.stringify(bad)} → non-zero exit`,
    r.status !== 0,
    `status=${r.status} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// ── Missing argument → non-zero exit ─────────────────────────────────────
{
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: "feat: something",
    encoding: "utf8",
  });
  check(
    "missing <current-tag> argument → non-zero exit",
    r.status !== 0,
    `status=${r.status} stderr=${JSON.stringify(r.stderr)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall compute-next-tag behaviour verified");
