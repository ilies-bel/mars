---
id: eb6f8cc6-document-question-answer-lifecycle
status: draft
origin: user
---

# Remove the question/answer feature from the orchestrator

## Story

As a Mars maintainer, I want to remove the question/answer (blockers) feature
entirely, so that the orchestrator commits to a "plan fully up front, then run
autonomously" model without a half-built human-in-the-loop escape hatch
muddying the workflow.

**Acceptance**

- The `questions` table is dropped from `.mars/queue.db` (or the schema is
  removed and a migration handles existing rows).
- The `mars blockers <task-id>` CLI verb is removed; usage text no longer
  mentions blockers or questions.
- The triage / plan / implement workflows no longer read, write, or branch on
  question rows; tasks move through draft → queued → running purely on plan
  completeness.
- `QuestionInput`, `QuestionCategory`, and any related exports from
  `queue.ts` are removed.
- `npm run build` and the existing test suite pass after removal; tests that
  exercised the question pathway are deleted rather than skipped.

## Technical

Files to touch:

- `orchestrator/src/mastra/queue.ts` — drop the `questions` table DDL, the
  `QuestionInput` / `QuestionCategory` types, and the insert/delete helpers
  around lines 89–102, 306–307, 336.
- `orchestrator/src/cli.ts` — remove the `blockers` command (usage at lines
  119, 240–243; handler at line 1043+) and any `actionability + blockers`
  log lines (1007, 1034).
- `orchestrator/src/mastra/workflows/plan-workflow.ts` — strip question
  emission from the planner.
- `orchestrator/src/mastra/workflows/implement-workflow.ts` — strip any
  blocker gating.
- `orchestrator/src/mastra/daemon/server.ts` — remove question/blocker
  endpoints or polling.
- `orchestrator/src/mastra/lib/__tests__/queue-blockers.test.ts` — delete.
- `orchestrator/src/mastra/lib/__tests__/triage-workflow.test.ts` — drop
  blocker-related cases; keep the rest.

Sequencing:

1. Remove the CLI verb and workflow call sites (no schema dependency).
2. Remove the schema and types from `queue.ts`.
3. Delete / trim tests.
4. Run `npm run build` and the full test suite.

Migration note: existing `.mars/queue.db` files will keep an orphan
`questions` table after upgrade. That's acceptable — SQLite ignores unused
tables — but we should confirm no live code path still SELECTs from it.
