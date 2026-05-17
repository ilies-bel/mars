#!/usr/bin/env node
// Behavioural tests for scripts/check-manifest.mjs, driven through the
// process boundary (spawn the checker, observe exit code + stderr) so the
// tests survive any refactor of the checker's internals.
//
// Run: node scripts/check-manifest.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "check-manifest.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function runCheckerAgainst(root) {
  return spawnSync(process.execPath, [CHECKER], {
    env: { ...process.env, MARS_MANIFEST_ROOT: root },
    encoding: "utf8",
  });
}

function makeFixtureRoot(manifest) {
  const root = mkdtempSync(join(tmpdir(), "mars-manifest-"));
  mkdirSync(join(root, "real"), { recursive: true });
  writeFileSync(join(root, "real", "present.txt"), "i exist\n");
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return root;
}

const fixtures = [];
function fixture(manifest) {
  const root = makeFixtureRoot(manifest);
  fixtures.push(root);
  return root;
}

try {
  // A manifest whose every path resolves passes with exit 0.
  {
    const root = fixture({
      schemaVersion: 1,
      owned: ["real/present.txt"],
      hybrid: [],
    });
    const r = runCheckerAgainst(root);
    check("valid manifest exits 0", r.status === 0, `status=${r.status}`);
  }

  // The core acceptance criterion: a path that no longer exists makes the
  // check fail loudly — non-zero exit and the offending path named.
  {
    const root = fixture({
      schemaVersion: 1,
      owned: ["real/present.txt", "skills/ghost/SKILL.md"],
      hybrid: [],
    });
    const r = runCheckerAgainst(root);
    check("vanished path exits non-zero", r.status !== 0, `status=${r.status}`);
    check(
      "vanished path is named in stderr",
      r.stderr.includes("skills/ghost/SKILL.md"),
      `stderr=${JSON.stringify(r.stderr)}`,
    );
  }

  // A schemaVersion the checker does not understand fails loudly.
  {
    const root = fixture({
      schemaVersion: 999,
      owned: ["real/present.txt"],
      hybrid: [],
    });
    const r = runCheckerAgainst(root);
    check("unknown schemaVersion exits non-zero", r.status !== 0, `status=${r.status}`);
  }

  // A path in both sections is rejected.
  {
    const root = fixture({
      schemaVersion: 1,
      owned: ["real/present.txt"],
      hybrid: ["real/present.txt"],
    });
    const r = runCheckerAgainst(root);
    check("owned/hybrid overlap exits non-zero", r.status !== 0, `status=${r.status}`);
  }
} finally {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall manifest-checker behaviour verified");
