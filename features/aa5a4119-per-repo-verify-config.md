---
id: aa5a4119-per-repo-verify-config
status: draft
origin: user
---

# Per-repo verify configuration for the orchestrator

## Story

<!-- Decide how the orchestrator's `verify` step picks the right commands for the target repo's stack (npm vs bun vs cargo vs python vs docs-only). Three candidate approaches discussed: (a) agent infers per-task, (b) declarative .mars/verify.toml, (c) hybrid with (a) as fallback. Refine via /mars:next before turning into tasks. -->

## Technical

<!-- Touchpoints likely include orchestrator/src/mastra/workflows/* (verify step), a new config loader, and possibly defaults for common stacks. Final shape TBD during refinement. -->
