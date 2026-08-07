import { defineConfig } from 'vitest/config'

// -----------------------------------------------------------------------------
// Merge-gate reliability guardrail — mirrored from orchestrator/vitest.config.ts
//
// Mars runs many coder tasks in parallel, each doing a full `npm test`. Vitest
// otherwise sizes the forks pool to the host core count (~9 forks here).
// N parallel worktrees × that fan-out exhausts RAM and starves the host.
//
// Observed 2026-07-21 (orchestrator): repeated daemon deaths + orphaned fork
// storms at load ~200 — which is why orchestrator/vitest.config.ts pins
// maxForks=1. That bound was copied to ui/vitest.config.ts on 2026-08-07 after
// the same incident reproduced from the UI side (8 implement tasks, 111 vitest
// processes, load 210 on 10 cores, zero task completions in 15 minutes).
//
// This package has no config of its own; without one, vitest sizes the pool to
// core count by default, producing the same fork storm whenever the workflow
// engine tests run inside a parallel worktree gate.
//
// One fork per suite trades slower per-suite wall time for a bounded aggregate
// no matter how many suites run at once. Override on an idle machine via
// VITEST_MAX_FORKS. Do not remove without an ADR — and if you change it, change
// orchestrator/vitest.config.ts and ui/vitest.config.ts in the same commit so
// the three configs cannot drift apart again.
// -----------------------------------------------------------------------------

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: Number(process.env.VITEST_MAX_FORKS ?? 1),
        minForks: Number(process.env.VITEST_MIN_FORKS ?? 1),
      },
    },
  },
})
