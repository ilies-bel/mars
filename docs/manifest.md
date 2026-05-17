# The install manifest (`manifest.json`)

`manifest.json` at the framework repo root is the single machine-readable
list of every file `mars install` lays down in a consumer repo. It is the
source of truth for the install verb (built in sibling slices of this PRD).

## Schema

```jsonc
{
  "schemaVersion": 1,        // bumped only on an incompatible shape change
  "owned":  ["<repo-relative path>", ...],
  "hybrid": ["<repo-relative path>", ...]
}
```

- **`schemaVersion`** — a number. A future installer reads this first and
  refuses rather than mis-applying a manifest it does not understand.
  `scripts/check-manifest.mjs` only accepts the version it was written for.
- **`owned[]`** — files `mars install` overwrites **unconditionally** on
  every run (ADR-0004). Framework-shipped assets the consumer must never
  hand-edit: skills, hooks, supervisor agents.
- **`hybrid[]`** — files `mars install` writes **only if absent**; if the
  file already exists it refuses with a back-up-and-remove message
  (ADR-0007). These are files a consumer is expected to customise, e.g.
  project-level `CLAUDE.md` and `.claude/settings.json`.

Paths are relative to the framework repo root and must point at real,
regular files. A path may not appear in both sections.

## Adding a file when you ship a new asset

When you add a new framework-shipped skill, hook, or agent (or any other
file `mars install` should place in a consumer):

1. Add the file's repo-root-relative path to **`owned[]`** if the
   framework controls it and overwrites are safe, or to **`hybrid[]`** if
   the consumer is expected to customise it (then it must *not* also be in
   `owned[]`).
2. Run the check:

   ```sh
   node scripts/check-manifest.mjs
   ```

   It fails loudly (non-zero exit, the offending path named) if any listed
   path no longer resolves, if the two sections overlap, or if the schema
   is malformed. This check is the verify gate, so forgetting to register
   an asset — or deleting/renaming a registered one without updating the
   manifest — breaks the build instead of silently shipping a broken
   `mars install`.

To change the manifest *shape* (not just its contents), bump
`schemaVersion`, update `SCHEMA_VERSION` in `scripts/check-manifest.mjs`,
and update this document.

## Tests

`scripts/check-manifest.test.mjs` exercises the checker through its
process boundary (valid manifest passes; a vanished path, an unknown
schema version, and an owned/hybrid overlap each fail loudly):

```sh
node scripts/check-manifest.test.mjs
```
