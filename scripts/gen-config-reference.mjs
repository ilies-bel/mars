#!/usr/bin/env -S npx tsx
// Regenerates docs/reference/configuration.md from the ENV_KNOBS registry
// (orchestrator/src/core/config/env-registry.ts) so the operator-facing
// config reference cannot drift from the knobs Mars actually reads.
//
// Run via `npm run docs:config` (see orchestrator/package.json). Must be
// invoked through `tsx` (not plain `node`) since it imports the TypeScript
// registry + generator module directly — tsx's loader hooks apply to every
// import in the process regardless of this entry file's own .mjs extension,
// so this file stays a thin entry point while the actual source of truth
// (the registry, the markdown-generation logic) lives in orchestrator/src.
//
// CWD-independent, mirroring scripts/check-manifest.mjs: the framework root
// is resolved relative to this script's own location, not process.cwd().

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_KNOBS } from "../orchestrator/src/core/config/env-registry.ts";
import { buildConfigReferenceMarkdown } from "../orchestrator/src/core/config/reference.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, "..");
const OUTPUT_PATH = join(FRAMEWORK_ROOT, "docs", "reference", "configuration.md");

function fail(message) {
  console.error(`✗ config reference generation failed: ${message}`);
  process.exit(1);
}

let markdown;
try {
  markdown = buildConfigReferenceMarkdown(ENV_KNOBS);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, markdown, "utf8");

console.log(
  `✓ wrote ${ENV_KNOBS.length} knob(s) to ${OUTPUT_PATH.replace(`${FRAMEWORK_ROOT}/`, "")}`,
);
