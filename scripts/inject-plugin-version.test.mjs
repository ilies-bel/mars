#!/usr/bin/env node
// Behavioural tests for scripts/inject-plugin-version.mjs, driven through the
// process boundary (spawn the script, observe exit code + file output) so the
// tests survive any refactor of the script's internals.
//
// Run: node scripts/inject-plugin-version.test.mjs

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "inject-plugin-version.mjs",
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

function runScript(tag, root) {
  return spawnSync(process.execPath, [SCRIPT, tag], {
    env: { ...process.env, MARS_PLUGIN_ROOT: root },
    encoding: "utf8",
  });
}

function makeFixtureRoot(pluginJson) {
  const root = mkdtempSync(join(tmpdir(), "mars-plugin-inject-"));
  mkdirSync(join(root, ".claude", ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude", ".claude-plugin", "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );
  return root;
}

const fixtures = [];
function fixture(pluginJson) {
  const root = makeFixtureRoot(pluginJson);
  fixtures.push(root);
  return root;
}

try {
  // Core acceptance criterion: tagged build stamps the framework version into
  // plugin.json so the plugin reports the release tag it was built from.
  {
    const root = fixture({
      name: "mars",
      description: "Mars Claude Code plugin",
    });
    const r = runScript("v0.3.1", root);
    check("exits 0 on success", r.status === 0, `status=${r.status}\nstderr=${r.stderr}`);
    const out = JSON.parse(
      readFileSync(join(root, ".claude", ".claude-plugin", "plugin.json"), "utf8"),
    );
    check(
      "injects semver version without v prefix",
      out.version === "0.3.1",
      `version=${out.version}`,
    );
    check(
      "preserves existing name field",
      out.name === "mars",
      `name=${out.name}`,
    );
    check(
      "preserves existing description field",
      typeof out.description === "string",
      `description=${out.description}`,
    );
  }

  // Prerelease tags (e.g. rc, beta) are preserved verbatim after stripping 'v'.
  {
    const root = fixture({ name: "mars" });
    const r = runScript("v0.4.0-rc.1", root);
    check(
      "prerelease tag exits 0",
      r.status === 0,
      `status=${r.status}\nstderr=${r.stderr}`,
    );
    const out = JSON.parse(
      readFileSync(join(root, ".claude", ".claude-plugin", "plugin.json"), "utf8"),
    );
    check(
      "prerelease version preserved verbatim",
      out.version === "0.4.0-rc.1",
      `version=${out.version}`,
    );
  }

  // No second version field in the repository: the committed plugin.json must
  // not carry a version field — the version is added only at release time.
  {
    const repoRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const pluginPath = join(repoRoot, ".claude", ".claude-plugin", "plugin.json");
    let pluginJson;
    try {
      pluginJson = JSON.parse(readFileSync(pluginPath, "utf8"));
    } catch (e) {
      failures++;
      console.error(
        `  ✗ .claude/.claude-plugin/plugin.json exists in repo — could not read: ${e.message}`,
      );
      pluginJson = null;
    }
    if (pluginJson !== null) {
      check(
        "committed plugin.json has no version field",
        !Object.prototype.hasOwnProperty.call(pluginJson, "version"),
        `found version=${pluginJson.version}`,
      );
    }
  }

  // Missing plugin.json fails loudly rather than silently producing a
  // broken bundle artifact.
  {
    const root = mkdtempSync(join(tmpdir(), "mars-plugin-missing-"));
    fixtures.push(root);
    mkdirSync(join(root, ".claude", ".claude-plugin"), { recursive: true }); // intentionally no plugin.json
    const r = runScript("v0.1.0", root);
    check(
      "missing plugin.json exits non-zero",
      r.status !== 0,
      `status=${r.status}`,
    );
  }

  // Missing tag argument fails loudly.
  {
    const root = fixture({ name: "mars" });
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, MARS_PLUGIN_ROOT: root },
      encoding: "utf8",
    });
    check(
      "missing tag argument exits non-zero",
      r.status !== 0,
      `status=${r.status}`,
    );
  }
} finally {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall inject-plugin-version behaviour verified");
