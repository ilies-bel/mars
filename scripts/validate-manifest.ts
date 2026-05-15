#!/usr/bin/env bun
/**
 * Validate the framework manifest at the repo root.
 *
 * Confirms that:
 *   1. The manifest parses cleanly as TOML.
 *   2. It declares an array of files, each with `source` and `destination`
 *      strings and a boolean `executable` flag.
 *   3. Every `source` path referenced by the manifest exists on disk.
 *
 * Exits non-zero with a human-readable message on any failure.
 *
 * Run from the framework repo root:
 *   bun run scripts/validate-manifest.ts
 */

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = resolve(REPO_ROOT, "manifest.toml");

type ManifestEntry = {
  source: string;
  destination: string;
  executable: boolean;
};

type Manifest = {
  version: number;
  files: ManifestEntry[];
};

function fail(msg: string): never {
  console.error(`manifest: ${msg}`);
  process.exit(1);
}

async function loadManifest(): Promise<Manifest> {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`expected manifest at ${MANIFEST_PATH}`);
  }

  // Bun supports importing `.toml` files natively. We use the dynamic
  // import form so the error surface is a thrown TOML parse error rather
  // than a build-time crash.
  let raw: unknown;
  try {
    raw = (await import(MANIFEST_PATH, { with: { type: "toml" } })).default;
  } catch (err) {
    fail(
      `failed to parse ${MANIFEST_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (typeof raw !== "object" || raw === null) {
    fail("manifest root must be a table");
  }
  const root = raw as Record<string, unknown>;

  if (typeof root.version !== "number") {
    fail("manifest must declare a numeric `version`");
  }

  if (!Array.isArray(root.files)) {
    fail("manifest must declare a `files` array");
  }

  const files: ManifestEntry[] = root.files.map((entry, idx) => {
    if (typeof entry !== "object" || entry === null) {
      fail(`files[${idx}] must be a table`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.source !== "string" || e.source.length === 0) {
      fail(`files[${idx}].source must be a non-empty string`);
    }
    if (typeof e.destination !== "string" || e.destination.length === 0) {
      fail(`files[${idx}].destination must be a non-empty string`);
    }
    if (typeof e.executable !== "boolean") {
      fail(`files[${idx}].executable must be a boolean (got ${typeof e.executable})`);
    }
    return {
      source: e.source,
      destination: e.destination,
      executable: e.executable,
    };
  });

  return { version: root.version as number, files };
}

async function main(): Promise<void> {
  const manifest = await loadManifest();

  const missing: string[] = [];
  for (const entry of manifest.files) {
    const abs = resolve(REPO_ROOT, entry.source);
    if (!existsSync(abs)) {
      missing.push(entry.source);
      continue;
    }
    const st = statSync(abs);
    if (!st.isFile()) {
      fail(`source path is not a regular file: ${entry.source}`);
    }
  }

  if (missing.length > 0) {
    fail(
      `the following source paths do not exist:\n  - ${missing.join("\n  - ")}`,
    );
  }

  console.log(
    `manifest: ok (version ${manifest.version}, ${manifest.files.length} files)`,
  );
}

await main();
