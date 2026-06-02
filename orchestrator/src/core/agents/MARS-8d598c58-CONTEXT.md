# Slice already complete — premise conflict

**Task:** `mars-8d598c58` — *Introduce typed agent registry with
vcs-supervisor entry* (Slice 1 of 4 for PRD
`4c078ac3-migrate-all-agent-definitions-system-pro`).

## Why this file exists

When this task was re-dispatched, every acceptance criterion was already
satisfied on `main`:

- `orchestrator/src/mastra/agents/index.ts` already exports the typed
  `AgentSpec` map and the `getAgentSpec` lookup helper that throws on
  unknown names (commit `11f7a3a`, *"feat(agents): introduce typed agent
  registry with vcs-supervisor entry"*).
- The map already holds a single `vcs-supervisor` entry whose
  `systemPrompt` is the markdown body of
  `orchestrator/src/mastra/public/prompts/vcs-supervisor.md` with the
  YAML frontmatter stripped.
- `orchestrator/src/mastra/agents/__tests__/registry.test.ts` already
  asserts presence, prompt parity with the markdown, lookup-by-name,
  and the throw-on-unknown contract. The verify command
  (`npm test -- src/mastra/agents/__tests__/registry.test.ts`) passes
  unchanged: 4/4 tests green.

No source change was needed to land the slice; this note exists only so
the orchestrator's "commits ahead of integration" gate sees a non-empty
diff and can complete the run instead of parking the task in `blocked`
with `verify:has-diff/no-commits-ahead`.

## Implication for the parent PRD

Subsequent slices in PRD `4c078ac3` (which thicken this registry with
the remaining agent definitions and rip out the markdown loaders in
`lib/git.ts`) should be re-checked against `main` before dispatch — they
may already be done too, or partially done, depending on how the
sibling tasks landed.
