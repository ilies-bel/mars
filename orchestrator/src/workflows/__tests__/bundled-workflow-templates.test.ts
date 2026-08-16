/**
 * Bundled workflow template compatibility guard.
 *
 * Loads every bundled `.js` workflow template through dryRunWorkflow — the
 * same engine-level primitive-validation path `mars workflow validate` uses —
 * so a primitives API change that breaks a template fails CI before shipping
 * to consumers.
 *
 * Root cause for the 2026-08-16 incident: `task-workflow.js`, `report-workflow.js`,
 * and `runbook-workflow.js` all passed `runAgent(ctx, { mode: 'auto' })`, but
 * `KNOWN_RUN_AGENT_KEYS` does not include `mode`. The templates were distributed
 * to consumers via `mars init`, breaking dispatch for every affected repo.
 * No test caught the drift before release.
 *
 * This suite catches that class of drift: every bundled template is validated
 * against the real primitives, and any unknown-key guard failure surfaces here
 * in CI rather than in a consumer's live dispatch.
 *
 * Implementation note: the templates import from `mars/workflow`, which the
 * `ensureResolveHook()` inside `importWorkflowFile` resolves to the orchestrator's
 * own `authoring.ts` barrel. The dry-run injects a `ValidateRecorder` into
 * services so all primitives return inert results — no real git, DB, or coder
 * calls happen during validation.
 */

import { describe, expect, it } from 'vitest'
import { planWorkflowCopies } from '../../init/scaffold-workflows'
import { importWorkflowFile } from '../queue-workflow-store'
import { dryRunWorkflow } from '../validate-workflow'

describe('bundled workflow templates — dryRunWorkflow compatibility', () => {
  // planWorkflowCopies uses its repoRoot argument only to build dest paths;
  // the src paths it returns are absolute paths into the bundled templates dir
  // and are independent of repoRoot. We only need src here.
  const copies = planWorkflowCopies('/tmp/placeholder-unused')

  for (const copy of copies) {
    const filename = copy.rel.split('/').pop()!
    const workflowName = filename.replace(/-workflow\.js$/, '')

    it(`${filename} loads and passes dryRunWorkflow without errors`, async () => {
      // importWorkflowFile calls ensureResolveHook() which maps
      // 'mars/workflow' → authoring.ts and '@mars/workflow' → the engine
      // index. Both are required for templates that import from 'mars/workflow'.
      const wf = await importWorkflowFile(workflowName, copy.src)

      const result = await dryRunWorkflow(wf as never, workflowName)

      // A non-empty errors array means the template either threw during
      // dry-run (e.g. runAgent: unknown option 'mode') or declared no steps.
      expect(result.errors).toEqual([])
      expect(result.steps.length).toBeGreaterThan(0)
    })
  }
})
