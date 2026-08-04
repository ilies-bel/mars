# Scaffolded workflows are user-owned; mars update never overwrites them, it offers a diff

## Status

Proposed (DDD restructure strategy). Carves out an exception to ADR-0004.

## Context

ADR-0004 established that `mars update` overwrites manifest-listed framework
files unconditionally — the right behaviour for files Mars owns. But ADR-0056
scaffolds the official workflows into `.mars/workflows/*.js` as plain JS the
**consumer is expected to edit** to author their own flows. Overwriting those on
update would clobber the user's customisations — exactly the failure mode the
glossary's "Hybrid file" / "Owned file" distinction exists to prevent.

## Decision

Scaffolded workflow files in `.mars/workflows/` are **user-owned** (a Hybrid
file: framework-seeded, consumer-edited). `mars update` **never silently
overwrites** them. When the shipped template for a workflow has changed, update:

- detects the file exists,
- shows a **diff** between the user's file and the new template,
- lets the user merge manually (or skip).

A fresh `mars init` still scaffolds the files (they don't exist yet, so there is
nothing to protect). Only `mars update` on an existing repo is governed by this
rule.

## Consequences

- Custom workflows survive framework upgrades; the upgrade path is a reviewed
  merge, not a clobber.
- This is a deliberate, scoped exception to ADR-0004 — it applies **only** to
  `.mars/workflows/*.js`, not to other manifest-owned framework files, which
  continue to overwrite unconditionally.
- The maintainer bundle-refresh flow (CLAUDE.md "Bundled templates") ships the
  updated workflow templates; the consumer-side merge is where ownership is
  respected.
- `mars workflow validate` should run as part of the merge guidance so a merged
  file is checked before the daemon loads it.
