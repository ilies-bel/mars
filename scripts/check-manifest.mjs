#!/usr/bin/env node
// Sanity check for the framework install manifest (manifest.json).
//
// Validates that:
//   1. manifest.json exists at the framework repo root.
//   2. It declares a numeric `schemaVersion` and two arrays, `owned` and
//      `hybrid`.
//   3. Every path listed in `owned[]` and `hybrid[]` resolves to a real
//      file inside the framework checkout.
//   4. No path appears in both sections.
//
// Exits non-zero with a loud, specific message on any failure so that
// shipping a new asset without updating the manifest — or letting the
// manifest reference a path that no longer exists — breaks the build
// instead of silently producing a broken `mars install`.
//
// CWD-independent: the framework root is resolved relative to this
// script's own location, so it can be invoked from anywhere.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Default to the real framework root (parent of scripts/). MARS_MANIFEST_ROOT
// overrides it so the behavioural test can point the checker at a fixture
// checkout; nothing in normal operation sets it.
const FRAMEWORK_ROOT = process.env.MARS_MANIFEST_ROOT
  ? resolve(process.env.MARS_MANIFEST_ROOT)
  : resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = join(FRAMEWORK_ROOT, "manifest.json");

function fail(message) {
  console.error(`✗ manifest check failed: ${message}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(MANIFEST_PATH, "utf8");
} catch {
  fail(`manifest.json not found at framework root (${MANIFEST_PATH})`);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (err) {
  fail(`manifest.json is not valid JSON: ${err.message}`);
}

if (typeof manifest.schemaVersion !== "number") {
  fail("manifest.json must declare a numeric `schemaVersion` field");
}
if (manifest.schemaVersion !== SCHEMA_VERSION) {
  fail(
    `manifest.json schemaVersion is ${manifest.schemaVersion}, this checker understands ${SCHEMA_VERSION}`,
  );
}

for (const section of ["owned", "hybrid"]) {
  if (!Array.isArray(manifest[section])) {
    fail(`manifest.json must declare an array \`${section}[]\``);
  }
  if (manifest[section].some((p) => typeof p !== "string" || p.length === 0)) {
    fail(`every entry in \`${section}[]\` must be a non-empty string path`);
  }
}

const overlap = manifest.owned.filter((p) => manifest.hybrid.includes(p));
if (overlap.length > 0) {
  fail(
    `the following path(s) appear in both owned[] and hybrid[]: ${overlap.join(", ")}`,
  );
}

const missing = [];
for (const section of ["owned", "hybrid"]) {
  for (const rel of manifest[section]) {
    const abs = join(FRAMEWORK_ROOT, rel);
    try {
      if (!statSync(abs).isFile()) {
        missing.push(`${rel} (${section}: exists but is not a regular file)`);
      }
    } catch {
      missing.push(`${rel} (${section}: no such file in framework checkout)`);
    }
  }
}

if (missing.length > 0) {
  fail(
    `manifest references ${missing.length} path(s) that do not resolve:\n  - ${missing.join("\n  - ")}`,
  );
}

const total = manifest.owned.length + manifest.hybrid.length;
console.log(
  `✓ manifest.json OK — schemaVersion ${manifest.schemaVersion}, ` +
    `${manifest.owned.length} owned + ${manifest.hybrid.length} hybrid = ${total} paths, all resolve`,
);
