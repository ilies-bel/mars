#!/usr/bin/env node
// Injects the framework release tag as the plugin version into
// .claude/.claude-plugin/plugin.json. Called by the release workflow before
// bundling so the
// plugin reports the same version as the framework release — satisfying the
// "no second version field" invariant: the committed plugin.json carries no
// version, and the version is added only at release time.
//
// Usage: node scripts/inject-plugin-version.mjs <tag>   e.g. v0.3.1
//
// Environment:
//   MARS_PLUGIN_ROOT — override the framework root (default: parent of scripts/)
//
// The tag must start with 'v' followed by a valid semver string. The leading
// 'v' is stripped before writing (e.g. v0.3.1 → "0.3.1").

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = process.env.MARS_PLUGIN_ROOT
  ? resolve(process.env.MARS_PLUGIN_ROOT)
  : resolve(SCRIPT_DIR, "..");

// f5bfd437 nested the plugin root under .claude/.claude-plugin/ so Claude Code
// stops double-registering every /mars:* skill. This path moved with it; the
// old .claude/plugin.json no longer exists in the repo.
const PLUGIN_JSON_PATH = join(
  FRAMEWORK_ROOT,
  ".claude",
  ".claude-plugin",
  "plugin.json",
);

function fail(message) {
  console.error(`✗ inject-plugin-version: ${message}`);
  process.exit(1);
}

const tag = process.argv[2];

if (typeof tag !== "string" || tag.length === 0) {
  fail("missing required <tag> argument (e.g. v0.3.1)");
}

if (!tag.startsWith("v")) {
  fail(`tag must start with 'v', got: ${tag}`);
}

// Strip the leading 'v' to get the semver string.
const version = tag.slice(1);

if (!/^\d+\.\d+\.\d+/.test(version)) {
  fail(`tag does not look like a v-prefixed semver tag: ${tag}`);
}

let raw;
try {
  raw = readFileSync(PLUGIN_JSON_PATH, "utf8");
} catch {
  fail(`.claude/.claude-plugin/plugin.json not found at framework root (${PLUGIN_JSON_PATH})`);
}

let plugin;
try {
  plugin = JSON.parse(raw);
} catch (err) {
  fail(`.claude/.claude-plugin/plugin.json is not valid JSON: ${err.message}`);
}

plugin.version = version;

writeFileSync(PLUGIN_JSON_PATH, JSON.stringify(plugin, null, 2) + "\n");
console.log(`✓ set .claude/.claude-plugin/plugin.json version to ${version}`);
