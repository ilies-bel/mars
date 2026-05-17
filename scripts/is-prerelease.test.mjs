#!/usr/bin/env node
// Behavioural tests for scripts/is-prerelease.mjs — the semver-correct
// prerelease detector the release workflow uses to decide whether to
// pass `--prerelease` to `gh release create`. Driven through the
// process boundary (spawn the script, observe exit code + stdout) so
// the tests survive any refactor of the detector's internals.
//
// Run: node scripts/is-prerelease.test.mjs

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "is-prerelease.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(tag) {
  const argv = tag === undefined ? [SCRIPT] : [SCRIPT, tag];
  return spawnSync(process.execPath, argv, { encoding: "utf8" });
}

// Tracer bullet: the central acceptance criterion is that a prerelease
// semver tag is detected AS prerelease.
{
  const r = run("v0.4.2-rc.1");
  check(
    "prerelease tag v0.4.2-rc.1 → exit 0, stdout 'prerelease'",
    r.status === 0 && r.stdout.trim() === "prerelease",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// Mirror case: a plain stable semver tag is detected AS stable.
{
  const r = run("v1.0.0");
  check(
    "stable tag v1.0.0 → exit 0, stdout 'stable'",
    r.status === 0 && r.stdout.trim() === "stable",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// Build metadata alone (no prerelease segment) is stable per semver.
{
  const r = run("v1.0.0+build.123");
  check(
    "tag with build metadata only v1.0.0+build.123 → 'stable'",
    r.status === 0 && r.stdout.trim() === "stable",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`,
  );
}

// Prerelease segment with build metadata is still prerelease.
{
  const r = run("v1.0.0-rc.1+build.123");
  check(
    "tag with prerelease + build v1.0.0-rc.1+build.123 → 'prerelease'",
    r.status === 0 && r.stdout.trim() === "prerelease",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`,
  );
}

// Multi-digit components and rich prerelease identifiers, both directions.
{
  const r = run("v10.20.30");
  check(
    "multi-digit stable v10.20.30 → 'stable'",
    r.status === 0 && r.stdout.trim() === "stable",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`,
  );
}
{
  const r = run("v1.0.0-0.3.7");
  check(
    "numeric-only prerelease v1.0.0-0.3.7 → 'prerelease'",
    r.status === 0 && r.stdout.trim() === "prerelease",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`,
  );
}
{
  const r = run("v1.0.0-alpha");
  check(
    "single-identifier prerelease v1.0.0-alpha → 'prerelease'",
    r.status === 0 && r.stdout.trim() === "prerelease",
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`,
  );
}

// Malformed inputs fail loudly so the workflow never silently mislabels
// a Release. These would currently slip through the looser `*-*)` glob.
for (const bad of ["1.0.0", "vfoo", "v1.0", "v1.0.0-", "v01.0.0", ""]) {
  const r = run(bad);
  check(
    `malformed tag ${JSON.stringify(bad)} → non-zero exit`,
    r.status !== 0,
    `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
  );
}

// Missing argument is a usage error, not a silent pass.
{
  const r = run(undefined);
  check(
    "no argument → non-zero exit",
    r.status !== 0,
    `status=${r.status} stderr=${JSON.stringify(r.stderr)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall is-prerelease behaviour verified");
